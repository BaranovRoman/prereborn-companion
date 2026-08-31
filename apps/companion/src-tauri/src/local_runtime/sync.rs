// WK-113 - backend sync. This is the ONE module in local_runtime allowed to
// depend on both the local SQLite store AND backend HTTP transport (see
// docs/research/wk-110-local-first-audit.md and the WK-113 ticket's own
// "sync worker is the only layer allowed to depend on both" rule) - every
// other local_runtime module (detector, lifecycle, store's CRUD, model)
// stays backend-independent, pinned by their own
// match_transition_never_depends_on_backend_state/
// stream_lifecycle_never_depends_on_backend_state regression tests.
//
// Durable transactional outbox: `enqueue` below is called from WITHIN the
// same SQLite transaction that mutates a local_session/local_match row (see
// store.rs), so "the entity changed" and "a sync event was recorded for it"
// commit atomically - a crash between the two is impossible, not just
// unlikely. A background worker (`start_sync_worker`) drains the outbox
// independently; backend failure only ever affects how long a row waits
// here, never the local entity it describes.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::model::RankedMode;
use super::store;
use super::LocalRuntimeState;
use crate::state::{AppState, DEFAULT_BACKEND_URL};

const DRAIN_INTERVAL: StdDuration = StdDuration::from_secs(2);
const REQUEST_TIMEOUT: StdDuration = StdDuration::from_secs(5);
// Cadence is expressed in DRAIN_INTERVAL ticks, not their own timers - one
// background loop, not three independent ones.
const CORRECTIONS_PULL_EVERY_TICKS: u32 = 30; // ~60s
const GAME_MODE_REFRESH_EVERY_TICKS: u32 = 30; // ~60s
const PURGE_EVERY_TICKS: u32 = 1800; // ~1h
// Delivered/dead-lettered rows are kept this long for observability/
// debugging (bounded storage, per the ticket's explicit requirement) then
// swept - the outbox is not meant to grow forever.
const RETENTION: Duration = Duration::days(7);

