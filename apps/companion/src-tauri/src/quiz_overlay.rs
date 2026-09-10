use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

use crate::backend::{classify_status, record_connectivity, ConnectivitySignal};
use crate::broadcast_state::BroadcastState;
use crate::overlay_server::current;
use crate::state::{AppState, DEFAULT_BACKEND_URL};
use crate::storage;

// WK-116 - Between Matches quiz, Companion side. Two independent jobs, one
// background thread (same "one loop, not several timers" shape
// opendota_overlay_cache.rs already established):
//
//   1. Detect BroadcastState entering/leaving BetweenMatches and report it
//      to the backend as a sync event - this is what actually drives the
//      backend's round lifecycle (quiz-round-service.ts's
//      enterBetweenMatches/leaveBetweenMatches). Compared against the fully
//      RESOLVED scene (`overlay_server::current(app).scene`, i.e. after
//      session-ended/manual-override precedence), not the raw GSI-derived
//      one - the quiz must track exactly what a viewer's video shows, same
//      authority draft_reminder.rs and the OBS scene resolver already both
//      answer to.
//   2. While in BetweenMatches, poll the backend's current quiz round state
//      and cache it into AppState for overlay_server.rs's snapshot builder
//      to serve - Companion is the local renderer's only path to that data,
//      same "no Tauri IPC on the local renderer" reasoning as
//      opendota_overlay_cache.rs.
//
// Deliberately NOT the durable transactional-outbox pattern
// local_runtime::sync.rs uses for session/match events: those affect
// permanent MMR history, so losing one across a Companion crash would be a
// real data-loss bug. A missed between_matches_entered/left event has no
// such cost - the backend's round lifecycle is itself idempotent
// (leaveBetweenMatches cancelling an already-cancelled round is a no-op;
// enterBetweenMatches always starts fresh regardless of what was there
// before), and a fresh `last_scene: None` on every Companion restart
// naturally re-derives and reports the current state on the very next tick
// (see `scene_changed`'s "the very first snapshot always counts as a
// change" precedent in overlay_server.rs). A simple fire-and-forget POST,
// retried by the next tick's transition check if it silently failed, is
// proportionate here.
const POLL_INTERVAL: Duration = Duration::from_millis(2000);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub fn init(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_scene: Option<BroadcastState> = None;
        loop {
            tick(&app, &mut last_scene);
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Pure transition detection, factored out for direct testing (same
/// reasoning as overlay_server.rs's own `scene_changed`): `(entered_between_
/// matches, left_between_matches)`. A `None` last_scene (this thread's very
/// first tick, including right after a Companion restart) DOES count as
/// "entered" if the resolved scene is already BetweenMatches - same "the
/// very first observation always counts as a change" precedent
/// `scene_changed` already established, and the only choice that keeps the
/// quiz self-healing after a restart: the backend has no independent way to
/// know Companion is back, it only ever learns this scene from these
/// events. Reporting "entered" again when a round happens to already be
/// active server-side is harmless - enterBetweenMatches's own fresh-round
/// semantics handle that idempotently (see quiz-round-service.ts), at the
/// cost of restarting whatever question was in flight - an acceptable
/// trade-off for a rare Companion-restart-mid-round edge case.
fn scene_transition(last_scene: Option<BroadcastState>, scene: BroadcastState) -> (bool, bool) {
    let entered = scene == BroadcastState::BetweenMatches && last_scene != Some(BroadcastState::BetweenMatches);
    let left = scene != BroadcastState::BetweenMatches && last_scene == Some(BroadcastState::BetweenMatches);
    (entered, left)
}

fn tick<R: Runtime>(app: &AppHandle<R>, last_scene: &mut Option<BroadcastState>) {
    let token = app.state::<AppState>().0.lock().unwrap().companion_token.clone();
    let Some(token) = token else { return };

    let scene = current(app).scene;
    let (entered_between_matches, left_between_matches) = scene_transition(*last_scene, scene);
    *last_scene = Some(scene);

    if entered_between_matches {
        send_sync_event(app, &token, "between_matches_entered");
        storage::append_rolling_log(app, "Quiz: Between Matches entered - reporting to backend.");
    }
    if left_between_matches {
        send_sync_event(app, &token, "between_matches_left");
        storage::append_rolling_log(app, "Quiz: Between Matches left - reporting to backend.");
        // Don't wait for the next poll response to clear stale quiz
        // content - the visible board should disappear the same moment the
        // scene itself does, not up to POLL_INTERVAL later.
        app.state::<AppState>().0.lock().unwrap().quiz = None;
    }

    if scene == BroadcastState::BetweenMatches {
        match fetch_quiz_state(&token) {
            Ok(value) => app.state::<AppState>().0.lock().unwrap().quiz = value,
            // Transient failure - keep whatever was cached (avoids a flicker
            // to "no quiz" on a single dropped request); the next tick tries
            // again, same stance opendota_overlay_cache.rs already takes.
            Err(_) => {}
        }
    }
}

fn send_sync_event<R: Runtime>(app: &AppHandle<R>, token: &str, event_type: &str) {
    let body = serde_json::json!({
        "eventId": Uuid::new_v4().to_string(),
        "eventType": event_type,
        "payload": {},
    });
    let client = match reqwest::blocking::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return,
    };
    let response = client
        .post(format!("{DEFAULT_BACKEND_URL}/stream/companion/sync/events"))
        .bearer_auth(token)
        .json(&body)
        .send();
    match response {
        Ok(response) => record_connectivity(app, "quiz-sync-event", classify_status(response.status())),
        Err(error) => record_connectivity(app, "quiz-sync-event", ConnectivitySignal::Transient(error.to_string())),
    }
}

fn fetch_quiz_state(token: &str) -> Result<Option<serde_json::Value>, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/quiz/state"))
        .bearer_auth(token)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    let body: serde_json::Value = response.json().map_err(|error| error.to_string())?;
    // `{ quiz: null }` (no active round) and `{ quiz: {...} }` both parse
    // fine here - either way this becomes InnerState.quiz's new value,
    // which is what overlay_server.rs's snapshot builder serves back as-is.
    Ok(body.get("quiz").cloned())
}

// Forwards Companion-measured answer-button geometry (real DOM rects,
// normalized against the video canvas by the React renderer - see
// overlay-renderer/between-matches/quiz/geometry-contract.ts) to the
// authenticated backend endpoint. Called from overlay_server.rs's local
// `POST /overlay/quiz-geometry` handler, which is the ONLY way the local
// renderer (no Tauri IPC, no companion_token of its own) can reach the real
// backend - see that handler's own doc comment.
pub fn publish_geometry<R: Runtime>(app: &AppHandle<R>, body: serde_json::Value) -> Result<bool, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Companion не подключён к аккаунту.".to_string())?;
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .put(format!("{DEFAULT_BACKEND_URL}/stream/companion/quiz/geometry"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    let parsed: serde_json::Value = response.json().map_err(|error| error.to_string())?;
    Ok(parsed.get("applied").and_then(serde_json::Value::as_bool).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_tick_ever_entering_between_matches_counts_as_entered() {
        let (entered, left) = scene_transition(None, BroadcastState::BetweenMatches);
        assert!(entered, "a fresh thread start already in Between Matches must self-heal, not wait for a real transition");
        assert!(!left);
    }

    #[test]
    fn first_tick_ever_in_gameplay_reports_neither() {
        let (entered, left) = scene_transition(None, BroadcastState::Gameplay);
        assert!(!entered);
        assert!(!left);
    }

    #[test]
    fn gameplay_to_between_matches_is_entered_only() {
        let (entered, left) = scene_transition(Some(BroadcastState::Gameplay), BroadcastState::BetweenMatches);
        assert!(entered);
        assert!(!left);
    }

    #[test]
    fn between_matches_to_gameplay_is_left_only() {
        let (entered, left) = scene_transition(Some(BroadcastState::BetweenMatches), BroadcastState::Gameplay);
        assert!(!entered);
        assert!(left);
    }

    #[test]
    fn between_matches_to_draft_is_still_left_between_matches() {
        // Draft is not Gameplay, but it's also not BetweenMatches - leaving
        // must fire regardless of which non-BetweenMatches state it's now.
        let (entered, left) = scene_transition(Some(BroadcastState::BetweenMatches), BroadcastState::Draft);
        assert!(!entered);
        assert!(left);
    }

    #[test]
    fn staying_in_between_matches_reports_neither_on_every_subsequent_tick() {
        let (entered, left) = scene_transition(Some(BroadcastState::BetweenMatches), BroadcastState::BetweenMatches);
        assert!(!entered);
        assert!(!left);
    }

    #[test]
    fn staying_outside_between_matches_reports_neither() {
        let (entered, left) = scene_transition(Some(BroadcastState::Gameplay), BroadcastState::Draft);
        assert!(!entered);
        assert!(!left);
    }

    #[test]
    fn post_stream_leaving_between_matches_still_fires_left() {
        let (entered, left) = scene_transition(Some(BroadcastState::BetweenMatches), BroadcastState::PostStream);
        assert!(!entered);
        assert!(left, "ending the stream mid-round must still cancel the active round, not leave it dangling");
    }
}
