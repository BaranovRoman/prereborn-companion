// WK-146 - match-level watchdog for total GSI silence. Closes the one gap
// FAILURE_RECONNECT_MATRIX.md's scenario 3 documents: `detector.rs`'s own
// leave/finalize logic (`decide_leave`/`decide_post_game`) only ever runs
// inside `handle_snapshot`, which only ever runs when a GSI payload actually
// arrives. If Dota/GSI goes silent forever mid-match (crash, network cut,
// machine sleep with no wake before the user gives up) nothing independently
// times out the local match record - it stays `in_progress`/
// `post_game_pending` in SQLite indefinitely.
//
// Product decision (WK-146, see the ticket's own "не входит в задачу" and
// this module's PR description for the full reasoning): elapsed GSI silence
// ALONE must never mutate a match. It only marks a match "stale" (a purely
// derived, never-persisted concept - see `is_match_stale`). Automatic
// recovery additionally requires positive corroborating evidence:
//
//   (a) the containing session has already ended (`local_sessions.ended_at`
//       set) - see `store::find_stale_matches_with_ended_session`, applied
//       by the periodic `sweep` below - or
//   (b) a genuinely new, distinct match starts while the old one is already
//       stale - handled inline in `detector::handle_snapshot`, not here,
//       since that's where the new-match evidence actually arrives.
//
// A stale match with neither signal available yet is deliberately left
// alone ("leave it recoverable/manual rather than guessing") - see
// `manual_recover` for the explicit escape hatch, and this module's PR
// description for why a bare "Companion restarted and found a stale match"
// is NOT treated as its own independent corroboration: a restart carries no
// information about whether Dota is still about to reconnect (see
// `local_runtime::mod`'s own `crash_mid_match_then_restart_preserves_the_
// in_progress_match` test, which expects exactly that to keep working) -
// persisting `last_seen_at` (model.rs) instead makes the SAME staleness
// check durable across a restart, so the periodic sweep below naturally
// picks up a match that went stale while Companion was closed, without
// needing a separate startup-only code path or heuristic.
//
// Every automatic transition here goes through the existing, already
// MMR-neutral/idempotent `store::mark_interrupted` - no new match state, no
// fabricated win/loss/rating, no parallel state machine.

use chrono::{DateTime, Duration, Utc};
use tauri::{AppHandle, Manager, Runtime};

use super::store;
use super::LocalRuntimeState;

/// Distinct from `detector::RECONNECT_WINDOW` (5 min - same-match resume
/// after a live leave signal) and `lifecycle::STALE_THRESHOLD` (12h -
/// session-level, and only ever evaluated for streamed sessions). Product
/// value chosen for WK-146: comfortably beyond a normal reconnect/loading-
/// screen/draft gap, short enough that a genuinely broken match becomes
/// visible/recoverable reasonably quickly. Only ever gates *detection*
/// (surfacing "this looks stuck") - see this module's doc comment for why
/// crossing it never mutates a match by itself.
pub const STALE_THRESHOLD: Duration = Duration::minutes(20);

/// Coarse on purpose: staleness is measured in tens of minutes, so a sub-
/// minute sweep interval (`lifecycle::SWEEP_INTERVAL`'s 2s, tuned for a
/// 30s OBS grace period) would just be wasted work here. A dedicated thread
/// rather than piggybacking on `lifecycle::start_sweep` because that sweep
/// only ever reconciles when OBS streaming state is already known
/// (`start_sweep`'s `if let Some(streaming) = ...` gate) - a WK-137
/// gameplay-only session, which never touches OBS at all, must still get
/// watchdog coverage.
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Pure: whether `last_seen_at` is old enough to call this match "stale" as
/// of `now`. Never mutates anything by itself - see this module's doc
/// comment for why staleness and automatic recovery are deliberately two
/// different questions.
pub fn is_match_stale(last_seen_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now.signed_duration_since(last_seen_at) >= STALE_THRESHOLD
}

fn parse_rfc3339(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|dt| dt.with_timezone(&Utc))
}

/// Starts the periodic sweep - the only thing that can auto-recover a stale
/// match when its containing session already ended but no further GSI tick
/// ever arrives to trigger `detector.rs`'s own new-match reconciliation.
pub fn start_sweep(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SWEEP_INTERVAL);
        sweep(&app, Utc::now());
    });
}

