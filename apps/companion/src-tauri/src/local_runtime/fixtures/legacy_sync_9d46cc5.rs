// Frozen enqueue/server-correction oracle from 9d46cc5.
use chrono::{DateTime,Utc};
use rusqlite::{Connection,Transaction,params,OptionalExtension};
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
