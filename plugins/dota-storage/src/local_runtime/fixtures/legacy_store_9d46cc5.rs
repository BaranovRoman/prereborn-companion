// Frozen independent parity oracle from 9d46cc5 store.rs, excluding its unit tests.
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::model::{LocalMatch, LocalMatchState, LocalSession, MatchResult, RankedMode, SyncState};

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<LocalSession> {
    let stale_ack: i64 = row.get(8)?;
    let is_streamed: i64 = row.get(9)?;
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
        is_streamed: is_streamed != 0,
        stream_started_at: row.get(10)?,
        sync_state: SyncState::Pending,
    })
}

const SESSION_COLUMNS: &str = "local_id, backend_id, started_at, ended_at, rating_start, \
     rating_current, rating_adjustment, pending_end_at, stale_ack, is_streamed, stream_started_at";

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

/// WK-137 - like `find_open_session`, but only ever returns a genuine
/// broadcast session (`is_streamed = 1`). Used by everything that surfaces
/// "the current stream" to a human or to OBS scene automation
/// (`lifecycle::status`, `summary::get`'s W/L tally) - a gameplay session
/// opened for GSI-observed-but-not-streamed play must never be mistaken for
/// one of those, see docs/research/wk-137-match-session-decoupling.md.
pub fn find_open_streamed_session(conn: &Connection) -> rusqlite::Result<Option<LocalSession>> {
    conn.query_row(
        &format!(
            "SELECT {SESSION_COLUMNS} FROM local_sessions WHERE ended_at IS NULL AND is_streamed = 1 \
             ORDER BY rowid DESC LIMIT 1"
        ),
        [],
        row_to_session,
    )
    .optional()
}

/// WK-137 - single-session lookup by id, regardless of `ended_at` (unlike
/// `find_open_session`). Used after a match resolves to check whether ITS
/// session is still a gameplay session that should now auto-close - see
/// `local_runtime::mod::handle_gsi`.
pub fn find_session(conn: &Connection, local_id: &str) -> rusqlite::Result<Option<LocalSession>> {
    conn.query_row(&format!("SELECT {SESSION_COLUMNS} FROM local_sessions WHERE local_id = ?1"), params![local_id], row_to_session)
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

/// WK-113/WK-137 - MMR carry-over shared by every session-creation path,
/// mirroring the backend's own `resetActiveSession`
/// (stream-session-service.ts): a brand new local session's starting rating
/// is the last session's known `rating_current`, not null - the account's
/// last-known MMR doesn't reset just because a new session (streamed or,
/// since WK-137, gameplay-only) began. Genuinely null only for this
/// device's very first session ever.
fn carried_over_rating(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    let previous_session_rating: Option<i64> = conn
        .query_row("SELECT rating_current FROM local_sessions ORDER BY rowid DESC LIMIT 1", [], |row| row.get(0))
        .optional()?
        .flatten();
    Ok(get_current_rating(conn)?.or(previous_session_rating))
}

/// WK-137 - shared INSERT for both session-creation paths below; only
/// `is_streamed` (and therefore whether a `session_started` sync event is
/// true to send) differs between them.
fn insert_session(conn: &mut Connection, now: DateTime<Utc>, is_streamed: bool) -> rusqlite::Result<LocalSession> {
    let carried_rating = carried_over_rating(conn)?;
    let local_id = Uuid::new_v4().to_string();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO local_sessions (local_id, started_at, rating_start, rating_current, is_streamed, stream_started_at) \
         VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
        params![
            local_id,
            now.to_rfc3339(),
            carried_rating,
            is_streamed as i64,
            is_streamed.then(|| now.to_rfc3339()),
        ],
    )?;
    if is_streamed {
        // WK-113 - durable outbox entry, in the SAME transaction as the
        // insert above - see local_runtime::sync's doc comment for why this
        // atomicity is the whole point.
        let payload = serde_json::json!({
            "localSessionId": local_id,
            "startedAt": now.to_rfc3339(),
            "ratingStart": carried_rating,
        });
        super::sync::enqueue(&tx, "session", &local_id, "session_started", &payload, now)?;
    }
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
        is_streamed,
        stream_started_at: is_streamed.then(|| now.to_rfc3339()),
        sync_state: SyncState::Pending,
    })
}

