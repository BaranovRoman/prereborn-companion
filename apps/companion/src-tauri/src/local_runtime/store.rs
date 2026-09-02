use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::model::{LocalMatch, LocalMatchState, LocalSession, MatchResult, RankedMode, SyncState};

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<LocalSession> {
    let stale_ack: i64 = row.get(8)?;
    Ok(LocalSession {
        local_id: row.get(0)?,
        backend_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        rating_start: row.get(4)?,
        rating_current: row.get(5)?,
        rating_adjustment: row.get(6)?,
        pending_end_at: row.get(7)?,
        stale_ack: stale_ack != 0,
        sync_state: SyncState::Pending,
    })
}

const SESSION_COLUMNS: &str = "local_id, backend_id, started_at, ended_at, rating_start, \
     rating_current, rating_adjustment, pending_end_at, stale_ack";

/// Mirrors `getOrCreateActiveSession`'s *read* half (stream-session-service.ts):
/// the most recent session that hasn't ended, or `None`. Read-only - does
/// not create anything, unlike `ensure_active_session` below, so lifecycle
/// reconciliation (which must decide WHETHER to create one) can inspect
/// current state without side effects.
pub fn find_open_session(conn: &Connection) -> rusqlite::Result<Option<LocalSession>> {
    conn.query_row(
        &format!("SELECT {SESSION_COLUMNS} FROM local_sessions WHERE ended_at IS NULL ORDER BY rowid DESC LIMIT 1"),
        [],
        row_to_session,
    )
    .optional()
}

const CURRENT_RATING_KEY: &str = "current_rating";

pub fn get_current_rating(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT value FROM sync_meta WHERE key = ?1",
        params![CURRENT_RATING_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .map(|value| value.parse::<i64>().map_err(|_| rusqlite::Error::InvalidQuery))
    .transpose()
}

fn persist_current_rating(conn: &Connection, rating: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![CURRENT_RATING_KEY, rating.to_string()],
    )?;
    Ok(())
}

/// Mirrors `getOrCreateActiveSession` (stream-session-service.ts): finds the
/// most recent session that hasn't ended, or creates a fresh one. The ONLY
/// place a new LocalSession is created (see local_runtime::mod.rs's
/// handle_gsi, which used to also call this on any GSI tick - removed in
/// WK-113 so creation always durably enqueues a sync event, see below).
pub fn ensure_active_session(conn: &mut Connection, now: DateTime<Utc>) -> rusqlite::Result<LocalSession> {
    if let Some(session) = find_open_session(conn)? {
        return Ok(session);
    }

    // WK-113 - MMR carry-over, mirroring the backend's own
    // resetActiveSession (stream-session-service.ts): a brand new local
    // session's starting rating is the last session's known rating_current,
    // not null - the account's last-known MMR doesn't reset just because a
    // new stream (OBS Start Streaming) began. Genuinely null only for this
    // device's very first session ever.
    let previous_session_rating: Option<i64> = conn
        .query_row("SELECT rating_current FROM local_sessions ORDER BY rowid DESC LIMIT 1", [], |row| row.get(0))
        .optional()?
        .flatten();
    let carried_rating = get_current_rating(conn)?.or(previous_session_rating);

    let local_id = Uuid::new_v4().to_string();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO local_sessions (local_id, started_at, rating_start, rating_current) VALUES (?1, ?2, ?3, ?3)",
        params![local_id, now.to_rfc3339(), carried_rating],
    )?;
    // WK-113 - durable outbox entry, in the SAME transaction as the insert
    // above - see local_runtime::sync's doc comment for why this atomicity
    // is the whole point.
    let payload = serde_json::json!({
        "localSessionId": local_id,
        "startedAt": now.to_rfc3339(),
        "ratingStart": carried_rating,
    });
    super::sync::enqueue(&tx, "session", &local_id, "session_started", &payload, now)?;
    tx.commit()?;

    Ok(LocalSession {
        local_id,
        backend_id: None,
        started_at: now.to_rfc3339(),
        ended_at: None,
        rating_start: carried_rating,
        rating_current: carried_rating,
        rating_adjustment: 0,
        pending_end_at: None,
        stale_ack: false,
        sync_state: SyncState::Pending,
    })
}

/// Applies an absolute correction to the open session's Current MMR.
///
/// The first known value establishes both the session baseline and current
/// value. Later corrections change only `rating_current` and accumulate the
/// difference in `rating_adjustment`; finalized match rows are deliberately
/// untouched. This is the local-first form of WK-105's existing
/// session-adjustment semantics, not a second rating model.
pub fn set_current_rating(conn: &mut Connection, rating: i64) -> rusqlite::Result<Option<LocalSession>> {
    let tx = conn.transaction()?;
    if let Some(session) = find_open_session(&tx)? {
        tx.execute(
            "UPDATE local_sessions \
             SET rating_adjustment = rating_adjustment + \
                     CASE WHEN rating_current IS NULL THEN 0 ELSE ?2 - rating_current END, \
                 rating_start = COALESCE(rating_start, ?2), \
                 rating_current = ?2 \
             WHERE local_id = ?1 AND ended_at IS NULL",
            params![session.local_id, rating],
        )?;
    }
    persist_current_rating(&tx, rating)?;
    tx.commit()?;
    find_open_session(conn)
}

/// WK-112 - OBS reported "not streaming" for an open session with no
/// pending-end yet: start the 30s grace countdown, durably.
pub fn begin_pending_end(conn: &Connection, local_id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_sessions SET pending_end_at = ?2 WHERE local_id = ?1 AND ended_at IS NULL",
        params![local_id, now.to_rfc3339()],
    )?;
    Ok(())
}

