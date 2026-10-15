//! SQLite-only outbox operations; transport stays outside this module.
use chrono::{DateTime,Utc};
use rusqlite::{params,Connection,OptionalExtension,Transaction};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

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
    pub failed_count: i64,
    pub oldest_pending_at: Option<String>,
    pub last_delivered_at: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

pub const SHADOW_DEAD_LETTER_ERROR: &str = "pre-cutover shadow data, never synced";

pub fn outbox_status(conn: &Connection) -> rusqlite::Result<SyncOutboxStatus> {
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

/// Same cached mode read used by the legacy detector; no network access.
pub fn cached_ranked_mode(conn:&Connection)->super::model::RankedMode {
    match conn.query_row("SELECT value FROM sync_meta WHERE key = ?1",["cached_game_mode"],|r|r.get::<_,String>(0)) {
        Ok(value)=>super::model::RankedMode::from_db_str(&value),Err(_)=>super::model::RankedMode::Unknown,
    }
}