/// Mirrors `getOrCreateActiveSession` (stream-session-service.ts): finds the
/// most recent session that hasn't ended, or creates a fresh, genuinely
/// streamed one. The ONLY place a new OBS-driven LocalSession is created
/// (see `lifecycle::apply`'s `StartNewSession` arm, the only caller).
pub fn ensure_active_session(conn: &mut Connection, now: DateTime<Utc>) -> rusqlite::Result<LocalSession> {
    if let Some(session) = find_open_session(conn)? {
        return Ok(session);
    }
    insert_session(conn, now, true)
}

/// WK-137 - opens a session for GSI-observed gameplay with no OBS stream
/// active. Never called when a session is already open (mod.rs only reaches
/// this after both `find_active_match_anywhere` and `find_open_session`
/// came back empty) - the `find_open_session` check below is defense in
/// depth against a race, matching `ensure_active_session`'s own shape, not
/// the primary path. Deliberately enqueues no sync event: nothing has
/// actually gone live, so there is nothing true to tell the backend yet -
/// see `mark_session_streamed` for the moment that changes, and
/// docs/research/wk-137-match-session-decoupling.md for why syncing this
/// session prematurely would misrepresent it as a broadcast.
pub fn ensure_gameplay_session(conn: &mut Connection, now: DateTime<Utc>) -> rusqlite::Result<LocalSession> {
    if let Some(session) = find_open_session(conn)? {
        return Ok(session);
    }
    insert_session(conn, now, false)
}

/// WK-137 - "graduates" an open gameplay session into a genuine stream
/// session the moment OBS is found streaming while it's still open
/// (`lifecycle::apply`'s `ContinueSession` arm, which also runs on every
/// ordinary already-streamed tick - the `is_streamed = 0` guard below is
/// what makes this idempotent/a no-op then). `stream_started_at` records
/// the moment OBS actually went live, kept separate from `started_at`
/// (which stays "when this session began being observed") so the session's
/// synced `startedAt` is never backdated to before OBS was actually
/// streaming. The match already tracked in this session, if any, is not
/// moved or re-created - it simply keeps finalizing into the same session,
/// which is now a real stream session.
pub fn mark_session_streamed(conn: &mut Connection, local_id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE local_sessions SET is_streamed = 1, stream_started_at = ?2 WHERE local_id = ?1 AND is_streamed = 0",
        params![local_id, now.to_rfc3339()],
    )?;
    if changed > 0 {
        let rating_start: Option<i64> = tx
            .query_row("SELECT rating_start FROM local_sessions WHERE local_id = ?1", params![local_id], |row| row.get(0))
            .optional()?
            .flatten();
        let payload = serde_json::json!({
            "localSessionId": local_id,
            "startedAt": now.to_rfc3339(),
            "ratingStart": rating_start,
        });
        super::sync::enqueue(&tx, "session", local_id, "session_started", &payload, now)?;
    }
    tx.commit()
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
/// manual stale-recovery "end" action. WK-137 also reuses this to close a
/// gameplay session once the match that opened it resolves (see mod.rs's
/// `handle_gsi`). `ended_at IS NULL` guard makes this idempotent against a
/// repeated call for the same session - including for WK-113's outbox
/// enqueue below, which only fires on the write that actually changed
/// something (`changed > 0`), never on a no-op repeat. The `session_ended`
/// event is only ever true for a session the backend actually knows about -
/// enqueued only when `is_streamed`, i.e. only when a matching
/// `session_started` was (or will be) sent; a gameplay session that never
/// graduated into a stream has nothing to end on the backend, see
/// docs/research/wk-137-match-session-decoupling.md.
pub fn finalize_session_end(conn: &mut Connection, local_id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE local_sessions SET ended_at = ?2, pending_end_at = NULL WHERE local_id = ?1 AND ended_at IS NULL",
        params![local_id, now.to_rfc3339()],
    )?;
    if changed > 0 {
        let is_streamed: i64 = tx.query_row(
            "SELECT is_streamed FROM local_sessions WHERE local_id = ?1",
            params![local_id],
            |row| row.get(0),
        )?;
        if is_streamed != 0 {
            let payload = serde_json::json!({ "localSessionId": local_id, "endedAt": now.to_rfc3339() });
            super::sync::enqueue(&tx, "session", local_id, "session_ended", &payload, now)?;
        }
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
        last_seen_at: row.get(22)?,
        sync_state: SyncState::Pending,
    })
}