fn parse_rfc3339(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn retry_delay(attempt: u32) -> Duration {
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

/// Enqueues one outbox row - called from WITHIN an already-open transaction
/// (see store.rs), so it shares that transaction's atomicity with whatever
/// entity mutation it accompanies. Deliberately takes no stance here on
/// whether the entity is pre- or post-cutover - eligibility is resolved once,
/// at drain time (see `is_eligible`), so this function (and every call site
/// in store.rs) never needs to know or care about the cutover boundary.
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

struct OutboxRow {
    id: String,
    entity_type: String,
    entity_local_id: String,
    event_type: String,
    payload: String,
    attempts: i64,
}

fn next_pending(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<Option<OutboxRow>> {
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
fn entity_started_at(conn: &Connection, entity_type: &str, entity_local_id: &str) -> rusqlite::Result<Option<DateTime<Utc>>> {
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

fn is_eligible(conn: &Connection, row: &OutboxRow, cutover_at: DateTime<Utc>) -> rusqlite::Result<bool> {
    match entity_started_at(conn, &row.entity_type, &row.entity_local_id)? {
        Some(started_at) => Ok(started_at >= cutover_at),
        None => Ok(false),
    }
}

/// Read-only outbox visibility for the Companion UI (WK-119 §5/§7 -
/// `sync_outbox` has existed since WK-113 with zero UI surface until now).
/// Deliberately excludes pre-cutover shadow rows dead-lettered by
/// `is_eligible` above from `failed_count` - those were never real sync
/// attempts (see `drain_outbox`'s "pre-cutover shadow data, never synced"
/// message) and would otherwise permanently show as a false "failed to
/// sync" warning on every install that upgraded through the WK-111/112
/// shadow-mirror stage.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutboxStatus {
    pub pending_count: i64,
    pub failed_count: i64,
    pub oldest_pending_at: Option<String>,
    pub last_error: Option<String>,
}

const SHADOW_DEAD_LETTER_ERROR: &str = "pre-cutover shadow data, never synced";

pub fn outbox_status(conn: &Connection) -> rusqlite::Result<SyncOutboxStatus> {
    let pending_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL",
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
    let failed_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE failed_at IS NOT NULL AND last_error IS NOT ?1",
        params![SHADOW_DEAD_LETTER_ERROR],
        |row| row.get(0),
    )?;
    let last_error: Option<String> = conn
        .query_row(
            "SELECT last_error FROM sync_outbox WHERE failed_at IS NOT NULL AND last_error IS NOT ?1 ORDER BY failed_at DESC LIMIT 1",
            params![SHADOW_DEAD_LETTER_ERROR],
            |row| row.get(0),
        )
        .optional()?;

    Ok(SyncOutboxStatus {
        pending_count,
        failed_count,
        oldest_pending_at,
        last_error,
    })
}

/// `AppHandle` wrapper for the Tauri command - mirrors `summary::get`'s
/// "inert if the local runtime failed to open" contract, returning the
/// default (empty) status rather than an error the UI would have to
/// special-case.
pub fn status(app: &AppHandle) -> SyncOutboxStatus {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else {
        return SyncOutboxStatus::default();
    };
    outbox_status(conn).unwrap_or_default()
}

fn mark_delivered(conn: &Connection, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute("UPDATE sync_outbox SET delivered_at = ?2 WHERE id = ?1", params![id, now.to_rfc3339()])?;
    Ok(())
}

fn mark_failed(conn: &Connection, id: &str, error: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_outbox SET failed_at = ?2, last_error = ?3 WHERE id = ?1",
        params![id, now.to_rfc3339(), error],
    )?;
    Ok(())
}

fn mark_retry(conn: &Connection, id: &str, error: &str, attempts: i64, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let next_attempt_at = now + retry_delay(attempts as u32);
    conn.execute(
        "UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?2, next_attempt_at = ?3 WHERE id = ?1",
        params![id, error, next_attempt_at.to_rfc3339()],
    )?;
    Ok(())
}

enum SendOutcome {
    Delivered,
    /// Permanent (4xx) - the sync worker must stop retrying this event, but
    /// must NOT stop draining the rest of the outbox because of it.
    Rejected(String),
    /// Transient (network error, timeout, 5xx) - must be retried, in order,
    /// before anything after it in the outbox is attempted.
    Retryable(String),
}

fn send_event(token: &str, event_id: &str, event_type: &str, payload_json: &str) -> SendOutcome {
    let payload: Value = match serde_json::from_str(payload_json) {
        Ok(value) => value,
        // A malformed stored payload can never become valid by retrying -
        // this is a local bug, not a network condition, so it's dead-lettered
        // immediately rather than retried forever.
        Err(error) => return SendOutcome::Rejected(format!("corrupt stored payload: {error}")),
    };
    let client = match reqwest::blocking::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return SendOutcome::Retryable(format!("HTTP client error: {error}")),
    };
    let body = serde_json::json!({ "eventId": event_id, "eventType": event_type, "payload": payload });
    let response = match client
        .post(format!("{DEFAULT_BACKEND_URL}/stream/companion/sync/events"))
        .bearer_auth(token)
        .json(&body)
        .send()
    {
        Ok(response) => response,
        Err(error) => return SendOutcome::Retryable(format!("network error: {error}")),
    };
    let status = response.status();
    if status.is_success() {
        SendOutcome::Delivered
    } else if status.is_client_error() {
        SendOutcome::Rejected(format!("backend rejected event: HTTP {status}"))
    } else {
        SendOutcome::Retryable(format!("backend error: HTTP {status}"))
    }
}

/// Drains the outbox strictly in insertion order, stopping the moment a
/// row needs a retry - this single rule is what makes delivery ordering
/// (session_started before that session's match_finalized events) trivial:
/// nothing after a not-yet-succeeded row is ever even attempted. Pre-cutover
/// shadow rows (see `is_eligible`) are the one case allowed to be skipped
/// without blocking anything newer - they can never succeed and were never
/// meant to sync at all (see the WK-113 migration/bootstrap boundary).
// WK-126 - `drain_outbox` used to return here with zero observability: a
// missing companion token (never configured, or cleared) meant every
// session/match sync event queued up forever with no log line anywhere
// explaining why - the exact "backend sees 0 matches, no diagnosis
// possible" symptom this ticket investigates. Logged once per token
// disappearing (reset back to `false` the moment a token IS present again,
// see below), never once per DRAIN_INTERVAL tick.
static NO_TOKEN_WARNED: AtomicBool = AtomicBool::new(false);

fn drain_outbox(app: &AppHandle) {
    let token = { app.state::<AppState>().0.lock().unwrap().companion_token.clone() };
    let Some(token) = token else {
        if !NO_TOKEN_WARNED.swap(true, Ordering::Relaxed) {
            crate::storage::append_rolling_log(
                app,
                "Sync: no companion token configured - local matches/sessions are being recorded but will not sync to the backend until one is set.",
            );
        }
        return;
    };
    NO_TOKEN_WARNED.store(false, Ordering::Relaxed);

    loop {
        let now = Utc::now();
        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let Some(conn) = guard.as_mut() else { return };

        let Ok(cutover) = cutover_at(conn) else { return };
        let row = match next_pending(conn, now) {
            Ok(row) => row,
            Err(error) => {
                crate::storage::append_rolling_log(app, &format!("Sync: next_pending failed ({error})"));
                return;
            }
        };
        let Some(row) = row else { return }; // nothing left to drain this tick

        match is_eligible(conn, &row, cutover) {
            Ok(true) => {}
            Ok(false) => {
                let _ = mark_failed(conn, &row.id, "pre-cutover shadow data, never synced", now);
                continue; // keep draining past it
            }
            Err(error) => {
                crate::storage::append_rolling_log(app, &format!("Sync: eligibility check failed ({error})"));
                return;
            }
        }

        drop(guard); // release the lock for the blocking HTTP call

        let outcome = send_event(&token, &row.id, &row.event_type, &row.payload);

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let Some(conn) = guard.as_mut() else { return };
        match outcome {
            SendOutcome::Delivered => {
                // WK-116 observability - "backend acknowledged" checkpoint,
                // correlated by entity so a match's whole journey (created ->
                // finalized -> synced) is traceable in app.log.
                crate::storage::append_rolling_log(
                    app,
                    &format!("Sync: {} for {}={} acknowledged by backend", row.event_type, row.entity_type, row.entity_local_id),
                );
                let _ = mark_delivered(conn, &row.id, Utc::now());
            }
            SendOutcome::Rejected(error) => {
                crate::storage::append_rolling_log(app, &format!("Sync: event {} dead-lettered ({error})", row.id));
                let _ = mark_failed(conn, &row.id, &error, Utc::now());
            }
            SendOutcome::Retryable(error) => {
                crate::storage::append_rolling_log(
                    app,
                    &format!("Sync: {} for {}={} retrying ({error})", row.event_type, row.entity_type, row.entity_local_id),
                );
                let _ = mark_retry(conn, &row.id, &error, row.attempts, Utc::now());
                return; // stop draining - preserves order, retries this same row next tick
            }
        }
    }
}

fn purge_delivered(app: &AppHandle) {
    let cutoff = (Utc::now() - RETENTION).to_rfc3339();
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return };
    let _ = conn.execute(
        "DELETE FROM sync_outbox WHERE (delivered_at IS NOT NULL AND delivered_at < ?1) OR (failed_at IS NOT NULL AND failed_at < ?1)",
        params![cutoff],
    );
}

fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
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

fn refresh_game_mode(app: &AppHandle) {
    let token = { app.state::<AppState>().0.lock().unwrap().companion_token.clone() };
    let Some(token) = token else { return };
    let client = match reqwest::blocking::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return,
    };
    let Ok(response) = client
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/account-settings"))
        .bearer_auth(token)
        .send()
    else {
        return; // best-effort - keep whatever was cached before
    };
    let Ok(json) = response.json::<Value>() else { return };
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return };
    if let Some(mode) = json.get("gameMode").and_then(Value::as_str) {
        if mode == "ranked" || mode == "unranked" { let _ = meta_set(conn, "cached_game_mode", mode); }
    }
    // Backend is only a bootstrap source. Once this device has an explicit
    // local value (or a live session), a stale account response must never
    // overwrite the streamer's correction.
    if store::find_open_session(conn).ok().flatten().is_none() && store::get_current_rating(conn).ok().flatten().is_none() {
        if let Some(rating) = json.get("currentMmr").and_then(Value::as_i64) {
            let _ = store::set_current_rating(conn, rating);
        }
    }
}

/// WK-113 §6 - the pull direction of MMR reconciliation: a match corrected
/// on the web dashboard after Companion already synced it needs to reach
/// back into the local copy. Deliberately conservative: only
/// `rating_delta_correction`/`rating_after` on the matching row and the
/// session's `rating_current` are updated - `detected_rating_delta` (what
/// Companion's own local detector originally decided) is NEVER touched, so
/// neither the local detected history nor the explicit web correction is
/// ever lost, mirroring WK-105's own detected-vs-correction split, now
/// applied to the pull direction too.
/// Applies one server-originated correction to the matching local row -
/// extracted from `pull_corrections` so this, the actual data-mutation
/// logic, is directly testable without mocking HTTP (see the tests module).
/// `detected_rating_delta` is deliberately never part of this UPDATE - see
/// this function's callers' doc comment (pull_corrections) and WK-105's own
/// detected-vs-correction split, now mirrored locally: the correction is
/// computed as a diff against whatever was originally detected, so the
/// original local detection is preserved forever, not overwritten.
fn apply_one_correction(
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

fn pull_corrections(app: &AppHandle) {
    let token = { app.state::<AppState>().0.lock().unwrap().companion_token.clone() };
    let Some(token) = token else { return };

    let since = {
        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let Some(conn) = guard.as_mut() else { return };
        meta_get(conn, "corrections_since").ok().flatten().unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
    };

    let client = match reqwest::blocking::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return,
    };
    let Ok(response) = client
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/sync/corrections"))
        .query(&[("since", since.as_str())])
        .bearer_auth(token)
        .send()
    else {
        return; // best-effort, try again next cycle
    };
    let Ok(json) = response.json::<Value>() else { return };
    let Some(corrections) = json.get("corrections").and_then(Value::as_array) else { return };
    if corrections.is_empty() {
        return;
    }

    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return };

    let mut latest_seen: Option<DateTime<Utc>> = None;
    for correction in corrections {
        let (Some(local_match_id), Some(rating_delta), Some(corrected_at_raw)) = (
            correction.get("localMatchId").and_then(Value::as_str),
            correction.get("ratingDelta").and_then(Value::as_i64),
            correction.get("correctedAt").and_then(Value::as_str),
        ) else {
            continue;
        };
        let rating_after = correction.get("ratingAfter").and_then(Value::as_i64);
        let session_rating = correction.get("sessionRating").and_then(Value::as_i64);
        let session_rating_adjustment = correction.get("sessionRatingAdjustment").and_then(Value::as_i64);
        let corrected_at = parse_rfc3339(corrected_at_raw);

        let _ = apply_one_correction(
            conn,
            local_match_id,
            rating_delta,
            rating_after,
            session_rating,
            session_rating_adjustment,
        );
        latest_seen = Some(latest_seen.map_or(corrected_at, |current| current.max(corrected_at)));
    }

    // Advance the cursor 1ms past the latest seen correction, not to it
    // exactly - the backend stores this timestamp with more precision than
    // an RFC3339-with-milliseconds round trip preserves, so an exact match
    // could re-fetch the same already-applied correction forever (see
    // apps/api's stream-sync-service.test.ts for the same reasoning on the
    // server side of this exact boundary).
    if let Some(latest) = latest_seen {
        let next_cursor = latest + Duration::milliseconds(1);
        let _ = meta_set(conn, "corrections_since", &next_cursor.to_rfc3339());
    }
}

