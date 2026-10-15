use chrono::{DateTime, Utc};
#[cfg(test)]
use chrono::Duration;
use rusqlite::Connection;
use super::gsi::GsiSnapshot;
use super::model::{LocalMatch, RankedMode};
use super::store;
use companion_dota_domain::match_shadow::{self as rules, Action, Context, MatchContext, SessionContext};
#[cfg(test)]
use super::model::{LocalMatchState, MatchResult};
#[cfg(test)]
use rules::{decide_leave, decide_post_game, LeaveDecision, PostGameDecision};
pub use rules::is_new_match_evidence;

pub fn match_context(active:&LocalMatch)->MatchContext {
    MatchContext {local_id:active.local_id.clone(),session_local_id:active.session_local_id.clone(),match_id:active.match_id.clone(),player_team:active.player_team.clone(),state:active.state,result:active.result,ranked_mode:active.ranked_mode,interrupted_at:active.interrupted_at.clone(),started_at:active.started_at.clone(),last_seen_at:active.last_seen_at.clone(),revision:None}
}
pub fn context(conn:&Connection,session:&str,mode:RankedMode,now:DateTime<Utc>)->rusqlite::Result<Context> {
    Ok(Context{frame_sequence:0,snapshot_identity:String::new(),captured_at:now,
        active:store::find_active_match(conn,session)?.as_ref().map(match_context),
        session:SessionContext{local_id:session.into(),ended:false,streamed:true},ranked_mode:mode,
        inconclusive_reason:None,timestamp_fallback:Utc::now()})
}
#[cfg(test)]
#[allow(dead_code)] // Signature compatibility pinned by the architectural test.
fn is_same_match(active:&LocalMatch,snapshot:&GsiSnapshot,now:DateTime<Utc>)->bool {
    rules::is_same_match(&match_context(active),snapshot,now,Utc::now())
}