const MATCH_COLUMNS: &str = "local_id, session_local_id, backend_id, match_id, match_key, hero_id, \
     player_team, result, ranked_mode, rating_before, detected_rating_delta, state, rating_after, \
     kills, deaths, assists, inventory, started_at, interrupted_at, finalized_at, \
     ranked_mode_detected, rating_delta_correction, last_seen_at";

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

/// WK-137 - the session-independent counterpart of `find_active_match`: the
/// currently active match anywhere on the device, regardless of which
/// session it belongs to or whether that session has already `ended_at`.
/// This is what lets a match survive its own session ending mid-flight (OBS
/// stops streaming, the 30s grace elapses, but the match itself is still
/// being played) - see `local_runtime::mod::handle_gsi`, the only caller: a
/// match's own lifecycle, not its session's, decides whether GSI ticks
/// still apply to it. At most one match is ever active device-wide by
/// construction (detector.rs's own transition logic never leaves two rows
/// in an active state at once), so this needs no session_local_id filter.
pub fn find_active_match_anywhere(conn: &Connection) -> rusqlite::Result<Option<LocalMatch>> {
    conn.query_row(
        &format!(
            "SELECT {MATCH_COLUMNS} FROM local_matches WHERE state IN ({}) ORDER BY rowid DESC LIMIT 1",
            active_states_in_clause()
        ),
        [],
        row_to_match,
    )
    .optional()
}

/// WK-146 - match-level watchdog candidates: an active match (`in_progress`
/// or `post_game_pending` - `interrupted` is already MMR-neutral and
/// reconnectable, nothing further to do to it here) whose own GSI silence
/// has crossed `threshold` AND whose containing session has *already*
/// `ended_at` set. The session-ended half is the corroborating evidence
/// (WK-146's product decision: elapsed silence alone must never trigger
/// this) - a session ending via the existing OBS-grace path never depends
/// on GSI at all (see `lifecycle.rs`), so it's a genuinely independent
/// signal, not just the same timer read twice. Deliberately does NOT join
/// on `is_streamed`: a gameplay-only (WK-137) session's `ended_at` happens
/// to never be set by any existing code path today (session-level staleness
/// is scoped to streamed sessions only, see `lifecycle::decide`), so this
/// query naturally never fires for one - not a special case, just what the
/// join already implies; documented so a future change to that invariant
/// doesn't silently widen this watchdog's behavior too.
pub fn find_stale_matches_with_ended_session(
    conn: &Connection,
    now: DateTime<Utc>,
    threshold: Duration,
) -> rusqlite::Result<Vec<LocalMatch>> {
    let cutoff = (now - threshold).to_rfc3339();
    let qualified_columns = MATCH_COLUMNS
        .split(", ")
        .map(|column| format!("m.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT {qualified_columns} FROM local_matches m \
         JOIN local_sessions s ON s.local_id = m.session_local_id \
         WHERE m.state IN ('in_progress', 'post_game_pending') \
           AND s.ended_at IS NOT NULL \
           AND m.last_seen_at IS NOT NULL AND m.last_seen_at <= ?1"
    ))?;
    let rows = stmt.query_map(params![cutoff], row_to_match)?;
    rows.collect()
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

/// WK-146 - also bumps `last_seen_at` to `now` on every call: this already
/// runs on virtually every GSI tick that touches an active match (both the
/// ordinary in-progress path and the post-game path, see
/// `detector::handle_snapshot`), so it's the one natural hook point for
/// "when did GSI last genuinely speak about this match" without threading a
/// second write through every call site.
pub fn update_match_telemetry(
    conn: &Connection,
    local_id: &str,
    telemetry: &super::gsi::MatchTelemetry,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let inventory = if telemetry.inventory.iter().any(Option::is_some) {
        serde_json::to_string(&telemetry.inventory).unwrap_or_else(|_| "[]".to_string())
    } else {
        "[]".to_string()
    };
    conn.execute(
        "UPDATE local_matches SET \
             kills = COALESCE(?2, kills), deaths = COALESCE(?3, deaths), assists = COALESCE(?4, assists), \
             inventory = CASE WHEN ?5 = '[]' THEN inventory ELSE ?5 END, \
             last_seen_at = ?6 \
         WHERE local_id = ?1 AND state != 'finalized'",
        params![local_id, telemetry.kills, telemetry.deaths, telemetry.assists, inventory, now.to_rfc3339()],
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

/// WK-140 - per-hero local aggregate for Hero Detail's statistics zone.
/// Device-wide (not session-scoped) like `list_recent_finalized_matches`:
/// "how have I done on this hero across my local history" is the intended
/// semantics, not "this stream". `matches` counts every finalized match on
/// the hero regardless of result (including `abandon`); `wins`/`losses` and
/// the winrate they imply are computed by the caller only from decided
/// (win/loss) results, so an abandon-only history reports a real "no
/// decided result" state instead of a misleading 0%.
pub struct HeroMatchAggregate {
    pub matches: i64,
    pub wins: i64,
    pub losses: i64,
    pub avg_kills: Option<f64>,
    pub avg_deaths: Option<f64>,
    pub avg_assists: Option<f64>,
    /// Newest-first, capped at `recent_limit`.
    pub recent_results: Vec<MatchResult>,
}

pub fn hero_local_stats(conn: &Connection, hero_id: i64, recent_limit: i64) -> rusqlite::Result<HeroMatchAggregate> {
    let matches: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_matches WHERE state = 'finalized' AND hero_id = ?1",
        params![hero_id],
        |row| row.get(0),
    )?;
    let wins: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_matches WHERE state = 'finalized' AND hero_id = ?1 AND result = 'win'",
        params![hero_id],
        |row| row.get(0),
    )?;
    let losses: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_matches WHERE state = 'finalized' AND hero_id = ?1 AND result = 'loss'",
        params![hero_id],
        |row| row.get(0),
    )?;
    let (avg_kills, avg_deaths, avg_assists) = conn.query_row(
        "SELECT AVG(kills), AVG(deaths), AVG(assists) FROM local_matches WHERE state = 'finalized' AND hero_id = ?1",
        params![hero_id],
        |row| Ok((row.get::<_, Option<f64>>(0)?, row.get::<_, Option<f64>>(1)?, row.get::<_, Option<f64>>(2)?)),
    )?;
    let mut stmt = conn.prepare(
        "SELECT result FROM local_matches WHERE state = 'finalized' AND hero_id = ?1 ORDER BY rowid DESC LIMIT ?2",
    )?;
    let recent_results = stmt
        .query_map(params![hero_id, recent_limit], |row| {
            let raw: String = row.get(0)?;
            Ok(MatchResult::from_db_str(&raw))
        })?
        .filter_map(|row| row.transpose())
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(HeroMatchAggregate { matches, wins, losses, avg_kills, avg_deaths, avg_assists, recent_results })
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
             ranked_mode_detected, state, started_at, last_seen_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'in_progress', ?8, ?8)",
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

