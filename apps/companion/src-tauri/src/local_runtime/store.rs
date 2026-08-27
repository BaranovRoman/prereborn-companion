use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::model::{LocalMatch, LocalMatchState, LocalSession, MatchResult, RankedMode, SyncState};

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<LocalSession> {
    Ok(LocalSession {
        local_id: row.get(0)?,
        backend_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        rating_start: row.get(4)?,
        rating_current: row.get(5)?,
        sync_state: SyncState::Pending,
    })
}

const SESSION_COLUMNS: &str =
    "local_id, backend_id, started_at, ended_at, rating_start, rating_current, sync_state";

/// Mirrors `getOrCreateActiveSession` (stream-session-service.ts): finds the
/// most recent session that hasn't ended, or creates a fresh one. WK-111
/// never itself ends a session (that's OBS-driven lifecycle, WK-112) - this
/// is purely "attach matches to *some* local session" bookkeeping.
pub fn ensure_active_session(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<LocalSession> {
    let existing = conn
        .query_row(
            &format!(
                "SELECT {SESSION_COLUMNS} FROM local_sessions WHERE ended_at IS NULL ORDER BY rowid DESC LIMIT 1"
            ),
            [],
            row_to_session,
        )
        .optional()?;
    if let Some(session) = existing {
        return Ok(session);
    }

    let local_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO local_sessions (local_id, started_at) VALUES (?1, ?2)",
        params![local_id, now.to_rfc3339()],
    )?;
    Ok(LocalSession {
        local_id,
        backend_id: None,
        started_at: now.to_rfc3339(),
        ended_at: None,
        rating_start: None,
        rating_current: None,
        sync_state: SyncState::Pending,
    })
}

const ACTIVE_MATCH_STATES: &[LocalMatchState] = &[
    LocalMatchState::InProgress,
    LocalMatchState::PostGamePending,
    LocalMatchState::Interrupted,
];

fn active_states_in_clause() -> String {
    ACTIVE_MATCH_STATES
        .iter()
        .map(|state| format!("'{}'", state.as_db_str()))
        .collect::<Vec<_>>()
        .join(",")
}

fn row_to_match(row: &rusqlite::Row) -> rusqlite::Result<LocalMatch> {
    let state_raw: String = row.get(11)?;
    let result_raw: Option<String> = row.get(7)?;
    let ranked_raw: String = row.get(8)?;
    Ok(LocalMatch {
        local_id: row.get(0)?,
        session_local_id: row.get(1)?,
        backend_id: row.get(2)?,
        match_id: row.get(3)?,
        match_key: row.get(4)?,
        hero_id: row.get(5)?,
        player_team: row.get(6)?,
        result: result_raw.and_then(|value| MatchResult::from_db_str(&value)),
        ranked_mode: RankedMode::from_db_str(&ranked_raw),
        rating_before: row.get(9)?,
        detected_rating_delta: row.get(10)?,
        state: LocalMatchState::from_db_str(&state_raw).expect("stored state is always valid"),
        rating_after: row.get(12)?,
        started_at: row.get(13)?,
        interrupted_at: row.get(14)?,
        finalized_at: row.get(15)?,
        sync_state: SyncState::Pending,
    })
}

const MATCH_COLUMNS: &str = "local_id, session_local_id, backend_id, match_id, match_key, hero_id, \
     player_team, result, ranked_mode, rating_before, detected_rating_delta, state, rating_after, \
     started_at, interrupted_at, finalized_at";

/// Mirrors `findActiveMatch` (stream-match-service.ts): the current match is
/// always re-derived from durable storage, never an in-memory tracker - so
/// a Companion restart mid-match loses nothing (see WK-111's crash/restart
/// acceptance criteria).
pub fn find_active_match(conn: &Connection, session_local_id: &str) -> rusqlite::Result<Option<LocalMatch>> {
    conn.query_row(
        &format!(
            "SELECT {MATCH_COLUMNS} FROM local_matches \
             WHERE session_local_id = ?1 AND state IN ({}) \
             ORDER BY rowid DESC LIMIT 1",
            active_states_in_clause()
        ),
        params![session_local_id],
        row_to_match,
    )
    .optional()
}