// WK-146 - generic over `R: Runtime` (same pattern as
// `local_runtime::handle_gsi`/`storage::append_rolling_log`) so this, the
// real sweep logic, can be exercised end to end against
// `tauri::test::mock_app()` in the tests below - not just the pure
// `is_match_stale` check underneath it. Every real call site (`start_sweep`,
// `AppHandle` unparameterized = `AppHandle<Wry>`) keeps compiling unchanged.
pub fn sweep<R: Runtime>(app: &AppHandle<R>, now: DateTime<Utc>) {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return };
    let candidates = match store::find_stale_matches_with_ended_session(conn, now, STALE_THRESHOLD) {
        Ok(candidates) => candidates,
        Err(error) => {
            crate::storage::append_rolling_log(app, &format!("Match watchdog: sweep query failed ({error})"));
            return;
        }
    };
    for candidate in candidates {
        if let Err(error) = store::mark_interrupted(conn, &candidate.local_id, now) {
            crate::storage::append_rolling_log(
                app,
                &format!("Match watchdog: failed to auto-interrupt match={} ({error})", candidate.local_id),
            );
            continue;
        }
        crate::storage::append_rolling_log(
            app,
            &format!(
                "Match watchdog: match={} auto-interrupted (no GSI for 20m+, containing session already ended)",
                candidate.local_id
            ),
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchdogState {
    NoActiveMatch,
    Fresh,
    Stale,
}

pub struct WatchdogStatus {
    pub state: WatchdogState,
    pub last_seen_at: Option<String>,
}

/// Read-only projection for `runtime_health::compute` - mirrors
/// `lifecycle::status`'s "derived, never written" contract. Reads whichever
/// match is active device-wide (there is at most one by construction, see
/// `store::find_active_match_anywhere`'s own doc comment).
pub fn status<R: Runtime>(app: &AppHandle<R>) -> WatchdogStatus {
    let now = Utc::now();
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else {
        return WatchdogStatus { state: WatchdogState::NoActiveMatch, last_seen_at: None };
    };
    let Some(active) = store::find_active_match_anywhere(conn).ok().flatten() else {
        return WatchdogStatus { state: WatchdogState::NoActiveMatch, last_seen_at: None };
    };
    let stale = active
        .last_seen_at
        .as_deref()
        .and_then(parse_rfc3339)
        .is_some_and(|last_seen| is_match_stale(last_seen, now));
    WatchdogStatus {
        state: if stale { WatchdogState::Stale } else { WatchdogState::Fresh },
        last_seen_at: active.last_seen_at,
    }
}

/// Manual recovery escape hatch for exactly the case Hybrid resolution
/// deliberately leaves alone: a stale match with no session-end/new-match
/// corroboration available yet. Requires the currently active match to
/// already be stale - refuses to touch a match that's merely `in_progress`
/// but still fresh, so this can never be used to prematurely end a real,
/// ongoing game.
pub fn manual_recover<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let now = Utc::now();
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return Err("Local runtime is not available".into()) };
    let Some(active) = store::find_active_match_anywhere(conn).map_err(|error| error.to_string())? else {
        return Err("No active match to recover".into());
    };
    let stale = active
        .last_seen_at
        .as_deref()
        .and_then(parse_rfc3339)
        .is_some_and(|last_seen| is_match_stale(last_seen, now));
    if !stale {
        return Err("Active match is not stale yet".into());
    }
    store::mark_interrupted(conn, &active.local_id, now).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::model::RankedMode;
    use crate::local_runtime::schema;
    use crate::local_runtime::{detector, store};
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn a_match_seen_under_the_threshold_ago_is_not_stale() {
        let now = Utc::now();
        assert!(!is_match_stale(now - Duration::minutes(19), now));
    }

    #[test]
    fn a_match_seen_at_or_past_the_threshold_is_stale() {
        let now = Utc::now();
        assert!(is_match_stale(now - Duration::minutes(20), now));
        assert!(is_match_stale(now - Duration::hours(3), now));
    }

    fn tick(match_id: &str, hero_id: i64) -> crate::local_runtime::gsi::GsiSnapshot {
        crate::local_runtime::gsi::GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS".to_string(),
            activity: Some("playing".to_string()),
            custom_game_name: None,
            match_id: Some(match_id.to_string()),
            win_team: None,
            hero_id: Some(hero_id),
            team_name: Some("radiant".to_string()),
            telemetry: Default::default(),
        }
    }

    // WK-146 regression #3 (mega-prompt): long silence alone, with no
    // corroborating evidence at all (session still open), must never
    // auto-mutate the match - it stays exactly `in_progress`.
    #[test]
    fn sweep_never_touches_a_stale_match_whose_session_is_still_open() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        detector::handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("1", 14), now).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let much_later = now + Duration::hours(2);
        sweep(app.handle(), much_later);

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let match_state: String = conn.query_row("SELECT state FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(match_state, "in_progress", "no corroboration (session still open) must never auto-mutate a stale match");
    }

    // WK-146 regression #4 (mega-prompt equivalent): stale + the containing
    // session has already ended (the corroborating evidence) -> auto-
    // interrupted exactly once, no fabricated result, no rating touched.
    #[test]
    fn sweep_auto_interrupts_a_stale_match_once_its_session_has_ended() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        detector::handle_snapshot(&mut conn, &session.local_id, RankedMode::Ranked, &tick("1", 14), now).unwrap();
        store::finalize_session_end(&mut conn, &session.local_id, now + Duration::minutes(1)).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let stale_moment = now + STALE_THRESHOLD + Duration::minutes(1);
        sweep(app.handle(), stale_moment);

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let (match_state, result, rating_after): (String, Option<String>, Option<i64>) = conn
            .query_row("SELECT state, result, rating_after FROM local_matches", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(match_state, "interrupted");
        assert_eq!(result, None, "watchdog recovery must never fabricate a win/loss");
        assert_eq!(rating_after, None, "watchdog recovery must never touch MMR");
    }

    // WK-146 regression #10 (mega-prompt): the sweep itself is safe to run
    // repeatedly - a second sweep after auto-interrupt is a no-op, not a
    // second transition/log line worth of state change.
    #[test]
    fn sweep_is_idempotent_across_repeated_runs() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        detector::handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("1", 14), now).unwrap();
        store::finalize_session_end(&mut conn, &session.local_id, now + Duration::minutes(1)).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let stale_moment = now + STALE_THRESHOLD + Duration::minutes(1);
        sweep(app.handle(), stale_moment);
        sweep(app.handle(), stale_moment + Duration::minutes(5));
        sweep(app.handle(), stale_moment + Duration::hours(1));

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1, "repeated sweeps must never duplicate or re-transition the match");
        let interrupted_at: String = conn.query_row("SELECT interrupted_at FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_ne!(interrupted_at, (stale_moment + Duration::hours(1)).to_rfc3339(), "a later sweep must not re-stamp an already-interrupted row");
    }

    #[test]
    fn manual_recover_refuses_a_match_that_is_not_stale_yet() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        detector::handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("1", 14), now).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let result = manual_recover(app.handle());
        assert!(result.is_err(), "a fresh, genuinely ongoing match must never be recoverable through this command");

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let match_state: String = conn.query_row("SELECT state FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(match_state, "in_progress");
    }

    // Covers the truly ambiguous case (no session end, no new match) that
    // Hybrid resolution deliberately never auto-resolves: the only way out
    // is this explicit, opt-in command.
    #[test]
    fn manual_recover_interrupts_a_stale_match_with_no_other_corroboration() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let conn = test_conn();
        let now = Utc::now();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);
        {
            let state = app.state::<LocalRuntimeState>();
            let mut guard = state.lock();
            let conn = guard.as_mut().unwrap();
            let session = store::ensure_active_session(conn, now).unwrap();
            detector::handle_snapshot(conn, &session.local_id, RankedMode::Unknown, &tick("1", 14), now).unwrap();
            // Directly backdate last_seen_at past the threshold instead of
            // sleeping in the test - the session is deliberately left open
            // (no finalize_session_end call) to prove this path needs none.
            conn.execute(
                "UPDATE local_matches SET last_seen_at = ?1",
                rusqlite::params![(now - Duration::minutes(25)).to_rfc3339()],
            )
            .unwrap();
        }

        manual_recover(app.handle()).unwrap();

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let (match_state, result): (String, Option<String>) =
            conn.query_row("SELECT state, result FROM local_matches", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(match_state, "interrupted");
        assert_eq!(result, None);
    }
}