/// Mirrors `markInterrupted`. The `state IN (...)` guard originally covered
/// only `in_progress` (the sole state `detector::decide_leave` ever calls
/// this from - a live leave tick, no result observed yet). WK-146's watchdog
/// widens it to also cover `post_game_pending`, since a stale match can be
/// sitting on a single *unconfirmed* win/loss observation when corroborating
/// evidence (session already ended, or a genuinely new match arrived)
/// justifies parking it - `result = NULL` discards that observation rather
/// than promoting it to a result, exactly like `mark_needs_review`'s
/// discard-on-ambiguity treatment: watchdog recovery is corroboration of
/// abandonment, not corroboration of an outcome, so it must never surface a
/// win/loss (or touch any rating field) the way `finalize_match` does. Every
/// existing caller (the live in_progress leave path) always has `result =
/// NULL` already at that point, so this widening changes nothing for them.
pub fn mark_interrupted(conn: &Connection, local_id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_matches SET state = 'interrupted', interrupted_at = ?2, result = NULL \
         WHERE local_id = ?1 AND state IN ('in_progress', 'post_game_pending')",
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
/// Scoped to ONE session's own chain: recomputes this session's matches
/// from its *existing* `rating_start` anchor and writes the resulting
/// `rating_current`, but never writes `rating_start` itself. WK-123's
/// `cascade_reanchor` (below) is what carries a corrected session's new
/// `rating_current` into the *next* session's `rating_start` and calls back
/// into this function for it, and so on forward - so a caller that also
/// needs cross-session continuity should call `cascade_reanchor`, not this
/// function directly. The `ended_at IS NULL` guard below is what keeps a
/// correction against an old, ended session from clobbering the live
/// device-wide current-rating snapshot with a stale value; `cascade_reanchor`
/// preserves this per-session by only ever persisting the snapshot for
/// whichever session in the forward walk is actually open.
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

/// WK-123 - after `reanchor_session` recomputes the corrected session's own
/// chain, walks forward through every session chronologically after it (in
/// `rowid` order - the same insertion-order proxy `find_open_session`/
/// `ensure_active_session` already rely on; there is no indexed/guaranteed
/// ordering on `started_at`), carrying the corrected session's new
/// `rating_current` into the next session's `rating_start`, re-running
/// `reanchor_session` on it, then repeating with whatever new `rating_current`
/// that produces. `reanchor_session` never writes `rating_start` and never
/// touches `rating_adjustment`, so each later session's own explicit
/// absolute correction (`set_current_rating`) is read but never overwritten
/// here - only the baseline it sits on top of shifts, which is exactly what
/// `session_delta`'s existing `current - start - rating_adjustment` formula
/// already expects. A session with no finalized matches simply passes its
/// (now-shifted) `rating_start` straight through as its `rating_current`.
///
/// Reaching the currently open session is not a special case: it gets its
/// `rating_start` corrected and its finalized matches reanchored exactly
/// like any other session in the walk, and `reanchor_session`'s own
/// `is_open` check persists the corrected value into the device-wide
/// current-rating snapshot so the next in-progress match finalizes against
/// the right baseline. Non-finalized matches are never touched by
/// `reanchor_session` (it only ever selects `state = 'finalized'` rows) -
/// an in-progress match always reads `rating_current` live at finalize
/// time, so its lifecycle state has nothing to reconcile here.
///
/// Stops (without error, without touching anything further) the moment a
/// session's recomputed `rating_current` is `None` - a session only
/// produces `None` here if its own `rating_start` was itself never
/// established (no absolute correction ever applied and no match ever
/// finalized in it before this walk reached it), and carrying a value past
/// that point would mean fabricating a baseline nobody ever observed. The
/// next session's existing `rating_start` (however it came to be set) is
/// left untouched rather than overwritten with an unknown value - a
/// deliberately conservative legacy boundary, not a bug.
///
/// Never touches any session before the one passed in, never creates or
/// merges sessions, never changes `started_at`/`ended_at`/match results -
/// only the `rating_start`/`rating_current`/`rating_before`/`rating_after`
/// MMR chain. Runs on the caller's already-open transaction (see call
/// sites), so a correction plus however many subsequent sessions it
/// cascades into commits, or fails, as one atomic unit - it never opens or
/// commits a transaction of its own.
fn cascade_reanchor(tx: &rusqlite::Transaction, session_local_id: &str) -> rusqlite::Result<()> {
    reanchor_session(tx, session_local_id)?;

    let mut current_id = session_local_id.to_string();
    loop {
        let rating_current: Option<i64> = tx.query_row(
            "SELECT rating_current FROM local_sessions WHERE local_id = ?1",
            params![current_id],
            |row| row.get(0),
        )?;
        let Some(new_start) = rating_current else {
            break;
        };

        let next_id: Option<String> = tx
            .query_row(
                "SELECT local_id FROM local_sessions \
                 WHERE rowid > (SELECT rowid FROM local_sessions WHERE local_id = ?1) \
                 ORDER BY rowid ASC LIMIT 1",
                params![current_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(next_id) = next_id else {
            break;
        };

        tx.execute(
            "UPDATE local_sessions SET rating_start = ?2 WHERE local_id = ?1",
            params![next_id, new_start],
        )?;
        reanchor_session(tx, &next_id)?;
        current_id = next_id;
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
/// to correct. Reanchors the session afterward and cascades that forward
/// into every later session - see `cascade_reanchor`.
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
    cascade_reanchor(&tx, &session_local_id)?;
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
/// Reanchors the session afterward and cascades that forward into every
/// later session (see `cascade_reanchor`): an Unranked match stops
/// contributing (its own rating_before/after clear, later matches anchor
/// straight through it); a match restored to Ranked resumes contributing
/// its stored detected delta + whatever delta correction it already had.
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
    cascade_reanchor(&tx, &session_local_id)?;
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