/// WK-112 - OBS reported "streaming" again before the grace period elapsed.
pub fn cancel_pending_end(conn: &Connection, local_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_sessions SET pending_end_at = NULL WHERE local_id = ?1",
        params![local_id],
    )?;
    Ok(())
}

/// WK-112 - grace period elapsed with OBS confirmed not-streaming, or a
/// manual stale-recovery "end" action. `ended_at IS NULL` guard makes this
/// idempotent against a repeated call for the same session - including for
/// WK-113's outbox enqueue below, which only fires on the write that
/// actually changed something (`changed > 0`), never on a no-op repeat.
pub fn finalize_session_end(conn: &mut Connection, local_id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE local_sessions SET ended_at = ?2, pending_end_at = NULL WHERE local_id = ?1 AND ended_at IS NULL",
        params![local_id, now.to_rfc3339()],
    )?;
    if changed > 0 {
        let payload = serde_json::json!({ "localSessionId": local_id, "endedAt": now.to_rfc3339() });
        super::sync::enqueue(&tx, "session", local_id, "session_ended", &payload, now)?;
    }
    tx.commit()
}

/// WK-112 - manual stale-recovery "continue this session" action.
pub fn acknowledge_stale(conn: &Connection, local_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_sessions SET stale_ack = 1 WHERE local_id = ?1",
        params![local_id],
    )?;
    Ok(())
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
    let ranked_detected_raw: String = row.get(20)?;
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
        ranked_mode_detected: RankedMode::from_db_str(&ranked_detected_raw),
        rating_before: row.get(9)?,
        detected_rating_delta: row.get(10)?,
        rating_delta_correction: row.get(21)?,
        state: LocalMatchState::from_db_str(&state_raw).expect("stored state is always valid"),
        rating_after: row.get(12)?,
        kills: row.get(13)?,
        deaths: row.get(14)?,
        assists: row.get(15)?,
        inventory: serde_json::from_str::<Vec<Option<String>>>(&row.get::<_, String>(16)?)
            .unwrap_or_default()
            .into_iter()
            .take(9)
            .collect(),
        started_at: row.get(17)?,
        interrupted_at: row.get(18)?,
        finalized_at: row.get(19)?,
        sync_state: SyncState::Pending,
    })
}

const MATCH_COLUMNS: &str = "local_id, session_local_id, backend_id, match_id, match_key, hero_id, \
     player_team, result, ranked_mode, rating_before, detected_rating_delta, state, rating_after, \
     kills, deaths, assists, inventory, started_at, interrupted_at, finalized_at, \
     ranked_mode_detected, rating_delta_correction";

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

pub fn find_match(conn: &Connection, local_id: &str) -> rusqlite::Result<Option<LocalMatch>> {
    conn.query_row(
        &format!("SELECT {MATCH_COLUMNS} FROM local_matches WHERE local_id = ?1"),
        params![local_id],
        row_to_match,
    )
    .optional()
}

/// WK-114 - powers the Home page's "recent matches" list. Ordered newest
/// first, including the currently in-progress match if any (the caller
/// distinguishes by `state`) - mirrors `find_active_match`'s "always
/// re-derive from durable storage" approach rather than an in-memory cache.
#[allow(dead_code)]
pub fn list_recent_matches(conn: &Connection, session_local_id: &str, limit: i64) -> rusqlite::Result<Vec<LocalMatch>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MATCH_COLUMNS} FROM local_matches WHERE session_local_id = ?1 ORDER BY rowid DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![session_local_id, limit], row_to_match)?;
    rows.collect()
}

/// Device-wide finalized history for Home and Between Matches. Session W/L
/// remains scoped separately by `session_match_tally`; restarting Companion
/// or starting a new stream must not hide durable completed matches.
pub fn list_recent_finalized_matches(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<LocalMatch>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MATCH_COLUMNS} FROM local_matches WHERE state = 'finalized' ORDER BY rowid DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map(params![limit], row_to_match)?;
    rows.collect()
}

pub fn update_match_telemetry(
    conn: &Connection,
    local_id: &str,
    telemetry: &super::gsi::MatchTelemetry,
) -> rusqlite::Result<()> {
    let inventory = if telemetry.inventory.iter().any(Option::is_some) {
        serde_json::to_string(&telemetry.inventory).unwrap_or_else(|_| "[]".to_string())
    } else {
        "[]".to_string()
    };
    conn.execute(
        "UPDATE local_matches SET \
             kills = COALESCE(?2, kills), deaths = COALESCE(?3, deaths), assists = COALESCE(?4, assists), \
             inventory = CASE WHEN ?5 = '[]' THEN inventory ELSE ?5 END \
         WHERE local_id = ?1 AND state != 'finalized'",
        params![local_id, telemetry.kills, telemetry.deaths, telemetry.assists, inventory],
    )?;
    Ok(())
}