/// Started once from lib.rs's setup(), alongside the other local_runtime/
/// obs background loops. A single tick counter drives three independent
/// cadences (drain every tick, corrections/game-mode/purge every N ticks)
/// rather than three separate timer threads.
pub fn start_sync_worker(app: AppHandle) {
    let tick = AtomicU32::new(0);
    std::thread::spawn(move || loop {
        std::thread::sleep(DRAIN_INTERVAL);
        drain_outbox(&app);
        let n = tick.fetch_add(1, Ordering::Relaxed) + 1;
        if n % CORRECTIONS_PULL_EVERY_TICKS == 0 {
            pull_corrections(&app);
        }
        if n % GAME_MODE_REFRESH_EVERY_TICKS == 0 {
            refresh_game_mode(&app);
        }
        if n % PURGE_EVERY_TICKS == 0 {
            purge_delivered(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::schema;
    use crate::local_runtime::store;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn cutover_at_is_set_once_and_stable_across_calls() {
        let conn = test_conn();
        let first = cutover_at(&conn).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = cutover_at(&conn).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn a_session_started_at_or_after_cutover_is_eligible() {
        let mut conn = test_conn();
        let cutover = cutover_at(&conn).unwrap();
        let now = cutover + Duration::seconds(1);
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        let row = OutboxRow {
            id: "x".into(),
            entity_type: "session".into(),
            entity_local_id: session.local_id.clone(),
            event_type: "session_started".into(),
            payload: "{}".into(),
            attempts: 0,
        };
        assert!(is_eligible(&conn, &row, cutover).unwrap());
    }

    #[test]
    fn a_shadow_session_started_before_cutover_is_never_eligible() {
        let mut conn = test_conn();
        // Simulate a pre-existing 0.5.34 shadow session: created, then the
        // cutover marker is (re)computed as if it were set AFTER that
        // session already existed - mirrors upgrading an existing install.
        let shadow_start = Utc::now() - Duration::hours(2);
        let session = store::ensure_active_session(&mut conn, shadow_start).unwrap();
        conn.execute("UPDATE sync_meta SET value = ?1 WHERE key = 'cutover_at'", params![Utc::now().to_rfc3339()])
            .or_else(|_| conn.execute("INSERT INTO sync_meta (key, value) VALUES ('cutover_at', ?1)", params![Utc::now().to_rfc3339()]))
            .unwrap();
        let cutover = cutover_at(&conn).unwrap();

        let row = OutboxRow {
            id: "x".into(),
            entity_type: "session".into(),
            entity_local_id: session.local_id.clone(),
            event_type: "session_started".into(),
            payload: "{}".into(),
            attempts: 0,
        };
        assert!(!is_eligible(&conn, &row, cutover).unwrap());

        // A match that itself started BEFORE cutover (e.g. one already
        // in-progress at the moment of the upgrade) is correctly still
        // shadow data on its own terms, independent of the session check
        // above.
        store::create_match(&conn, &session.local_id, Some("1"), 1, "radiant", RankedMode::Ranked, shadow_start).unwrap();
        let m = store::find_active_match(&conn, &session.local_id).unwrap().unwrap();
        store::finalize_match(
            &mut conn,
            &m.local_id,
            &session.local_id,
            RankedMode::Ranked,
            super::super::model::MatchResult::Win,
            "confirmed",
            shadow_start,
        )
        .unwrap();
        let match_row = OutboxRow {
            id: "y".into(),
            entity_type: "match".into(),
            entity_local_id: m.local_id,
            event_type: "match_finalized".into(),
            payload: "{}".into(),
            attempts: 0,
        };
        assert!(!is_eligible(&conn, &match_row, cutover).unwrap());
    }

    // WK-116 P0 regression test - the exact scenario a production streamer
    // hits: a session that started before cutover (e.g. it never properly
    // closed - see the companion OBS-watcher fix) stays open across the
    // upgrade and a real stream continues in it. A match played and
    // finalized AFTER cutover, inside that old session, must still sync -
    // it is genuinely new data, not pre-existing shadow data, even though
    // its parent session predates the boundary. Before this fix, eligibility
    // was (incorrectly) derived from the PARENT SESSION's started_at, which
    // permanently dead-lettered every future match in a session like this.
    #[test]
    fn a_match_created_after_cutover_inside_a_pre_cutover_session_is_still_eligible() {
        let mut conn = test_conn();
        let shadow_start = Utc::now() - Duration::hours(2);
        let session = store::ensure_active_session(&mut conn, shadow_start).unwrap();
        conn.execute("UPDATE sync_meta SET value = ?1 WHERE key = 'cutover_at'", params![Utc::now().to_rfc3339()])
            .or_else(|_| conn.execute("INSERT INTO sync_meta (key, value) VALUES ('cutover_at', ?1)", params![Utc::now().to_rfc3339()]))
            .unwrap();
        let cutover = cutover_at(&conn).unwrap();

        // The session itself is still (correctly) pre-cutover shadow data.
        let session_row = OutboxRow {
            id: "s".into(),
            entity_type: "session".into(),
            entity_local_id: session.local_id.clone(),
            event_type: "session_started".into(),
            payload: "{}".into(),
            attempts: 0,
        };
        assert!(!is_eligible(&conn, &session_row, cutover).unwrap());

        // A brand new match played well after cutover, in that same
        // never-closed session.
        let after_cutover = cutover + Duration::minutes(5);
        store::create_match(&conn, &session.local_id, Some("999"), 14, "radiant", RankedMode::Ranked, after_cutover).unwrap();
        let m = store::find_active_match(&conn, &session.local_id).unwrap().unwrap();
        store::finalize_match(
            &mut conn,
            &m.local_id,
            &session.local_id,
            RankedMode::Ranked,
            super::super::model::MatchResult::Win,
            "confirmed",
            after_cutover,
        )
        .unwrap();
        let match_row = OutboxRow {
            id: "m".into(),
            entity_type: "match".into(),
            entity_local_id: m.local_id,
            event_type: "match_finalized".into(),
            payload: "{}".into(),
            attempts: 0,
        };
        assert!(
            is_eligible(&conn, &match_row, cutover).unwrap(),
            "a match created after cutover must sync even if its parent session predates cutover"
        );
    }

    #[test]
    fn enqueue_and_next_pending_round_trip_in_fifo_order() {
        let conn = test_conn();
        let now = Utc::now();
        {
            let tx = conn.unchecked_transaction().unwrap();
            enqueue(&tx, "session", "s1", "session_started", &serde_json::json!({"a": 1}), now).unwrap();
            enqueue(&tx, "match", "m1", "match_finalized", &serde_json::json!({"b": 2}), now).unwrap();
            tx.commit().unwrap();
        }
        let first = next_pending(&conn, now).unwrap().unwrap();
        assert_eq!(first.entity_local_id, "s1");
        mark_delivered(&conn, &first.id, now).unwrap();
        let second = next_pending(&conn, now).unwrap().unwrap();
        assert_eq!(second.entity_local_id, "m1");
    }

    #[test]
    fn a_retryable_failure_schedules_a_future_next_attempt_and_keeps_the_row_pending() {
        let conn = test_conn();
        let now = Utc::now();
        let tx = conn.unchecked_transaction().unwrap();
        enqueue(&tx, "session", "s1", "session_started", &serde_json::json!({}), now).unwrap();
        tx.commit().unwrap();

        let row = next_pending(&conn, now).unwrap().unwrap();
        mark_retry(&conn, &row.id, "network error", row.attempts, now).unwrap();

        // Not immediately retried...
        assert!(next_pending(&conn, now).unwrap().is_none());
        // ...but is again once its backoff window has passed.
        let later = now + Duration::seconds(10);
        assert!(next_pending(&conn, later).unwrap().is_some());
    }

    #[test]
    fn a_rejected_event_is_dead_lettered_and_never_retried_again() {
        let conn = test_conn();
        let now = Utc::now();
        let tx = conn.unchecked_transaction().unwrap();
        enqueue(&tx, "session", "s1", "session_started", &serde_json::json!({}), now).unwrap();
        tx.commit().unwrap();

        let row = next_pending(&conn, now).unwrap().unwrap();
        mark_failed(&conn, &row.id, "422 invalid", now).unwrap();

        let far_future = now + Duration::days(365);
        assert!(next_pending(&conn, far_future).unwrap().is_none());
    }

    #[test]
    fn purge_removes_only_old_terminal_rows() {
        let conn = test_conn();
        let old = Utc::now() - Duration::days(10);
        let recent = Utc::now() - Duration::hours(1);
        {
            let tx = conn.unchecked_transaction().unwrap();
            enqueue(&tx, "session", "old", "session_started", &serde_json::json!({}), old).unwrap();
            enqueue(&tx, "session", "recent", "session_started", &serde_json::json!({}), recent).unwrap();
            tx.commit().unwrap();
        }
        let old_row = conn
            .query_row("SELECT id FROM sync_outbox WHERE entity_local_id = 'old'", [], |r| r.get::<_, String>(0))
            .unwrap();
        let recent_row = conn
            .query_row("SELECT id FROM sync_outbox WHERE entity_local_id = 'recent'", [], |r| r.get::<_, String>(0))
            .unwrap();
        mark_delivered(&conn, &old_row, old).unwrap();
        mark_delivered(&conn, &recent_row, recent).unwrap();

        let cutoff = (Utc::now() - RETENTION).to_rfc3339();
        conn.execute(
            "DELETE FROM sync_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?1",
            params![cutoff],
        )
        .unwrap();

        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 1);
        let remaining_id: String = conn.query_row("SELECT entity_local_id FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining_id, "recent");
    }

    #[test]
    fn cached_ranked_mode_is_unknown_until_ever_set() {
        let conn = test_conn();
        assert_eq!(cached_ranked_mode(&conn), RankedMode::Unknown);
        meta_set(&conn, "cached_game_mode", "ranked").unwrap();
        assert_eq!(cached_ranked_mode(&conn), RankedMode::Ranked);
    }

    // WK-113 failure matrix #18: an absolute web correction must never
    // overwrite what the local detector originally decided.
    #[test]
    fn apply_one_correction_never_touches_detected_rating_delta() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        conn.execute("UPDATE local_sessions SET rating_current = 6000 WHERE local_id = ?1", params![session.local_id]).unwrap();
        store::create_match(&conn, &session.local_id, Some("1"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let m = store::find_active_match(&conn, &session.local_id).unwrap().unwrap();
        store::finalize_match(&mut conn, &m.local_id, &session.local_id, RankedMode::Ranked, super::super::model::MatchResult::Win, "confirmed", now).unwrap();

        let before: Option<i64> = conn
            .query_row("SELECT detected_rating_delta FROM local_matches WHERE local_id = ?1", params![m.local_id], |row| row.get(0))
            .unwrap();
        assert_eq!(before, Some(25));

        // Web dashboard corrected this match's delta from +25 to +26.
        apply_one_correction(&conn, &m.local_id, 26, Some(6026), Some(6026), Some(0)).unwrap();

        let (detected, correction, rating_after): (Option<i64>, i64, Option<i64>) = conn
            .query_row(
                "SELECT detected_rating_delta, rating_delta_correction, rating_after FROM local_matches WHERE local_id = ?1",
                params![m.local_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(detected, Some(25), "the original local detection must never be overwritten by a correction");
        assert_eq!(correction, 1);
        assert_eq!(rating_after, Some(6026));
    }

    // WK-113 failure matrix #17: a match played locally AFTER a web
    // correction was pulled must anchor its ratingBefore on the corrected
    // number, not a stale pre-correction one - mirrors WK-105's own "Set
    // Current MMR correctly reflects the match's ratingBefore for the NEXT
    // real match" guarantee, now honored locally too.
    #[test]
    fn a_correction_updates_session_rating_so_the_next_local_match_anchors_on_it() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        conn.execute("UPDATE local_sessions SET rating_current = 6000 WHERE local_id = ?1", params![session.local_id]).unwrap();
        store::create_match(&conn, &session.local_id, Some("1"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let m1 = store::find_active_match(&conn, &session.local_id).unwrap().unwrap();
        store::finalize_match(&mut conn, &m1.local_id, &session.local_id, RankedMode::Ranked, super::super::model::MatchResult::Win, "confirmed", now).unwrap();
        // session.rating_current is now 6025.

        // Streamer syncs with the in-game client via the web dashboard mid-stream.
        apply_one_correction(&conn, &m1.local_id, 25, Some(6040), Some(6040), Some(15)).unwrap();
        let pulled_adjustment: i64 = conn
            .query_row(
                "SELECT rating_adjustment FROM local_sessions WHERE local_id = ?1",
                params![session.local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pulled_adjustment, 15, "the server's session-level correction ledger must stay authoritative on pull");

        store::create_match(&conn, &session.local_id, Some("2"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let m2 = store::find_active_match(&conn, &session.local_id).unwrap().unwrap();
        store::finalize_match(&mut conn, &m2.local_id, &session.local_id, RankedMode::Ranked, super::super::model::MatchResult::Win, "confirmed", now).unwrap();

        let (rating_before, rating_after): (Option<i64>, Option<i64>) = conn
            .query_row("SELECT rating_before, rating_after FROM local_matches WHERE local_id = ?1", params![m2.local_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(rating_before, Some(6040));
        assert_eq!(rating_after, Some(6065));
    }

    // WK-113 failure matrix #5: an entire stream (session start, several
    // matches, session end) played with the sync worker never once invoked
    // - proving the local runtime alone is sufficient for a real stream, and
    // that every mutation left a durable outbox trail ready to sync once
    // backend does become reachable.
    #[test]
    fn a_full_stream_with_multiple_matches_works_end_to_end_with_zero_network_involvement() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();

        for (match_id, result) in [("1", super::super::model::MatchResult::Win), ("2", super::super::model::MatchResult::Loss), ("3", super::super::model::MatchResult::Win)] {
            store::create_match(&conn, &session.local_id, Some(match_id), 14, "radiant", RankedMode::Ranked, now).unwrap();
            let active = store::find_active_match(&conn, &session.local_id).unwrap().unwrap();
            store::finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, result, "confirmed", now).unwrap();
        }
        store::finalize_session_end(&mut conn, &session.local_id, now).unwrap();

        let finalized_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches WHERE state = 'finalized'", [], |row| row.get(0)).unwrap();
        assert_eq!(finalized_count, 3);
        assert!(store::find_open_session(&conn).unwrap().is_none(), "session must be ended");

        // Every mutation left a durable, still-pending outbox trail (never
        // drained, since the sync worker was never started in this test) -
        // 1 session_started + 3 match_finalized + 1 session_ended.
        let pending_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending_count, 5);
    }

    // WK-113 failure matrix #7/#8: a crash with a still-pending outbox, then
    // restart - the queue must survive intact (not lost, not duplicated) so
    // the next drain cycle picks up exactly where it left off.
    #[test]
    fn pending_outbox_rows_survive_a_crash_and_restart() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("local-runtime.sqlite3");
        let now = Utc::now();
        {
            let mut conn = Connection::open(&path).unwrap();
            schema::migrate(&conn).unwrap();
            store::ensure_active_session(&mut conn, now).unwrap();
            // Dropped here without any explicit flush - WAL mode is what
            // makes this safe, same guarantee WK-111's crash tests rely on.
        }

        let conn = Connection::open(&path).unwrap();
        schema::migrate(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let pending = next_pending(&conn, now).unwrap();
        assert!(pending.is_some(), "the pending event must still be there, ready to drain, after a restart");
    }

    // WK-113 §12 - the same architectural guarantee as
    // match_transition_never_depends_on_backend_state/
    // stream_lifecycle_never_depends_on_backend_state, extended to the
    // outbox layer itself: nothing that decides local session/match state
    // (store.rs's CRUD, detector.rs, lifecycle.rs) can accept a backend/HTTP
    // client type - only sync.rs's own worker functions (drain_outbox,
    // pull_corrections, refresh_game_mode - all `fn(&AppHandle)`, never
    // exposed to store/detector/lifecycle) are allowed to. `enqueue` itself
    // takes only a `Transaction` (local SQLite) and plain data.
    // WK-119 - the UI's "healthy" state (nothing shown) depends on this
    // returning all-zero for a fresh outbox.
    #[test]
    fn outbox_status_on_an_empty_outbox_is_all_zero() {
        let conn = test_conn();
        let status = outbox_status(&conn).unwrap();
        assert_eq!(status, SyncOutboxStatus::default());
    }

    #[test]
    fn outbox_status_counts_pending_rows_and_reports_the_oldest() {
        let conn = test_conn();
        let earlier = Utc::now() - Duration::minutes(5);
        let later = Utc::now();
        {
            let tx = conn.unchecked_transaction().unwrap();
            enqueue(&tx, "session", "s1", "session_started", &serde_json::json!({}), earlier).unwrap();
            enqueue(&tx, "match", "m1", "match_finalized", &serde_json::json!({}), later).unwrap();
            tx.commit().unwrap();
        }
        let status = outbox_status(&conn).unwrap();
        assert_eq!(status.pending_count, 2);
        assert_eq!(status.failed_count, 0);
        assert_eq!(status.oldest_pending_at.as_deref(), Some(earlier.to_rfc3339().as_str()));
    }

    #[test]
    fn outbox_status_counts_a_real_dead_letter_and_surfaces_its_error() {
        let conn = test_conn();
        let now = Utc::now();
        let tx = conn.unchecked_transaction().unwrap();
        enqueue(&tx, "session", "s1", "session_started", &serde_json::json!({}), now).unwrap();
        tx.commit().unwrap();
        let row = next_pending(&conn, now).unwrap().unwrap();
        mark_failed(&conn, &row.id, "422 invalid payload", now).unwrap();

        let status = outbox_status(&conn).unwrap();
        assert_eq!(status.pending_count, 0);
        assert_eq!(status.failed_count, 1);
        assert_eq!(status.last_error.as_deref(), Some("422 invalid payload"));
    }

    // WK-119 - a shadow-mirror row dead-lettered purely for predating cutover
    // (see `drain_outbox`'s "pre-cutover shadow data, never synced" branch)
    // must never surface as a sync FAILURE to the user - it was never a real
    // sync attempt, and every install that upgraded through WK-111/112's
    // shadow-mirror stage has at least one of these.
    #[test]
    fn outbox_status_excludes_pre_cutover_shadow_dead_letters_from_failed_count() {
        let conn = test_conn();
        let now = Utc::now();
        let tx = conn.unchecked_transaction().unwrap();
        enqueue(&tx, "session", "shadow", "session_started", &serde_json::json!({}), now).unwrap();
        tx.commit().unwrap();
        let row = next_pending(&conn, now).unwrap().unwrap();
        mark_failed(&conn, &row.id, SHADOW_DEAD_LETTER_ERROR, now).unwrap();

        let status = outbox_status(&conn).unwrap();
        assert_eq!(status.pending_count, 0);
        assert_eq!(status.failed_count, 0, "a pre-cutover shadow dead-letter must not count as a real sync failure");
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn outbox_enqueue_never_depends_on_backend_state() {
        fn _type_check(tx: &Transaction, entity_type: &str, entity_local_id: &str, event_type: &str, payload: &Value, now: DateTime<Utc>) -> rusqlite::Result<()> {
            enqueue(tx, entity_type, entity_local_id, event_type, payload, now)
        }
        fn _apply_correction_type_check(conn: &Connection, local_match_id: &str, rating_delta: i64, rating_after: Option<i64>, session_rating: Option<i64>) -> rusqlite::Result<()> {
            apply_one_correction(conn, local_match_id, rating_delta, rating_after, session_rating, None)
        }
        let conn = test_conn();
        assert!(next_pending(&conn, Utc::now()).unwrap().is_none());
    }
}