fn synthesized_match_key(session_local_id: &str, now: DateTime<Utc>, hero_id: i64) -> String {
    format!("session:{session_local_id}:{}:{hero_id}", now.timestamp_millis())
}

/// Mirrors `createMatch` - `INSERT ... ON CONFLICT DO NOTHING` on the same
/// (session, match_key) uniqueness the schema enforces, so a duplicate tick
/// racing this call can never create a second row for the same match.
pub fn create_match(
    conn: &Connection,
    session_local_id: &str,
    match_id: Option<&str>,
    hero_id: i64,
    player_team: &str,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let match_key = match match_id {
        Some(id) => format!("gsi:{id}"),
        None => synthesized_match_key(session_local_id, now, hero_id),
    };
    let local_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO local_matches \
            (local_id, session_local_id, match_id, match_key, hero_id, player_team, state, started_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'in_progress', ?7)",
        params![local_id, session_local_id, match_id, match_key, hero_id, player_team, now.to_rfc3339()],
    )?;
    Ok(())
}

/// Mirrors `resumeMatch`: reconnect/companion-restart to the same match -
/// `interrupted` rows return to `in_progress`, the observed `match_id`
/// (once known) and `hero_id` (a mutable observation, not an identity -
/// same reasoning as the backend) are refreshed to the latest tick.
pub fn resume_match(conn: &Connection, local_id: &str, match_id: Option<&str>, hero_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_matches \
         SET state = CASE WHEN state = 'interrupted' THEN 'in_progress' ELSE state END, \
             interrupted_at = NULL, \
             match_id = COALESCE(match_id, ?2), \
             hero_id = ?3 \
         WHERE local_id = ?1",
        params![local_id, match_id, hero_id],
    )?;
    Ok(())
}

/// Mirrors `markNeedsReview` - `state != 'finalized'` guard makes this
/// idempotent even if called twice against the same row.
pub fn mark_needs_review(conn: &Connection, local_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_matches SET state = 'needs_review', result = NULL WHERE local_id = ?1 AND state != 'finalized'",
        params![local_id],
    )?;
    Ok(())
}

/// Mirrors `markInterrupted`.
pub fn mark_interrupted(conn: &Connection, local_id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_matches SET state = 'interrupted', interrupted_at = ?2 WHERE local_id = ?1 AND state = 'in_progress'",
        params![local_id, now.to_rfc3339()],
    )?;
    Ok(())
}

/// Mirrors the `post_game_pending` transition in `markPostGame` - used both
/// for the very first POST_GAME tick (in_progress -> post_game_pending,
/// `result` possibly still None) and for recording the first real
/// observation on an already-pending match.
pub fn set_post_game(conn: &Connection, local_id: &str, result: Option<MatchResult>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_matches SET state = 'post_game_pending', result = ?2 WHERE local_id = ?1",
        params![local_id, result.map(MatchResult::as_db_str)],
    )?;
    Ok(())
}

const RATING_DEFAULT_STEP: i64 = 25;

