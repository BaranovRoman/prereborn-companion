use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::broadcast_state::BroadcastState;
use crate::state::AppState;
use crate::storage;

// WK-136 - "Стрим не запущен": Companion can independently confirm Draft has
// begun (GSI) and that OBS is confirmed NOT streaming (obs.rs's always-on
// stream-state watcher, WK-112/WK-116), the exact moment a streamer who
// forgot to press Start Streaming needs to be told. Deliberately its own
// tiny isolated GSI consumer (added to server/mod.rs's existing 3-way
// fan-out - obs::handle_gsi/game_sounds::handle_gsi/local_runtime::handle_gsi
// - as a 4th, same isolation), NOT folded into obs.rs, because the two
// existing OBS-adjacent signals in obs.rs are both the wrong shape for this:
//
//   - `obs_active_scene`/schedule_switch only updates when OBS automatic
//     scene-switching is enabled (`schedule_switch`'s `require_enabled`
//     check) and a socket round-trip to OBS actually succeeds - it would
//     silently never fire in manual-scene mode, which the acceptance
//     criteria explicitly requires this reminder to keep working in.
//   - `local_runtime`'s match lifecycle state machine has no Draft/pre-match
//     phase concept at all - a LocalMatch doesn't exist yet during Draft.
//
// So this reads the two fields that ARE unconditional: `obs_watcher_connected`
// and `obs_streaming` (both written by obs.rs's start_stream_state_watcher,
// which runs regardless of `obs_config.enabled` - see that function's own
// WK-116 doc comment). No second Draft detector is created - `should_fire`
// consumes the same `BroadcastState::from_gsi` the rest of the app already
// uses (broadcast_state.rs), it just also tracks the one bit of "was the
// previous tick already Draft" state this decision needs and nothing else
// in the app currently exposes.
pub const DRAFT_STREAM_NOT_STARTED_EVENT: &str = "reminders://draft-stream-not-started";

/// Pure decision: should the reminder fire on this tick? Fires only on a
/// fresh non-Draft -> Draft transition, while OBS's stream-state watcher is
/// currently connected AND has confirmed OBS is not streaming.
///
/// `obs_streaming` deliberately keeps its last known value across a watcher
/// disconnect (see obs.rs's start_stream_state_watcher: "does NOT touch...
/// losing this connection alone must never end a session") - so a stale
/// `Some(false)` from before a disconnect must NOT be trusted once the
/// watcher itself is down, which is exactly why `obs_watcher_connected` is
/// checked here too, not `obs_streaming` alone. `None` (never yet confirmed)
/// and `Some(true)` (confirmed streaming) both correctly fall through to
/// "don't fire" via the `== Some(false)` comparison.
fn should_fire(
    previous: Option<BroadcastState>,
    current: BroadcastState,
    obs_watcher_connected: bool,
    obs_streaming: Option<bool>,
) -> bool {
    let entered_draft = current == BroadcastState::Draft && previous != Some(BroadcastState::Draft);
    entered_draft && obs_watcher_connected && obs_streaming == Some(false)
}