/// WK-114 - session-wide win/loss tally for the Home page, counted directly
/// in SQL rather than derived from `list_recent_matches`'s bounded result so
/// the count stays correct regardless of the recent-matches display limit.
pub fn session_match_tally(conn: &Connection, session_local_id: &str) -> rusqlite::Result<(i64, i64)> {
    let wins: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_matches WHERE session_local_id = ?1 AND result = 'win'",
        params![session_local_id],
        |row| row.get(0),
    )?;
    let losses: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_matches WHERE session_local_id = ?1 AND result = 'loss'",
        params![session_local_id],
        |row| row.get(0),
    )?;
    Ok((wins, losses))
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
    ranked_mode: RankedMode,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let match_key = match match_id {
        Some(id) => format!("gsi:{id}"),
        None => synthesized_match_key(session_local_id, now, hero_id),
    };
    let local_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO local_matches \
            (local_id, session_local_id, match_id, match_key, hero_id, player_team, ranked_mode, \
             ranked_mode_detected, state, started_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'in_progress', ?8)",
        params![
            local_id,
            session_local_id,
            match_id,
            match_key,
            hero_id,
            player_team,
            ranked_mode.as_db_str(),
            now.to_rfc3339()
        ],
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
    confidence: &str,
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

    // WK-113 - needed only to build the sync outbox payload below (match_id/
    // hero_id/started_at aren't otherwise touched by this function).
    let (match_id, hero_id, started_at, kills, deaths, assists, inventory): (Option<String>, i64, String, Option<i64>, Option<i64>, Option<i64>, String) = tx.query_row(
        "SELECT match_id, hero_id, started_at, kills, deaths, assists, inventory FROM local_matches WHERE local_id = ?1",
        params![local_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    )?;

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

    // WK-113 self-review addition - defense in depth against a double
    // finalize (structurally shouldn't happen: detector.rs only reaches a
    // Finalize* decision for a row `find_active_match` returned, and a
    // finalized row immediately drops out of that active-states filter -
    // but this guard, plus gating the session update/outbox enqueue below
    // on `changed > 0`, makes a hypothetical second call a safe no-op
    // instead of double-crediting the session or double-enqueueing a sync
    // event, mirroring finalizeMatch's own `WHERE finalized_at IS NULL`
    // guard on the backend.
    let changed = tx.execute(
        "UPDATE local_matches \
         SET state = 'finalized', result = ?2, rating_before = ?3, detected_rating_delta = ?4, \
             rating_after = ?5, finalized_at = ?6 \
         WHERE local_id = ?1 AND state != 'finalized'",
        params![
            local_id,
            result.as_db_str(),
            rating_before,
            rating_delta,
            rating_after,
            now.to_rfc3339(),
        ],
    )?;
    if changed == 0 {
        return tx.commit();
    }

    if rating_after.is_some() {
        tx.execute(
            "UPDATE local_sessions \
             SET rating_current = ?2, \
                 rating_start = COALESCE(rating_start, ?3) \
             WHERE local_id = ?1",
            params![session_local_id, rating_after, rating_before],
        )?;
        persist_current_rating(&tx, rating_after.expect("checked above"))?;
    }

    // WK-113 - the match's fully-resolved outcome, durably queued in the
    // SAME transaction as the finalize above (see local_runtime::sync's doc
    // comment for why this atomicity is the whole point of the outbox
    // pattern). `isRanked` is `null` (not `false`) when ranked_mode is
    // Unknown - the backend must never read "unranked" out of "we never
    // found out" (see model::RankedMode's own doc comment).
    let is_ranked_field: Option<bool> = match ranked_mode {
        RankedMode::Ranked => Some(true),
        RankedMode::Unranked => Some(false),
        RankedMode::Unknown => None,
    };
    let payload = serde_json::json!({
        "localSessionId": session_local_id,
        "localMatchId": local_id,
        "matchId": match_id,
        "heroId": hero_id,
        "kills": kills,
        "deaths": deaths,
        "assists": assists,
        "inventory": serde_json::from_str::<serde_json::Value>(&inventory).unwrap_or_else(|_| serde_json::json!([])),
        "result": result.as_db_str(),
        "isRanked": is_ranked_field,
        "ratingBefore": rating_before,
        "detectedRatingDelta": rating_delta,
        "ratingAfter": rating_after,
        "confidence": confidence,
        "startedAt": started_at,
        "finalizedAt": now.to_rfc3339(),
    });
    super::sync::enqueue(&tx, "match", local_id, "match_finalized", &payload, now)?;

    tx.commit()
}