/// Existing store operations and SQL ordering, driven by the shared pure decision plan.
pub fn handle_snapshot(conn:&mut Connection,session_local_id:&str,ranked_mode:RankedMode,snapshot:&GsiSnapshot,now:DateTime<Utc>)->rusqlite::Result<()> {
    let context=context(conn,session_local_id,ranked_mode,now)?;
    handle_snapshot_with_context(conn, session_local_id, snapshot, now, &context)
}
pub fn handle_snapshot_with_context(conn:&mut Connection,session_local_id:&str,snapshot:&GsiSnapshot,now:DateTime<Utc>,context:&Context)->rusqlite::Result<()> {
    let decision=rules::decide(context,snapshot);
    // Track the result of the same lookups as legacy, including INSERT OR IGNORE races.
    let mut current=context.active.as_ref().map(|a|a.local_id.clone());
    for action in decision.actions {
        match action {
            Action::UpdateTelemetry{local_id}=>store::update_match_telemetry(conn,&local_id,&snapshot.telemetry,now)?,
            Action::Interrupted{local_id}=>{store::mark_interrupted(conn,&local_id,now)?;current=None;},
            Action::NeedsReview{local_id}=>{store::mark_needs_review(conn,&local_id)?;current=None;},
            Action::Pending{local_id,result}=>store::set_post_game(conn,&local_id,result)?,
            Action::Finalize{local_id,session_local_id,ranked_mode,result,confidence}=>store::finalize_match(conn,&local_id,&session_local_id,ranked_mode,result,&confidence,now)?,
            Action::Resume{local_id,game_match_id,hero_id}=>{store::resume_match(conn,&local_id,game_match_id.as_deref(),hero_id)?;current=store::find_active_match(conn,session_local_id)?.map(|a|a.local_id);},
            Action::EnsureMatch{game_match_id,hero_id,player_team,ranked_mode}=>{
                if current.is_none(){store::create_match(conn,session_local_id,game_match_id.as_deref(),hero_id,&player_team,ranked_mode,now)?;current=store::find_active_match(conn,session_local_id)?.map(|a|a.local_id);}
            },
            Action::UpdateCurrentTelemetry=>if let Some(id)=&current{store::update_match_telemetry(conn,id,&snapshot.telemetry,now)?;},
        }
    }
    Ok(())
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
            telemetry: Default::default(),
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
    fn reduced_menu_post_game_payload_finalizes_the_existing_match() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Ranked, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("8123456789"), None), now).unwrap();

        let final_tick = GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_POST_GAME".to_string(),
            activity: Some("menu".to_string()),
            custom_game_name: None,
            match_id: Some("8123456789".to_string()),
            win_team: Some("radiant".to_string()),
            hero_id: None,
            team_name: None,
            telemetry: Default::default(),
        };
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Ranked, &final_tick, now).unwrap();
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Ranked, &final_tick, now).unwrap();

        assert!(find_active_match(&conn, &session.local_id).unwrap().is_none());
        let (state, result, delta): (String, String, i64) = conn
            .query_row("SELECT state, result, detected_rating_delta FROM local_matches", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!((state.as_str(), result.as_str(), delta), ("finalized", "win", 25));
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
            telemetry: Default::default(),
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

    // WK-146 - the flip side of
    // `a_new_match_starting_before_the_previous_one_resolved_sends_the_old_
    // one_to_needs_review`: when the OLD match was already stale (no GSI
    // activity for `watchdog::STALE_THRESHOLD`) at the moment the new,
    // distinct match tick arrives, that combination (staleness + strong
    // new-match corroborating evidence) is enough to auto-park it as the
    // existing MMR-neutral `interrupted` state instead of flagging it for
    // human review - see watchdog.rs's own doc comment for the full
    // decision model. Must never fabricate a result on the old row.
    #[test]
    fn a_new_distinct_match_arriving_after_the_old_one_went_stale_interrupts_it_instead_of_needs_review() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = ensure_active_session(&mut conn, now).unwrap();

        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("1"), None), now).unwrap();

        let stale_moment = now + companion_dota_domain::match_shadow::STALE_THRESHOLD + Duration::minutes(1);
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &tick("DOTA_GAMERULES_STATE_HERO_SELECTION", 8, "radiant", Some("2"), None), stale_moment).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
        let rows: Vec<(String, Option<String>)> = {
            let mut stmt = conn.prepare("SELECT state, result FROM local_matches ORDER BY rowid ASC").unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(rows[0], ("interrupted".to_string(), None), "a stale old match superseded by a genuinely new one must be parked as interrupted, not needs_review");
        assert_eq!(rows[1].0, "in_progress");
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
            telemetry: Default::default(),
        };
        handle_snapshot(&mut conn, &session.local_id, RankedMode::Unknown, &menu_tick, now).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn hero_picked_tick_is_new_match_evidence() {
        assert!(is_new_match_evidence(&tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("555"), None)));
    }

    #[test]
    fn hero_not_yet_picked_is_not_new_match_evidence() {
        let mut snapshot = tick("DOTA_GAMERULES_STATE_HERO_SELECTION", 0, "radiant", None, None);
        snapshot.hero_id = None;
        assert!(!is_new_match_evidence(&snapshot));
    }

    #[test]
    fn post_game_tick_is_not_new_match_evidence() {
        assert!(!is_new_match_evidence(&tick("DOTA_GAMERULES_STATE_POST_GAME", 14, "radiant", Some("555"), Some("radiant"))));
    }

    #[test]
    fn menu_tick_is_not_new_match_evidence() {
        let menu_tick = GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_DISCONNECT".to_string(),
            activity: Some("menu".to_string()),
            custom_game_name: None,
            match_id: None,
            win_team: None,
            hero_id: None,
            team_name: None,
            telemetry: Default::default(),
        };
        assert!(!is_new_match_evidence(&menu_tick));
    }

    #[test]
    fn custom_game_tick_is_not_new_match_evidence() {
        let mut snapshot = tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", 14, "radiant", Some("555"), None);
        snapshot.custom_game_name = Some("some_mod".to_string());
        assert!(!is_new_match_evidence(&snapshot));
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
