use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;

use super::gsi::{self, GsiSnapshot};
use super::model::{LocalMatch, LocalMatchState, MatchResult, RankedMode};
use super::store;

// Mirrors stream-match-service.ts's `RECONNECT_WINDOW_MS` - 5 minutes
// matches Dota's own abandon timer, not an arbitrarily chosen number.
const RECONNECT_WINDOW: Duration = Duration::minutes(5);

fn parse_rfc3339(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn is_within_reconnect_window(interrupted_at: Option<&str>, now: DateTime<Utc>) -> bool {
    match interrupted_at {
        None => true,
        Some(raw) => now - parse_rfc3339(raw) <= RECONNECT_WINDOW,
    }
}

/// Pure identity check - mirrors `processGsiPayloadForMatch`'s `sameMatch`.
/// Takes only plain local values (an already-read match row's fields, the
/// parsed GSI snapshot, and "now") - no database handle, no backend/network
/// type of any kind can be threaded into this signature. See
/// `match_transition_never_depends_on_backend_state` below, which pins
/// exactly that.
fn is_same_match(active: &LocalMatch, snapshot: &GsiSnapshot, now: DateTime<Utc>) -> bool {
    match (&snapshot.match_id, &active.match_id) {
        (Some(a), Some(b)) => a == b,
        _ => {
            snapshot.team_name.as_deref() == Some(active.player_team.as_str())
                && is_within_reconnect_window(active.interrupted_at.as_deref(), now)
                && (active.interrupted_at.is_none()
                    || !gsi::is_new_match_signal_game_state(&snapshot.game_state))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaveDecision {
    MarkInterrupted,
    FinalizeProbable,
    MarkNeedsReview,
    NoOp,
}

/// Mirrors `handleLeftMatch` - pure function of the match's own
/// state/result, nothing else.
fn decide_leave(state: LocalMatchState, result: Option<MatchResult>) -> LeaveDecision {
    match state {
        LocalMatchState::InProgress => LeaveDecision::MarkInterrupted,
        LocalMatchState::PostGamePending => {
            if result.is_some() {
                LeaveDecision::FinalizeProbable
            } else {
                LeaveDecision::MarkNeedsReview
            }
        }
        LocalMatchState::Interrupted | LocalMatchState::Finalized | LocalMatchState::NeedsReview => {
            LeaveDecision::NoOp
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostGameDecision {
    TransitionToPending(Option<MatchResult>),
    SetFirstObservation(MatchResult),
    FinalizeConfirmed,
    MarkNeedsReview,
    NoOp,
}

/// Mirrors `markPostGame` - pure function of the match's current
/// state/result and this tick's resolved win/loss observation (if any).
fn decide_post_game(
    state: LocalMatchState,
    current_result: Option<MatchResult>,
    observation: Option<MatchResult>,
) -> PostGameDecision {
    match state {
        LocalMatchState::InProgress => PostGameDecision::TransitionToPending(observation),
        LocalMatchState::PostGamePending => match (current_result, observation) {
            (_, None) => PostGameDecision::NoOp,
            (None, Some(result)) => PostGameDecision::SetFirstObservation(result),
            (Some(existing), Some(new)) if existing == new => PostGameDecision::FinalizeConfirmed,
            (Some(_), Some(_)) => PostGameDecision::MarkNeedsReview,
        },
        _ => PostGameDecision::NoOp,
    }
}

fn resolve_observation(snapshot: &GsiSnapshot, team_name: &str) -> Option<MatchResult> {
    match snapshot.win_team.as_deref() {
        Some("radiant") | Some("dire") => {
            Some(if snapshot.win_team.as_deref() == Some(team_name) {
                MatchResult::Win
            } else {
                MatchResult::Loss
            })
        }
        _ => None,
    }
}

fn apply_leave(conn: &mut Connection, active: &LocalMatch, now: DateTime<Utc>) -> rusqlite::Result<()> {
    match decide_leave(active.state, active.result) {
        LeaveDecision::MarkInterrupted => store::mark_interrupted(conn, &active.local_id, now),
        LeaveDecision::FinalizeProbable => store::finalize_match(
            conn,
            &active.local_id,
            &active.session_local_id,
            active.ranked_mode,
            active.result.expect("FinalizeProbable only returned when a result exists"),
            "probable",
            now,
        ),
        LeaveDecision::MarkNeedsReview => store::mark_needs_review(conn, &active.local_id),
        LeaveDecision::NoOp => Ok(()),
    }
}

/// Entry point called (indirectly, via `local_runtime::handle_gsi`) once
/// per GSI tick with the current session already resolved. Mirrors
/// `processGsiPayloadForMatch` end to end: DB reads/writes happen here
/// (against the local SQLite file, not a network backend), but every
/// "what should happen" decision is delegated to a pure function above that
/// cannot see anything backend-shaped - this function's own signature is
/// the second half of that guarantee: `Connection` here is the local
/// runtime's own on-disk store, not `AppState`/a backend client, so this
/// module has no way to consult (let alone depend on) prereborn.ru
/// reachability even if it wanted to.
pub fn handle_snapshot(
    conn: &mut Connection,
    session_local_id: &str,
    ranked_mode: RankedMode,
    snapshot: &GsiSnapshot,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    if !snapshot.is_in_match() || snapshot.custom_game_name.is_some() {
        if let Some(active) = store::find_active_match(conn, session_local_id)? {
            apply_leave(conn, &active, now)?;
        }
        return Ok(());
    }

    let (Some(hero_id), Some(team_name)) = (snapshot.hero_id, snapshot.team_name.clone()) else {
        return Ok(()); // hero not picked yet this tick - ordinary intermediate state
    };
    if hero_id <= 0 {
        return Ok(());
    }

    let mut active = store::find_active_match(conn, session_local_id)?;

    if let Some(current) = &active {
        if is_same_match(current, snapshot, now) {
            store::resume_match(conn, &current.local_id, snapshot.match_id.as_deref(), hero_id)?;
            active = store::find_active_match(conn, session_local_id)?;
        } else {
            store::mark_needs_review(conn, &current.local_id)?;
            active = None;
        }
    }

    if active.is_none() {
        if snapshot.is_post_game() {
            // Already on the post-game screen with no active row: either
            // this match was already finalized and Dota keeps sending
            // ticks for the same screen, or Companion started mid-screen -
            // nothing reliable to start tracking from here (mirrors the
            // backend's identical guard).
            return Ok(());
        }
        store::create_match(conn, session_local_id, snapshot.match_id.as_deref(), hero_id, &team_name, ranked_mode, now)?;
        active = store::find_active_match(conn, session_local_id)?;
    }

    let Some(active) = active else { return Ok(()) }; // creation raced away - next tick picks it up

    if !snapshot.is_post_game() {
        return Ok(());
    }

    let observation = resolve_observation(snapshot, &team_name);
    match decide_post_game(active.state, active.result, observation) {
        PostGameDecision::TransitionToPending(result) => store::set_post_game(conn, &active.local_id, result),
        PostGameDecision::SetFirstObservation(result) => {
            store::set_post_game(conn, &active.local_id, Some(result))
        }
        PostGameDecision::FinalizeConfirmed => store::finalize_match(
            conn,
            &active.local_id,
            &active.session_local_id,
            active.ranked_mode,
            active.result.expect("FinalizeConfirmed only returned when a result exists"),
            "confirmed",
            now,
        ),
        PostGameDecision::MarkNeedsReview => store::mark_needs_review(conn, &active.local_id),
        PostGameDecision::NoOp => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::model::RankedMode;
    use crate::local_runtime::schema;
    use crate::local_runtime::store::{ensure_active_session, find_active_match};

    // WK-111's architectural boundary, by analogy with Game Sounds'
    // `playback_resolution_never_depends_on_backend_state`
    // (game_sounds/mod.rs): pins `is_same_match`/`decide_leave`/
    // `decide_post_game`'s signatures to accept only plain local data - no
    // `AppState`, no backend/HTTP client type, no `reqwest`. If a future
    // change tried to thread backend reachability into "did a match
    // happen"/"what's the detected delta", this would fail to compile
    // against the signatures asserted here, the same way the Game Sounds
    // test protects `resolve_playback`.
    #[test]
    fn match_transition_never_depends_on_backend_state() {
        fn _decide_leave_type_check(state: LocalMatchState, result: Option<MatchResult>) -> LeaveDecision {
            decide_leave(state, result)
        }
        fn _decide_post_game_type_check(
            state: LocalMatchState,
            current: Option<MatchResult>,
            observation: Option<MatchResult>,
        ) -> PostGameDecision {
            decide_post_game(state, current, observation)
        }
        fn _is_same_match_type_check(active: &LocalMatch, snapshot: &GsiSnapshot, now: DateTime<Utc>) -> bool {
            is_same_match(active, snapshot, now)
        }
        // The test body itself just needs to run - the pinning is the fact
        // that the above three functions compile with exactly these
        // signatures at all.
        assert_eq!(decide_leave(LocalMatchState::InProgress, None), LeaveDecision::MarkInterrupted);
    }

    #[test]
    fn post_game_first_tick_transitions_to_pending_even_without_a_resolved_winner() {
        assert_eq!(
            decide_post_game(LocalMatchState::InProgress, None, None),
            PostGameDecision::TransitionToPending(None)
        );
    }

    #[test]
    fn post_game_second_matching_observation_finalizes_as_confirmed() {
        assert_eq!(
            decide_post_game(LocalMatchState::PostGamePending, Some(MatchResult::Win), Some(MatchResult::Win)),
            PostGameDecision::FinalizeConfirmed
        );
    }

    #[test]
    fn post_game_conflicting_observations_go_to_needs_review() {
        assert_eq!(
            decide_post_game(LocalMatchState::PostGamePending, Some(MatchResult::Win), Some(MatchResult::Loss)),
            PostGameDecision::MarkNeedsReview
        );
    }

    #[test]
    fn leaving_mid_game_marks_interrupted_not_needs_review() {
        assert_eq!(decide_leave(LocalMatchState::InProgress, None), LeaveDecision::MarkInterrupted);
    }

    #[test]
    fn leaving_with_a_single_unconfirmed_observation_finalizes_as_probable() {
        assert_eq!(
            decide_leave(LocalMatchState::PostGamePending, Some(MatchResult::Win)),
            LeaveDecision::FinalizeProbable
        );
    }

    #[test]
    fn leaving_with_no_observation_at_all_goes_to_needs_review() {
        assert_eq!(decide_leave(LocalMatchState::PostGamePending, None), LeaveDecision::MarkNeedsReview);
    }

    fn tick(game_state: &str, hero_id: i64, team: &str, match_id: Option<&str>, win_team: Option<&str>) -> GsiSnapshot {
        GsiSnapshot {
            game_state: game_state.to_string(),
            activity: Some("playing".to_string()),
            custom_game_name: None,
            match_id: match_id.map(str::to_string),
            win_team: win_team.map(str::to_string),
            hero_id: Some(hero_id),
            team_name: Some(team.to_string()),
        }
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn full_lifecycle_hero_pick_through_confirmed_win_creates_exactly_one_finalized_match() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();

        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_HERO_SELECTION", 14, "radiant", Some("555"), None), now).unwrap();
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("555"), None), now).unwrap();
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_POST_GAME", 14, "radiant", Some("555"), Some("radiant")), now).unwrap();
        // Second confirming tick.
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_POST_GAME", 14, "radiant", Some("555"), Some("radiant")), now).unwrap();

        assert!(find_active_match(&conn, &session.local_id).unwrap().is_none());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let (state, result): (String, String) = conn
            .query_row("SELECT state, result FROM local_matches", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!(state, "finalized");
        assert_eq!(result, "win");
    }

    #[test]
    fn a_repeated_reconnect_snapshot_never_creates_a_duplicate_match() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();

        for _ in 0..5 {
            handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("777"), None), now).unwrap();
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1, "repeated identical ticks for the same match_id must not create duplicates");
    }

    #[test]
    fn disconnect_then_reconnect_within_the_window_resumes_the_same_match() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();

        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", None, None), now).unwrap();
        // Player leaves to the Dota menu - GSI stops reporting an in-match state.
        let menu_tick = GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_DISCONNECT".to_string(),
            activity: Some("menu".to_string()),
            custom_game_name: None,
            match_id: None,
            win_team: None,
            hero_id: None,
            team_name: None,
        };
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &menu_tick, now).unwrap();
        let (state,): (String,) =
            conn.query_row("SELECT state FROM local_matches", [], |row| Ok((row.get(0)?,))).unwrap();
        assert_eq!(state, "interrupted");

        // Reconnect a minute later, same team, no match_id on either side.
        let later = now + Duration::seconds(60);
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", None, None), later).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1, "a reconnect within the window must resume, not duplicate");
        let (state,): (String,) =
            conn.query_row("SELECT state FROM local_matches", [], |row| Ok((row.get(0)?,))).unwrap();
        assert_eq!(state, "in_progress");
    }

    #[test]
    fn a_new_match_starting_before_the_previous_one_resolved_sends_the_old_one_to_needs_review() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();

        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("1"), None), now).unwrap();
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_HERO_SELECTION", 8, "radiant", Some("2"), None), now).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
        let states: Vec<String> = {
            let mut stmt = conn.prepare("SELECT state FROM local_matches ORDER BY rowid ASC").unwrap();
            stmt.query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(states, vec!["needs_review".to_string(), "in_progress".to_string()]);
    }

    #[test]
    fn first_tick_after_restart_with_no_previous_snapshot_does_not_fabricate_a_leave() {
        // A brand new (freshly migrated) db with no prior match at all -
        // the very first tick a restarted Companion ever sees must not
        // treat "no active match found" as something to react to.
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        let menu_tick = GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_DISCONNECT".to_string(),
            activity: Some("menu".to_string()),
            custom_game_name: None,
            match_id: None,
            win_team: None,
            hero_id: None,
            team_name: None,
        };
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &menu_tick, now).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn ranked_mode_stays_unknown_by_default_so_no_delta_is_ever_fabricated() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("9"), None), now).unwrap();
        let active = find_active_match(&conn, &session.local_id).unwrap().unwrap();
        assert_eq!(active.ranked_mode, RankedMode::Unknown);
        assert_eq!(active.detected_rating_delta, None);
    }
}