/// WK-115 - recomputes `rating_before`/`rating_after` for every finalized
/// match in a session, in play order, from the session's fixed
/// `rating_start` anchor, then updates the session's `rating_current` (and
/// the durable device-wide current-rating snapshot, but only when this is
/// the currently open session - see below) to match. This is the local
/// equivalent of the backend's tail-walk cascade in
/// `stream-match-correction-service.ts`'s `correctStreamMatch`, except it
/// recomputes the whole session chain from scratch each time rather than
/// patching only the tail after one edited row - simpler to reason about
/// and test, and cheap at the match-per-stream-session scale Companion
/// deals with.
///
/// A match whose `ranked_mode` is not `Ranked` (Unranked, or Unknown with
/// no detected delta) does not contribute and does not break the chain:
/// the running total carries through it unchanged, and its own
/// `rating_before`/`rating_after` are cleared - mirrors the backend's
/// "null out rating_* on unranked tail rows".
///
/// Deliberately scoped to ONE session: correcting a match in an
/// already-ended session reanchors that session's own chain correctly, but
/// does not propagate into `rating_start`/`rating_current` of sessions
/// created after it (those were fixed at creation time from that session's
/// pre-correction `rating_current` - see `ensure_active_session`'s carried
/// rating). Propagating further would mean recomputing every later
/// session's own match chain too, recursively - a larger migration than
/// this pass covers; see docs/research for the follow-up note. The
/// `ended_at IS NULL` guard below is what keeps a correction against an old
/// session from clobbering the live device-wide current-rating snapshot
/// with a stale value.
fn reanchor_session(tx: &rusqlite::Transaction, session_local_id: &str) -> rusqlite::Result<()> {
    let (rating_start, rating_adjustment, is_open): (Option<i64>, i64, bool) = tx.query_row(
        "SELECT rating_start, rating_adjustment, ended_at IS NULL FROM local_sessions WHERE local_id = ?1",
        params![session_local_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let mut stmt = tx.prepare(
        "SELECT local_id, ranked_mode, detected_rating_delta, rating_delta_correction \
         FROM local_matches WHERE session_local_id = ?1 AND state = 'finalized' ORDER BY rowid ASC",
    )?;
    let rows: Vec<(String, String, Option<i64>, i64)> = stmt
        .query_map(params![session_local_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut running = rating_start;
    for (match_local_id, ranked_raw, detected, correction) in rows {
        let contributes = matches!(RankedMode::from_db_str(&ranked_raw), RankedMode::Ranked) && detected.is_some();
        if contributes {
            let effective = detected.expect("checked above") + correction;
            let before = running;
            let after = running.map(|value| value + effective);
            tx.execute(
                "UPDATE local_matches SET rating_before = ?2, rating_after = ?3 WHERE local_id = ?1",
                params![match_local_id, before, after],
            )?;
            running = after;
        } else {
            tx.execute(
                "UPDATE local_matches SET rating_before = NULL, rating_after = NULL WHERE local_id = ?1",
                params![match_local_id],
            )?;
        }
    }

    let rating_current = running.map(|value| value + rating_adjustment);
    tx.execute(
        "UPDATE local_sessions SET rating_current = ?2 WHERE local_id = ?1",
        params![session_local_id, rating_current],
    )?;
    if is_open {
        if let Some(rating_current) = rating_current {
            persist_current_rating(tx, rating_current)?;
        }
    }
    Ok(())
}

/// WK-115 - applies a manual absolute *effective* delta correction to a
/// single finalized ranked match (the Dashboard's "+25 -> ×2 -> +50"
/// control). Never touches `detected_rating_delta` - the immutable observed
/// value - only `rating_delta_correction`, the diff layered on top (same
/// invariant as the backend's `correctStreamMatch`). `effective_delta =
/// None` clears any existing correction, reverting the match to its
/// detected delta. No-op (returns the match unchanged) for a match that
/// isn't a finalized ranked match with a detected delta - there is nothing
/// to correct. Reanchors the session afterward - see `reanchor_session`.
pub fn correct_match_delta(
    conn: &mut Connection,
    local_id: &str,
    effective_delta: Option<i64>,
) -> rusqlite::Result<Option<LocalMatch>> {
    let tx = conn.transaction()?;
    let row: Option<(String, String, Option<i64>)> = tx
        .query_row(
            "SELECT session_local_id, ranked_mode, detected_rating_delta FROM local_matches \
             WHERE local_id = ?1 AND state = 'finalized'",
            params![local_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((session_local_id, ranked_raw, detected)) = row else {
        tx.commit()?;
        return Ok(None);
    };
    let Some(detected) = detected.filter(|_| matches!(RankedMode::from_db_str(&ranked_raw), RankedMode::Ranked)) else {
        tx.commit()?;
        return find_match(conn, local_id);
    };

    let correction = effective_delta.map(|value| value - detected).unwrap_or(0);
    tx.execute(
        "UPDATE local_matches SET rating_delta_correction = ?2 WHERE local_id = ?1",
        params![local_id, correction],
    )?;
    reanchor_session(&tx, &session_local_id)?;
    tx.commit()?;
    find_match(conn, local_id)
}

/// WK-115 - corrects a finalized match's ranked/unranked classification
/// after the fact (the Dashboard's Ranked -> Unranked action and its
/// reverse), for the case GSI/the account's ranked-mode setting
/// mis-classified a specific match. Never touches `ranked_mode_detected` -
/// the immutable observed classification - only the authoritative
/// `ranked_mode` column, mirroring `detected_rating_delta`/
/// `rating_delta_correction`'s "observed vs corrected" split.
/// `target = None` clears the override, restoring `ranked_mode_detected`
/// verbatim (so an Unranked correction on a match that was actually
/// detected as Unranked reverts to Unranked, never a hardcoded Ranked).
/// Reanchors the session afterward: an Unranked match stops contributing
/// (its own rating_before/after clear, later matches anchor straight
/// through it); a match restored to Ranked resumes contributing its stored
/// detected delta + whatever delta correction it already had.
pub fn correct_match_ranked_mode(
    conn: &mut Connection,
    local_id: &str,
    target: Option<RankedMode>,
) -> rusqlite::Result<Option<LocalMatch>> {
    let tx = conn.transaction()?;
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT session_local_id, ranked_mode_detected FROM local_matches \
             WHERE local_id = ?1 AND state = 'finalized'",
            params![local_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((session_local_id, detected_raw)) = row else {
        tx.commit()?;
        return Ok(None);
    };
    let resolved = target.unwrap_or_else(|| RankedMode::from_db_str(&detected_raw));
    tx.execute(
        "UPDATE local_matches SET ranked_mode = ?2 WHERE local_id = ?1",
        params![local_id, resolved.as_db_str()],
    )?;
    reanchor_session(&tx, &session_local_id)?;
    tx.commit()?;
    find_match(conn, local_id)
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
        let mut conn = test_conn();
        let now = Utc::now();
        let first = ensure_active_session(&mut conn, now).unwrap();
        let second = ensure_active_session(&mut conn, now).unwrap();
        assert_eq!(first.local_id, second.local_id);
    }

    #[test]
    fn ensure_active_session_carries_the_previous_sessions_rating_forward() {
        let mut conn = test_conn();
        let now = Utc::now();
        let first = ensure_active_session(&mut conn, now).unwrap();
        conn.execute("UPDATE local_sessions SET rating_current = 6050 WHERE local_id = ?1", params![first.local_id])
            .unwrap();
        finalize_session_end(&mut conn, &first.local_id, now).unwrap();

        let second = ensure_active_session(&mut conn, now + chrono::Duration::seconds(1)).unwrap();
        assert_eq!(second.rating_start, Some(6050));
        assert_eq!(second.rating_current, Some(6050));
    }

    #[test]
    fn ensure_active_session_enqueues_exactly_one_outbox_event_on_creation() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        ensure_active_session(&mut conn, now).unwrap(); // reuse - must not enqueue again

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_outbox WHERE entity_local_id = ?1 AND event_type = 'session_started'",
                params![session.local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn find_open_session_does_not_create_one() {
        let conn = test_conn();
        assert!(find_open_session(&conn).unwrap().is_none());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn begin_then_cancel_pending_end_round_trips() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        begin_pending_end(&conn, &session.local_id, now).unwrap();
        let pending = find_open_session(&conn).unwrap().unwrap();
        assert_eq!(pending.pending_end_at, Some(now.to_rfc3339()));

        cancel_pending_end(&conn, &session.local_id).unwrap();
        let cancelled = find_open_session(&conn).unwrap().unwrap();
        assert_eq!(cancelled.pending_end_at, None);
    }

    #[test]
    fn finalize_session_end_is_idempotent_and_clears_pending_end() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        begin_pending_end(&conn, &session.local_id, now).unwrap();

        finalize_session_end(&mut conn, &session.local_id, now).unwrap();
        assert!(find_open_session(&conn).unwrap().is_none(), "ended session must no longer be open");

        // Idempotent: a second finalize call (e.g. a repeated sweep tick)
        // against an already-ended session must not error or touch anything.
        finalize_session_end(&mut conn, &session.local_id, now).unwrap();

        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_outbox WHERE entity_local_id = ?1 AND event_type = 'session_ended'",
                params![session.local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(outbox_count, 1, "a repeated no-op end must not enqueue a second session_ended event");
    }

    #[test]
    fn acknowledge_stale_persists_across_a_reread() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        assert!(!find_open_session(&conn).unwrap().unwrap().stale_ack);

        acknowledge_stale(&conn, &session.local_id).unwrap();
        assert!(find_open_session(&conn).unwrap().unwrap().stale_ack);
    }

    #[test]
    fn create_match_is_idempotent_on_the_same_match_id() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("999"), 14, "radiant", RankedMode::Unknown, now).unwrap();
        create_match(&conn, &session.local_id, Some("999"), 14, "radiant", RankedMode::Unknown, now).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "duplicate GSI tick for the same match must not create a second row");
    }

    #[test]
    fn create_match_persists_the_ranked_mode_it_was_given() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("42"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();
        assert_eq!(active.ranked_mode, RankedMode::Ranked);
    }

    #[test]
    fn finalize_ranked_win_updates_session_rating() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        conn.execute(
            "UPDATE local_sessions SET rating_current = 6000 WHERE local_id = ?1",
            params![session.local_id],
        )
        .unwrap();
        create_match(&conn, &session.local_id, Some("1"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();

        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now)
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
    fn first_current_rating_value_establishes_the_session_baseline() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        assert_eq!(session.rating_current, None);

        let updated = set_current_rating(&mut conn, 4_500).unwrap().unwrap();
        assert_eq!(updated.rating_start, Some(4_500));
        assert_eq!(updated.rating_current, Some(4_500));
        assert_eq!(updated.rating_adjustment, 0);
    }

    #[test]
    fn current_rating_correction_preserves_historical_match_deltas() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        create_match(&conn, &session.local_id, Some("correction-history"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();
        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();

        let before: (Option<i64>, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT rating_before, detected_rating_delta, rating_after FROM local_matches WHERE local_id = ?1",
                params![active.local_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        let corrected = set_current_rating(&mut conn, 6_100).unwrap().unwrap();
        let after: (Option<i64>, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT rating_before, detected_rating_delta, rating_after FROM local_matches WHERE local_id = ?1",
                params![active.local_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(before, (Some(6_000), Some(25), Some(6_025)));
        assert_eq!(after, before, "an absolute Current MMR correction must not rewrite finalized match history");
        assert_eq!(corrected.rating_start, Some(6_000));
        assert_eq!(corrected.rating_current, Some(6_100));
        assert_eq!(corrected.rating_adjustment, 75);
        assert_eq!(corrected.rating_current.unwrap() - corrected.rating_start.unwrap() - corrected.rating_adjustment, 25);
    }

    #[test]
    fn idle_current_rating_is_snapshotted_by_the_next_session() {
        let mut conn = test_conn();
        assert!(set_current_rating(&mut conn, 5_750).unwrap().is_none());
        assert_eq!(get_current_rating(&conn).unwrap(), Some(5_750));

        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        assert_eq!(session.rating_start, Some(5_750));
        assert_eq!(session.rating_current, Some(5_750));
        assert_eq!(session.rating_adjustment, 0);
    }

    #[test]
    fn finalize_match_enqueues_exactly_one_outbox_event() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("77"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();
        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now)
            .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_outbox WHERE entity_local_id = ?1 AND event_type = 'match_finalized'",
                params![active.local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn calling_finalize_match_twice_never_double_credits_the_session_or_the_outbox() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        conn.execute("UPDATE local_sessions SET rating_current = 6000 WHERE local_id = ?1", params![session.local_id]).unwrap();
        create_match(&conn, &session.local_id, Some("88"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();

        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();
        // Hypothetical second call against the same already-finalized row.
        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();

        let rating: Option<i64> = conn
            .query_row("SELECT rating_current FROM local_sessions WHERE local_id = ?1", params![session.local_id], |row| row.get(0))
            .unwrap();
        assert_eq!(rating, Some(6025), "a second finalize call must not add +25 again");

        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_outbox WHERE entity_local_id = ?1 AND event_type = 'match_finalized'",
                params![active.local_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(outbox_count, 1, "a second finalize call must not enqueue a second sync event");
    }

    #[test]
    fn finalize_with_unknown_ranked_mode_never_fabricates_a_rating() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("2"), 14, "radiant", RankedMode::Unknown, now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();

        finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Unknown, MatchResult::Win, "confirmed", now)
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

    #[test]
    fn list_recent_matches_is_newest_first_and_includes_the_active_match() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("1"), 1, "radiant", RankedMode::Ranked, now).unwrap();
        let first_active_id = find_active_match(&conn, &session.local_id).unwrap().unwrap().local_id;
        finalize_match(&mut conn, &first_active_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();
        create_match(&conn, &session.local_id, Some("2"), 2, "radiant", RankedMode::Ranked, now).unwrap();

        let recent = list_recent_matches(&conn, &session.local_id, 10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].match_id.as_deref(), Some("2"), "newest (still in progress) match must come first");
        assert_eq!(recent[0].state, LocalMatchState::InProgress);
        assert_eq!(recent[1].match_id.as_deref(), Some("1"));
        assert_eq!(recent[1].state, LocalMatchState::Finalized);
    }

    #[test]
    fn list_recent_matches_respects_the_limit() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        for match_id in ["1", "2", "3"] {
            create_match(&conn, &session.local_id, Some(match_id), 1, "radiant", RankedMode::Ranked, now).unwrap();
            let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();
            finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();
        }

        let recent = list_recent_matches(&conn, &session.local_id, 2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].match_id.as_deref(), Some("3"));
        assert_eq!(recent[1].match_id.as_deref(), Some("2"));
    }

    #[test]
    fn session_match_tally_counts_wins_and_losses_only() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &session.local_id, Some("1"), 1, "radiant", RankedMode::Ranked, now).unwrap();
        let first_active_id = find_active_match(&conn, &session.local_id).unwrap().unwrap().local_id;
        finalize_match(&mut conn, &first_active_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();
        create_match(&conn, &session.local_id, Some("2"), 2, "radiant", RankedMode::Ranked, now).unwrap();
        let second_active_id = find_active_match(&conn, &session.local_id).unwrap().unwrap().local_id;
        finalize_match(&mut conn, &second_active_id, &session.local_id, RankedMode::Ranked, MatchResult::Loss, "confirmed", now).unwrap();
        create_match(&conn, &session.local_id, Some("3"), 3, "radiant", RankedMode::Ranked, now).unwrap();
        // Match 3 stays in progress (no result yet) - must not be counted either way.

        let (wins, losses) = session_match_tally(&conn, &session.local_id).unwrap();
        assert_eq!((wins, losses), (1, 1));
    }

    #[test]
    fn recent_finalized_history_survives_a_new_session_boundary() {
        let mut conn = test_conn();
        let now = Utc::now();
        let first = ensure_active_session(&mut conn, now).unwrap();
        create_match(&conn, &first.local_id, Some("historic"), 14, "radiant", RankedMode::Ranked, now).unwrap();
        let active = find_active_match(&conn, &first.local_id).unwrap().unwrap();
        finalize_match(&mut conn, &active.local_id, &first.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();
        finalize_session_end(&mut conn, &first.local_id, now).unwrap();
        let second = ensure_active_session(&mut conn, now + chrono::Duration::minutes(1)).unwrap();

        assert!(list_recent_matches(&conn, &second.local_id, 10).unwrap().is_empty());
        let global = list_recent_finalized_matches(&conn, 10).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].match_id.as_deref(), Some("historic"));
        assert_eq!(session_match_tally(&conn, &second.local_id).unwrap(), (0, 0));
    }

    #[test]
    fn recent_finalized_history_survives_database_reopen() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        {
            let mut conn = Connection::open(temp.path()).unwrap();
            schema::migrate(&conn).unwrap();
            let now = Utc::now();
            let session = ensure_active_session(&mut conn, now).unwrap();
            create_match(&conn, &session.local_id, Some("persisted"), 14, "radiant", RankedMode::Ranked, now).unwrap();
            let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();
            update_match_telemetry(&conn, &active.local_id, &super::super::gsi::MatchTelemetry {
                kills: Some(9), deaths: Some(2), assists: Some(11),
                inventory: vec![Some("item_blink".into()), None, None, None, None, None, Some("item_tpscroll".into()), None, None],
            }).unwrap();
            finalize_match(&mut conn, &active.local_id, &session.local_id, RankedMode::Ranked, MatchResult::Win, "confirmed", now).unwrap();
        }
        let conn = Connection::open(temp.path()).unwrap();
        schema::migrate(&conn).unwrap();
        let history = list_recent_finalized_matches(&conn, 10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!((history[0].kills, history[0].deaths, history[0].assists), (Some(9), Some(2), Some(11)));
        assert_eq!(history[0].inventory[0].as_deref(), Some("item_blink"));
        assert_eq!(history[0].inventory[6].as_deref(), Some("item_tpscroll"));
    }

    // WK-115 - Dashboard match correction + reanchor.

    fn win_match(conn: &mut Connection, session_local_id: &str, match_id: &str, hero_id: i64, ranked: RankedMode) -> LocalMatch {
        let now = Utc::now();
        create_match(conn, session_local_id, Some(match_id), hero_id, "radiant", ranked, now).unwrap();
        let active = find_active_match(conn, session_local_id).unwrap().unwrap();
        finalize_match(conn, &active.local_id, session_local_id, ranked, MatchResult::Win, "confirmed", now).unwrap();
        find_match(conn, &active.local_id).unwrap().unwrap()
    }

    fn lose_match(conn: &mut Connection, session_local_id: &str, match_id: &str, hero_id: i64, ranked: RankedMode) -> LocalMatch {
        let now = Utc::now();
        create_match(conn, session_local_id, Some(match_id), hero_id, "radiant", ranked, now).unwrap();
        let active = find_active_match(conn, session_local_id).unwrap().unwrap();
        finalize_match(conn, &active.local_id, session_local_id, ranked, MatchResult::Loss, "confirmed", now).unwrap();
        find_match(conn, &active.local_id).unwrap().unwrap()
    }

    #[test]
    fn x2_doubles_a_positive_detected_delta() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Ranked);
        assert_eq!(m.detected_rating_delta, Some(25));

        let corrected = correct_match_delta(&mut conn, &m.local_id, Some(50)).unwrap().unwrap();
        assert_eq!(corrected.detected_rating_delta, Some(25), "detected delta is immutable");
        assert_eq!(corrected.rating_delta_correction, 25);
        assert_eq!(corrected.rating_before, Some(6_000));
        assert_eq!(corrected.rating_after, Some(6_050));
    }

    #[test]
    fn x2_doubles_a_negative_detected_delta() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = lose_match(&mut conn, &session.local_id, "1", 14, RankedMode::Ranked);
        assert_eq!(m.detected_rating_delta, Some(-25));

        let corrected = correct_match_delta(&mut conn, &m.local_id, Some(-50)).unwrap().unwrap();
        assert_eq!(corrected.detected_rating_delta, Some(-25), "detected delta is immutable");
        assert_eq!(corrected.rating_delta_correction, -25);
        assert_eq!(corrected.rating_after, Some(5_950));
    }

    #[test]
    fn x2_toggled_back_off_restores_the_detected_delta() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Ranked);

        correct_match_delta(&mut conn, &m.local_id, Some(50)).unwrap();
        let reverted = correct_match_delta(&mut conn, &m.local_id, Some(25)).unwrap().unwrap();
        assert_eq!(reverted.rating_delta_correction, 0);
        assert_eq!(reverted.rating_after, Some(6_025));
    }

    #[test]
    fn a_manual_delta_edit_after_x2_becomes_the_source_of_truth() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Ranked);

        correct_match_delta(&mut conn, &m.local_id, Some(50)).unwrap(); // x2
        let edited = correct_match_delta(&mut conn, &m.local_id, Some(45)).unwrap().unwrap(); // manual override
        assert_eq!(edited.detected_rating_delta, Some(25));
        assert_eq!(edited.rating_delta_correction, 20);
        assert_eq!(edited.rating_after, Some(6_045));
    }

    #[test]
    fn correcting_an_older_match_reanchors_the_next_match_in_the_session() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let match_a = win_match(&mut conn, &session.local_id, "a", 14, RankedMode::Ranked);
        let match_b = win_match(&mut conn, &session.local_id, "b", 2, RankedMode::Ranked);
        assert_eq!(match_a.rating_after, Some(6_025));
        assert_eq!(match_b.rating_before, Some(6_025));
        assert_eq!(match_b.rating_after, Some(6_050));

        correct_match_delta(&mut conn, &match_a.local_id, Some(50)).unwrap(); // x2 on match A

        let reanchored_b = find_match(&conn, &match_b.local_id).unwrap().unwrap();
        assert_eq!(reanchored_b.rating_before, Some(6_050), "match B must anchor on match A's corrected rating_after");
        assert_eq!(reanchored_b.rating_after, Some(6_075));
    }

    #[test]
    fn marking_a_match_unranked_removes_its_mmr_contribution() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Ranked);
        assert_eq!(m.rating_after, Some(6_025));

        let corrected = correct_match_ranked_mode(&mut conn, &m.local_id, Some(RankedMode::Unranked)).unwrap().unwrap();
        assert_eq!(corrected.ranked_mode, RankedMode::Unranked);
        assert_eq!(corrected.rating_before, None, "an unranked match no longer carries an absolute rating snapshot");
        assert_eq!(corrected.rating_after, None);
        assert_eq!(corrected.detected_rating_delta, Some(25), "detected delta on the observation itself is preserved");

        let session_row = find_open_session(&conn).unwrap().unwrap();
        assert_eq!(session_row.rating_current, Some(6_000), "the session must no longer credit an unranked match's delta");
    }

    #[test]
    fn unranking_an_older_match_reanchors_the_next_match_through_it() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let match_a = win_match(&mut conn, &session.local_id, "a", 14, RankedMode::Ranked);
        let match_b = win_match(&mut conn, &session.local_id, "b", 2, RankedMode::Ranked);
        assert_eq!(match_b.rating_after, Some(6_050));

        correct_match_ranked_mode(&mut conn, &match_a.local_id, Some(RankedMode::Unranked)).unwrap();

        let reanchored_b = find_match(&conn, &match_b.local_id).unwrap().unwrap();
        assert_eq!(reanchored_b.rating_before, Some(6_000), "match B anchors straight through the now-unranked match A");
        assert_eq!(reanchored_b.rating_after, Some(6_025));
        let session_row = find_open_session(&conn).unwrap().unwrap();
        assert_eq!(session_row.rating_current, Some(6_025));
    }

    #[test]
    fn reverting_unranked_back_to_ranked_restores_its_contribution() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let match_a = win_match(&mut conn, &session.local_id, "a", 14, RankedMode::Ranked);
        let match_b = win_match(&mut conn, &session.local_id, "b", 2, RankedMode::Ranked);

        correct_match_ranked_mode(&mut conn, &match_a.local_id, Some(RankedMode::Unranked)).unwrap();
        let restored = correct_match_ranked_mode(&mut conn, &match_a.local_id, None).unwrap().unwrap();
        assert_eq!(restored.ranked_mode, RankedMode::Ranked, "clearing the override restores the detected classification");
        assert_eq!(restored.rating_after, Some(6_025));

        let reanchored_b = find_match(&conn, &match_b.local_id).unwrap().unwrap();
        assert_eq!(reanchored_b.rating_before, Some(6_025));
        assert_eq!(reanchored_b.rating_after, Some(6_050));
        let session_row = find_open_session(&conn).unwrap().unwrap();
        assert_eq!(session_row.rating_current, Some(6_050));
    }

    #[test]
    fn reverting_ranked_mode_on_a_match_originally_detected_unranked_goes_back_to_unranked_not_ranked() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Unranked);

        correct_match_ranked_mode(&mut conn, &m.local_id, Some(RankedMode::Ranked)).unwrap();
        let reverted = correct_match_ranked_mode(&mut conn, &m.local_id, None).unwrap().unwrap();
        assert_eq!(reverted.ranked_mode, RankedMode::Unranked, "must restore the real detected value, never a hardcoded Ranked");
    }

    #[test]
    fn correcting_a_match_updates_the_devicewide_current_rating_snapshot() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Ranked);

        correct_match_delta(&mut conn, &m.local_id, Some(50)).unwrap();
        assert_eq!(get_current_rating(&conn).unwrap(), Some(6_050));
    }

    #[test]
    fn correcting_a_match_in_an_already_ended_session_does_not_clobber_the_live_current_rating() {
        let mut conn = test_conn();
        let now = Utc::now();
        let first = ensure_active_session(&mut conn, now).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let m = win_match(&mut conn, &first.local_id, "1", 14, RankedMode::Ranked);
        finalize_session_end(&mut conn, &first.local_id, now).unwrap();

        let second = ensure_active_session(&mut conn, now + chrono::Duration::minutes(1)).unwrap();
        set_current_rating(&mut conn, 6_100).unwrap();
        assert_eq!(second.local_id.ne(&first.local_id), true);

        correct_match_delta(&mut conn, &m.local_id, Some(50)).unwrap();

        assert_eq!(get_current_rating(&conn).unwrap(), Some(6_100), "correcting an old, already-ended session must not overwrite the live open session's current rating");
        let old_session_row = find_match(&conn, &m.local_id).unwrap().unwrap();
        assert_eq!(old_session_row.rating_after, Some(6_050), "the old session's own chain is still correctly reanchored");
    }

    #[test]
    fn delta_correction_is_a_noop_on_a_match_with_no_detected_delta() {
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        let m = win_match(&mut conn, &session.local_id, "1", 14, RankedMode::Unknown);
        assert_eq!(m.detected_rating_delta, None);

        let result = correct_match_delta(&mut conn, &m.local_id, Some(999)).unwrap().unwrap();
        assert_eq!(result.rating_delta_correction, 0, "nothing to correct without a detected delta");
        assert_eq!(result.rating_after, None);
    }

    #[test]
    fn reanchor_skips_over_a_legacy_match_with_no_detected_delta_without_breaking_the_chain() {
        // A match finalized while ranked_mode was Unknown (e.g. an old row
        // from before the account setting was ever synced) has no detected
        // delta and must neither contribute nor crash the reanchor walk for
        // matches around it.
        let mut conn = test_conn();
        let session = ensure_active_session(&mut conn, Utc::now()).unwrap();
        set_current_rating(&mut conn, 6_000).unwrap();
        let match_a = win_match(&mut conn, &session.local_id, "a", 14, RankedMode::Ranked);
        let legacy = win_match(&mut conn, &session.local_id, "legacy", 5, RankedMode::Unknown);
        let match_c = win_match(&mut conn, &session.local_id, "c", 2, RankedMode::Ranked);
        assert_eq!(legacy.rating_before, None);
        assert_eq!(legacy.rating_after, None);
        assert_eq!(match_c.rating_before, Some(6_025), "the legacy unknown-mode match must not break the chain");

        correct_match_delta(&mut conn, &match_a.local_id, Some(50)).unwrap();

        let reanchored_c = find_match(&conn, &match_c.local_id).unwrap().unwrap();
        assert_eq!(reanchored_c.rating_before, Some(6_050));
        assert_eq!(reanchored_c.rating_after, Some(6_075));
    }
}
