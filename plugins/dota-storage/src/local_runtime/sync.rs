//! SQLite-only outbox operations; transport stays outside this module.
use chrono::{DateTime,Duration,Utc};
use rusqlite::{params,Connection,OptionalExtension,Transaction};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;
use super::model::RankedMode;

pub fn enqueue(
    tx: &Transaction,
    entity_type: &str,
    entity_local_id: &str,
    event_type: &str,
    payload: &Value,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO sync_outbox (id, entity_type, entity_local_id, event_type, payload, created_at, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, entity_type, entity_local_id, event_type, payload.to_string(), now.to_rfc3339()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutboxStatus {
    pub pending_count: i64,
    pub retrying_count: i64,
    pub unknown_delivery_count:i64,
    pub failed_count: i64,
    pub oldest_pending_at: Option<String>,
    pub last_delivered_at: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

pub const SHADOW_DEAD_LETTER_ERROR: &str = "pre-cutover shadow data, never synced";

pub fn outbox_status(conn: &Connection) -> rusqlite::Result<SyncOutboxStatus> {
    let unknown_delivery_count:i64=conn.query_row("SELECT count(*) FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND (last_error LIKE 'delivery Unknown%' OR last_error LIKE 'backend result Unknown%' OR last_error LIKE 'network error:%')",[],|row|row.get(0))?;
    let pending_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    let retrying_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND attempts > 0",
        [],
        |row| row.get(0),
    )?;
    let oldest_pending_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL ORDER BY rowid ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let last_delivered_at: Option<String> = conn
        .query_row(
            "SELECT delivered_at FROM sync_outbox WHERE delivered_at IS NOT NULL ORDER BY delivered_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let failed_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE failed_at IS NOT NULL AND last_error IS NOT ?1",
        params![SHADOW_DEAD_LETTER_ERROR],
        |row| row.get(0),
    )?;
    let last_error_row: Option<(String, String)> = conn
        .query_row(
            "SELECT last_error, failed_at FROM sync_outbox WHERE failed_at IS NOT NULL AND last_error IS NOT ?1 ORDER BY failed_at DESC LIMIT 1",
            params![SHADOW_DEAD_LETTER_ERROR],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (last_error, last_error_at) = match last_error_row {
        Some((error, at)) => (Some(error), Some(at)),
        None => (None, None),
    };

    Ok(SyncOutboxStatus {
        pending_count,
        retrying_count,
        unknown_delivery_count,
        failed_count,
        oldest_pending_at,
        last_delivered_at,
        last_error,
        last_error_at,
    })
}


pub fn apply_one_correction(
    conn: &Connection,
    local_match_id: &str,
    rating_delta: i64,
    rating_after: Option<i64>,
    session_rating: Option<i64>,
    session_rating_adjustment: Option<i64>,
) -> rusqlite::Result<()> {
    let detected: Option<i64> = conn
        .query_row("SELECT detected_rating_delta FROM local_matches WHERE local_id = ?1", params![local_match_id], |row| row.get(0))
        .optional()?
        .flatten();
    let correction_amount = rating_delta - detected.unwrap_or(0);

    conn.execute(
        "UPDATE local_matches SET rating_delta_correction = ?2, rating_after = ?3 WHERE local_id = ?1",
        params![local_match_id, correction_amount, rating_after],
    )?;
    if let Some(session_rating) = session_rating {
        conn.execute(
            "UPDATE local_sessions
             SET rating_current = ?2,
                 rating_adjustment = COALESCE(?3, rating_adjustment)
             WHERE local_id = (SELECT session_local_id FROM local_matches WHERE local_id = ?1)",
            params![local_match_id, session_rating, session_rating_adjustment],
        )?;
    }
    Ok(())
}

// Canonical former Companion sync SQL; transport and credentials stay outside.
pub fn parse_rfc3339(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

pub fn retry_delay(attempt: u32) -> Duration {
    Duration::seconds(2_i64.saturating_pow(attempt.min(6)) .min(60))
}

/// The moment local-first sync became active on this install - either the
/// moment of a fresh install, or the exact moment an existing 0.5.33/0.5.34
/// shadow-mode install upgraded to this version. Read-or-initialize: the
/// FIRST call ever made (across the lifetime of this SQLite file) fixes the
/// value permanently; every later call just reads it back unchanged. This
/// is the migration/bootstrap boundary the WK-113 ticket requires - see
/// `is_eligible` below for how it's used.
pub fn cutover_at(conn: &Connection) -> rusqlite::Result<DateTime<Utc>> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('cutover_at', ?1)",
        params![Utc::now().to_rfc3339()],
    )?;
    let value: String = conn.query_row("SELECT value FROM sync_meta WHERE key = 'cutover_at'", [], |row| row.get(0))?;
    Ok(parse_rfc3339(&value))
}

#[derive(Clone,Debug,serde::Serialize)]
pub struct OutboxRow {
    pub id: String,
    pub entity_type: String,
    pub entity_local_id: String,
    pub event_type: String,
    pub payload: String,
    pub attempts: i64,
}

pub fn next_pending(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<Option<OutboxRow>> {
    conn.query_row(
        "SELECT id, entity_type, entity_local_id, event_type, payload, attempts
         FROM sync_outbox
         WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?1
         ORDER BY rowid ASC LIMIT 1",
        params![now.to_rfc3339()],
        |row| {
            Ok(OutboxRow {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_local_id: row.get(2)?,
                event_type: row.get(3)?,
                payload: row.get(4)?,
                attempts: row.get(5)?,
            })
        },
    )
    .optional()
}

/// The timestamp a given outbox row's own entity is judged against for
/// cutover eligibility - for a `session` row, the session's own
/// `started_at` (a session that predates cutover is genuinely pre-existing
/// shadow data - see this migration boundary's WK-113 doc comment); for a
/// `match` row, the MATCH's OWN `started_at`, never its parent session's.
///
/// WK-116 P0 FIX - this used to look up the PARENT SESSION's `started_at`
/// for match rows too. A session that began before cutover but stays open
/// across the upgrade (e.g. a long-running stream, or - see the OBS-watcher
/// fix above - one that never properly closed) would then permanently
/// dead-letter EVERY future match played in it, even ones created long
/// after cutover, since the session's own `started_at` never changes.
/// Matches are real, independent entities with their own creation time -
/// eligibility must be judged on that, not on whichever session happened to
/// still be open when they were played. The backend's `applyMatchFinalized`
/// already tolerates a match whose session was never synced (records it
/// with `stream_session_id = NULL` rather than rejecting it - see
/// apps/api's stream-sync-service.ts), so this is not just correct locally,
/// it's exactly what the existing backend contract expects.
/// `None` if the entity can no longer be found locally (should not happen -
/// rows are never deleted - but treated as "ineligible" rather than
/// panicking if it ever does).
pub fn entity_started_at(conn: &Connection, entity_type: &str, entity_local_id: &str) -> rusqlite::Result<Option<DateTime<Utc>>> {
    let raw: Option<String> = match entity_type {
        "session" => conn
            .query_row("SELECT started_at FROM local_sessions WHERE local_id = ?1", params![entity_local_id], |row| row.get(0))
            .optional()?,
        "match" => conn
            .query_row("SELECT started_at FROM local_matches WHERE local_id = ?1", params![entity_local_id], |row| row.get(0))
            .optional()?,
        _ => None,
    };
    Ok(raw.map(|value| parse_rfc3339(&value)))
}

pub fn is_eligible(conn: &Connection, row: &OutboxRow, cutover_at: DateTime<Utc>) -> rusqlite::Result<bool> {
    match entity_started_at(conn, &row.entity_type, &row.entity_local_id)? {
        Some(started_at) => Ok(started_at >= cutover_at),
        None => Ok(false),
    }
}

pub fn mark_delivered(conn: &Connection, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute("UPDATE sync_outbox SET delivered_at = ?2 WHERE id = ?1", params![id, now.to_rfc3339()])?;
    Ok(())
}

pub fn mark_failed(conn: &Connection, id: &str, error: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_outbox SET failed_at = ?2, last_error = ?3 WHERE id = ?1",
        params![id, now.to_rfc3339(), error],
    )?;
    Ok(())
}

pub fn mark_retry(conn: &Connection, id: &str, error: &str, attempts: i64, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let next_attempt_at = now + retry_delay(attempts as u32);
    conn.execute(
        "UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?2, next_attempt_at = ?3 WHERE id = ?1",
        params![id, error, next_attempt_at.to_rfc3339()],
    )?;
    Ok(())
}

/// Persist uncertainty before network IO. This does not count a successful
/// delivery, advance the FIFO head or replace its server idempotency UUID.
pub fn mark_sending(conn:&Connection,id:&str,attempts:i64,now:DateTime<Utc>)->rusqlite::Result<()> {
    conn.execute("UPDATE sync_outbox SET last_error='delivery Unknown; event UUID retained',next_attempt_at=?3 WHERE id=?1 AND attempts=?2 AND delivered_at IS NULL AND failed_at IS NULL",params![id,attempts,(now+retry_delay(attempts as u32)).to_rfc3339()])?;Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Companion's locally-cached copy of the account's ranked/unranked toggle
/// (see `refresh_game_mode` below) - `Unknown` until the first successful
/// fetch ever completes, exactly as long as that takes; never a fabricated
/// default. Read by store::create_match at the moment a new LocalMatch is
/// created.
pub fn cached_ranked_mode(conn: &Connection) -> RankedMode {
    match meta_get(conn, "cached_game_mode") {
        Ok(Some(value)) => RankedMode::from_db_str(&value),
        _ => RankedMode::Unknown,
    }
}