// Generic over R: Runtime (mirrors local_runtime::handle_gsi) so this can be
// exercised in tests against tauri::test::mock_app()'s MockRuntime, not just
// the real Wry runtime the concrete `AppHandle` alias implies.
pub fn handle_gsi<R: Runtime>(app: &AppHandle<R>, payload: &Value) {
    let current = BroadcastState::from_gsi(payload);

    let should_emit = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        let previous = inner.draft_reminder_last_state;

        let fire = !inner.draft_reminder_fired
            && should_fire(previous, current, inner.obs_watcher_connected, inner.obs_streaming);

        // Deterministic re-arm rule (WK-136 acceptance): leaving Draft for
        // any other state clears the latch, so the next real Draft entry -
        // i.e. the next match - can fire again. Checked BEFORE latching a
        // fresh fire below so entering Draft and firing in the same tick
        // doesn't immediately un-fire itself.
        if current != BroadcastState::Draft {
            inner.draft_reminder_fired = false;
        }
        if fire {
            inner.draft_reminder_fired = true;
        }
        inner.draft_reminder_last_state = Some(current);
        fire
    };

    if should_emit {
        let _ = app.emit(DRAFT_STREAM_NOT_STARTED_EVENT, ());
        storage::append_rolling_log(
            app,
            "Draft entered while OBS confirmed not streaming - played local 'stream not started' reminder.",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // WK-136 acceptance: OBS streaming before Draft -> no reminder.
    #[test]
    fn does_not_fire_while_obs_is_confirmed_streaming() {
        assert!(!should_fire(Some(BroadcastState::BetweenMatches), BroadcastState::Draft, true, Some(true)));
    }

    // WK-136 acceptance: OBS inactive -> enter Draft -> one reminder.
    #[test]
    fn fires_on_entering_draft_while_obs_confirmed_not_streaming() {
        assert!(should_fire(Some(BroadcastState::BetweenMatches), BroadcastState::Draft, true, Some(false)));
    }

    #[test]
    fn fires_from_gameplay_into_a_fresh_draft_too() {
        // Only realistic if GSI briefly showed Gameplay from a stale/aborted
        // previous match tick, but the transition rule itself doesn't care
        // what the previous state was, only that it wasn't already Draft.
        assert!(should_fire(Some(BroadcastState::Gameplay), BroadcastState::Draft, true, Some(false)));
    }

    #[test]
    fn fires_on_the_very_first_tick_with_no_previous_state() {
        assert!(should_fire(None, BroadcastState::Draft, true, Some(false)));
    }

    // WK-136 acceptance: repeated GSI ticks in the same Draft -> no repeat.
    #[test]
    fn does_not_fire_again_while_still_in_draft() {
        assert!(!should_fire(Some(BroadcastState::Draft), BroadcastState::Draft, true, Some(false)));
    }

    // WK-136 acceptance: Draft -> Gameplay -> no repeat (never fires outside Draft at all).
    #[test]
    fn never_fires_for_non_draft_current_states() {
        for current in [BroadcastState::BetweenMatches, BroadcastState::Gameplay, BroadcastState::PostStream] {
            assert!(!should_fire(Some(BroadcastState::Draft), current, true, Some(false)));
        }
    }

    // WK-136 acceptance: OBS unknown/disconnected -> no false reminder.
    #[test]
    fn does_not_fire_when_streaming_truth_was_never_confirmed() {
        assert!(!should_fire(Some(BroadcastState::BetweenMatches), BroadcastState::Draft, true, None));
    }

    // WK-136 acceptance: the stream-state watcher itself being disconnected
    // must never be read as "confirmed not streaming", even if the last
    // value it observed before disconnecting was Some(false) - see this
    // module's doc comment on why obs_streaming can be stale.
    #[test]
    fn does_not_fire_when_the_watcher_is_disconnected_even_with_a_stale_not_streaming_value() {
        assert!(!should_fire(Some(BroadcastState::BetweenMatches), BroadcastState::Draft, false, Some(false)));
    }

    // WK-136 acceptance: scene automation being disabled must have no effect
    // on this decision at all - should_fire's signature doesn't even accept
    // an `enabled` parameter, so this is a compile-time guarantee, pinned
    // here the same way broadcast_state.rs pins its own equivalent.
    #[test]
    fn should_fire_has_no_obs_automation_enabled_parameter_at_all() {
        fn _type_check(previous: Option<BroadcastState>, current: BroadcastState, obs_watcher_connected: bool, obs_streaming: Option<bool>) -> bool {
            should_fire(previous, current, obs_watcher_connected, obs_streaming)
        }
        assert!(should_fire(Some(BroadcastState::BetweenMatches), BroadcastState::Draft, true, Some(false)));
    }

    // WK-136 acceptance: next real match, Draft while still not streaming ->
    // can fire again. Simulates the full tick sequence handle_gsi would see
    // via should_fire + the same latch/reset rules handle_gsi applies,
    // without needing an AppHandle.
    #[test]
    fn resets_after_leaving_draft_so_the_next_draft_can_fire_again() {
        let mut fired = false;
        let mut previous: Option<BroadcastState> = None;

        // Tick 1: enters Draft, not streaming -> fires.
        let current = BroadcastState::Draft;
        let should = !fired && should_fire(previous, current, true, Some(false));
        if current != BroadcastState::Draft { fired = false; }
        if should { fired = true; }
        previous = Some(current);
        assert!(should);
        assert!(fired);

        // Tick 2: still Draft -> must not re-fire.
        let current = BroadcastState::Draft;
        let should = !fired && should_fire(previous, current, true, Some(false));
        if current != BroadcastState::Draft { fired = false; }
        if should { fired = true; }
        previous = Some(current);
        assert!(!should);

        // Tick 3: leaves Draft for Gameplay -> latch resets, still no fire (not Draft).
        let current = BroadcastState::Gameplay;
        let should = !fired && should_fire(previous, current, true, Some(false));
        if current != BroadcastState::Draft { fired = false; }
        if should { fired = true; }
        previous = Some(current);
        assert!(!should);
        assert!(!fired);

        // Tick 4: a new match's Draft begins, still not streaming -> fires again.
        let current = BroadcastState::Draft;
        let should = !fired && should_fire(previous, current, true, Some(false));
        assert!(should);
    }

    // Real-entry-point integration coverage (mirrors local_runtime/mod.rs's
    // real_gsi_entrypoint_* tests: exercising the actual `handle_gsi` fn
    // against a real (mocked) AppHandle/AppState, not just the pure
    // should_fire logic above in isolation - the same "exercise the real
    // entry point" principle that file's own doc comment credits with
    // catching a prior wiring bug pure-function tests alone had missed).
    // Reminder side effects are observed via InnerState (draft_reminder_fired/
    // draft_reminder_last_state), since this codebase has no existing
    // pattern for asserting on an emitted Tauri event in a unit test.
    fn draft_tick() -> serde_json::Value {
        serde_json::json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_HERO_SELECTION" },
            "player": { "activity": "playing" },
        })
    }

    fn gameplay_tick() -> serde_json::Value {
        serde_json::json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
            "player": { "activity": "playing" },
        })
    }

    #[test]
    fn real_entrypoint_fires_exactly_once_for_repeated_draft_ticks_while_not_streaming() {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.obs_watcher_connected = true;
            inner.obs_streaming = Some(false);
        }
        let handle = app.handle();

        handle_gsi(handle, &draft_tick());
        handle_gsi(handle, &draft_tick());
        handle_gsi(handle, &draft_tick());

        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        assert!(inner.draft_reminder_fired, "must have latched after the first Draft tick");
        assert_eq!(inner.draft_reminder_last_state, Some(BroadcastState::Draft));
    }

    #[test]
    fn real_entrypoint_stays_silent_while_obs_watcher_is_disconnected() {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.obs_watcher_connected = false;
            inner.obs_streaming = Some(false); // stale value from before a disconnect
        }
        let handle = app.handle();

        handle_gsi(handle, &draft_tick());

        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        assert!(!inner.draft_reminder_fired);
    }

    #[test]
    fn real_entrypoint_rearms_after_leaving_draft_for_the_next_match() {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.obs_watcher_connected = true;
            inner.obs_streaming = Some(false);
        }
        let handle = app.handle();

        handle_gsi(handle, &draft_tick()); // match 1 draft - fires
        handle_gsi(handle, &gameplay_tick()); // match 1 played - latch resets
        {
            let state = app.state::<AppState>();
            assert!(!state.0.lock().unwrap().draft_reminder_fired, "must reset on leaving Draft");
        }

        handle_gsi(handle, &draft_tick()); // match 2 draft - fires again
        let state = app.state::<AppState>();
        assert!(state.0.lock().unwrap().draft_reminder_fired);
    }
}