/// Mirrors `finalizeMatch`'s rating arithmetic and session update, inside a
/// single transaction so a crash mid-finalize can never leave the match
/// finalized without its session's `rating_current` reflecting it (or vice
/// versa) - the crash-safety property WK-111's acceptance criteria call
/// for. `ranked_mode` is read from the match row as it already stood
/// (never re-resolved here) - same "fixed at match start, never revisited
/// at finalize" rule as `finalizeMatch`'s `is_ranked`/`mode_source`.
pub fn finalize_match(
    conn: &mut Connection,
    local_id: &str,
    session_local_id: &str,
    ranked_mode: RankedMode,
    result: MatchResult,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;

    let rating_current: Option<i64> = tx
        .query_row(
            "SELECT rating_current FROM local_sessions WHERE local_id = ?1",
            params![session_local_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    let is_ranked = matches!(ranked_mode, RankedMode::Ranked);
    let rating_delta = is_ranked.then_some(if matches!(result, MatchResult::Win) {
        RATING_DEFAULT_STEP
    } else {
        -RATING_DEFAULT_STEP
    });
    let rating_before = is_ranked.then_some(rating_current).flatten();
    let rating_after = match (rating_before, rating_delta) {
        (Some(before), Some(delta)) => Some(before + delta),
        _ => None,
    };

    tx.execute(
        "UPDATE local_matches \
         SET state = 'finalized', result = ?2, rating_before = ?3, detected_rating_delta = ?4, \
             rating_after = ?5, finalized_at = ?6 \
         WHERE local_id = ?1",
        params![
            local_id,
            result.as_db_str(),
            rating_before,
            rating_delta,
            rating_after,
            now.to_rfc3339(),
        ],
    )?;

    if rating_after.is_some() {
        tx.execute(
            "UPDATE local_sessions \
             SET rating_current = ?2, \
                 rating_start = COALESCE(rating_start, ?3) \
             WHERE local_id = ?1",
            params![session_local_id, rating_after, rating_before],
        )?;
    }

    tx.commit()
}

/// A one-line, plain-text summary for the rolling app log (see
/// `local_runtime::init`) - the "diagnostics/log helper, not a new user
/// screen" affordance called for in WK-111's scope, so the local mirror's
/// state is at least inspectable without building any UI around it.
pub fn log_summary(conn: &Connection) -> rusqlite::Result<String> {
    let session_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0))?;
    let active_match_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM local_matches WHERE state IN ({})", active_states_in_clause()),
        [],
        |row| row.get(0),
    )?;
    let finalized_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM local_matches WHERE state = '{}'", LocalMatchState::Finalized.as_db_str()),
        [],
        |row| row.get(0),
    )?;
    Ok(format!(
        "{session_count} session(s), {active_match_count} active match(es), {finalized_count} finalized match(es)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::schema;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn ensure_active_session_creates_once_then_reuses() {
        let conn = test_conn();
        let now = Utc::now();
        let first = ensure_active_session(&conn, now).unwrap();
        let second = ensure_active_session(&conn, now).unwrap();
        assert_eq!(first.local_id, second.local_id);
    }

    #[test]
    fn create_match_is_idempotent_on_the_same_match_id() {
        let conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("999"), 14, "radiant", now).unwrap();
        create_match(&conn, &session.local_id, Some("999"), 14, "radiant", now).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "duplicate GSI tick for the same match must not create a second row");
    }

    #[test]
    fn finalize_ranked_win_updates_session_rating() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&conn, now).unwrap();
        conn.execute(
            "UPDATE local_sessions SET rating_current = 6000 WHERE local_id = ?1",
            params![session.local_id],
        )
        .unwrap();
        create_match(&conn, &session.local_id, Some("1"), 14, "radiant", now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();

        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, now)
            .unwrap();

        let updated = find_active_match(&conn, &session.local_id).unwrap();
        assert!(updated.is_none(), "a finalized match is no longer active");
        let session_row: (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT rating_start, rating_current FROM local_sessions WHERE local_id = ?1",
                params![session.local_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(session_row, (Some(6000), Some(6025)));
    }

    #[test]
    fn finalize_with_unknown_ranked_mode_never_fabricates_a_rating() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("2"), 14, "radiant", now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();

        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Unknown, MatchResult::Win, now)
            .unwrap();

        let session_row: Option<i64> = conn
            .query_row(
                "SELECT rating_current FROM local_sessions WHERE local_id = ?1",
                params![session.local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_row, None, "unknown ranked mode must leave the session rating untouched, not default to 0/false");
    }
}
