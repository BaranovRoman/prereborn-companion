// WK-112 - OBS-driven stream lifecycle. Turns "OBS is/isn't streaming"
// (learned by obs.rs's stream-state watcher, see `on_obs_streaming_known`
// below) into LocalSession open/pending-end/ended transitions, so a normal
// stream no longer requires clicking Start/Continue/End in Companion.
//
// Backend-independence boundary (mirrors WK-111's
// `match_transition_never_depends_on_backend_state`): every decision in
// this module is a pure function of (local session state, OBS streaming
// truth, current time) - see `decide`/`is_stale` and the regression test
// `stream_lifecycle_never_depends_on_backend_state` below. Nothing here
// reads `AppState.companion_token`/`backend_*` fields or performs a network
// call - see `reconcile`, the only place these decisions are applied, which
// touches only the local SQLite connection and (for the *effect* of an
// ended session on OBS scene automation) `obs::handle_session_state`, which
// is itself local (no backend call - see obs.rs).

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::model::LocalSession;
use super::store;
use super::LocalRuntimeState;

/// Grace period after OBS reports "not streaming" before a session is
/// actually ended - protects against a brief OBS/RTMP hiccup or a quick
/// OBS restart being mistaken for the end of the stream.
pub const GRACE_PERIOD: Duration = Duration::seconds(30);

/// An open session older than this is treated as ambiguous rather than
/// silently continued or silently ended - see `is_stale`.
pub const STALE_THRESHOLD: Duration = Duration::hours(12);

/// How often the sweep tick re-checks a pending-end session against the
/// grace period, so "OBS stopped and nothing else ever happens again"
/// still finalizes the session without needing a second OBS event.
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

pub struct SessionLifecycleView {
    pub local_id: String,
    pub started_at: DateTime<Utc>,
    pub pending_end_at: Option<DateTime<Utc>>,
    pub stale_ack: bool,
}

impl SessionLifecycleView {
    fn from_session(session: &LocalSession) -> Option<Self> {
        Some(Self {
            local_id: session.local_id.clone(),
            started_at: parse_rfc3339(&session.started_at)?,
            pending_end_at: session.pending_end_at.as_deref().and_then(parse_rfc3339),
            stale_ack: session.stale_ack,
        })
    }
}

fn parse_rfc3339(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|dt| dt.with_timezone(&Utc))
}

/// An open session is "stale" - too ambiguous to auto-continue or
/// auto-end - once it's older than `STALE_THRESHOLD` and the user hasn't
/// already confirmed it via manual recovery (`stale_ack`). Independent of
/// current OBS streaming truth by design: a days-old open session is
/// suspicious regardless of what OBS happens to be doing right now, and
/// this must stay readable (for the recovery-status UI) even when OBS
/// itself is unreachable - see `status` below.
pub fn is_stale(session: &SessionLifecycleView, now: DateTime<Utc>) -> bool {
    !session.stale_ack && now.signed_duration_since(session.started_at) > STALE_THRESHOLD
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleDecision {
    NoOp,
    StartNewSession,
    ContinueSession,
    CancelPendingEnd,
    BeginPendingEnd,
    FinalizeEnd,
    FlagStaleForManualRecovery,
}

/// The one decision function this whole feature adds. Pure: local session
/// state + OBS's own streaming truth + current time in, one decision out -
/// no I/O, no backend/network type can be threaded into this signature by
/// construction. See `stream_lifecycle_never_depends_on_backend_state`.
pub fn decide(
    open_session: Option<&SessionLifecycleView>,
    streaming: bool,
    now: DateTime<Utc>,
) -> LifecycleDecision {
    decide_with(open_session, streaming, now, GRACE_PERIOD)
}

fn decide_with(
    open_session: Option<&SessionLifecycleView>,
    streaming: bool,
    now: DateTime<Utc>,
    grace: Duration,
) -> LifecycleDecision {
    let Some(session) = open_session else {
        return if streaming { LifecycleDecision::StartNewSession } else { LifecycleDecision::NoOp };
    };

    if is_stale(session, now) {
        return LifecycleDecision::FlagStaleForManualRecovery;
    }

    match (streaming, session.pending_end_at) {
        (true, Some(_)) => LifecycleDecision::CancelPendingEnd,
        (true, None) => LifecycleDecision::ContinueSession,
        (false, None) => LifecycleDecision::BeginPendingEnd,
        (false, Some(pending_since)) => {
            if now.signed_duration_since(pending_since) >= grace {
                LifecycleDecision::FinalizeEnd
            } else {
                LifecycleDecision::NoOp
            }
        }
    }
}

/// Applies one `decide` outcome: commits the transition to SQLite FIRST,
/// then (only for the two transitions that change whether the session is
/// ended) applies the local OBS side effect via `obs::handle_session_state`
/// - never the other way around, so the UI/OBS scene can never observe
/// "ended" while SQLite still says the session is open, or vice versa.
fn apply(app: &AppHandle, conn: &Connection, open_session: Option<&SessionLifecycleView>, decision: LifecycleDecision, now: DateTime<Utc>) {
    match decision {
        LifecycleDecision::NoOp | LifecycleDecision::FlagStaleForManualRecovery => {}
        LifecycleDecision::StartNewSession => {
            if let Err(error) = store::ensure_active_session(conn, now) {
                log_error(app, "ensure_active_session", &error);
                return;
            }
            crate::obs::handle_session_state(app, false);
        }
        LifecycleDecision::ContinueSession => {
            crate::obs::handle_session_state(app, false);
        }
        LifecycleDecision::CancelPendingEnd => {
            let Some(session) = open_session else { return };
            if let Err(error) = store::cancel_pending_end(conn, &session.local_id) {
                log_error(app, "cancel_pending_end", &error);
                return;
            }
            crate::obs::handle_session_state(app, false);
        }
        LifecycleDecision::BeginPendingEnd => {
            let Some(session) = open_session else { return };
            if let Err(error) = store::begin_pending_end(conn, &session.local_id, now) {
                log_error(app, "begin_pending_end", &error);
            }
            // Deliberately no `obs::handle_session_state` call here - the
            // session is only a CANDIDATE to end during the grace window,
            // scene automation must keep behaving as if the stream is
            // still active (see the ticket's "не завершать session
            // мгновенно").
        }
        LifecycleDecision::FinalizeEnd => {
            let Some(session) = open_session else { return };
            if let Err(error) = store::finalize_session_end(conn, &session.local_id, now) {
                log_error(app, "finalize_session_end", &error);
                return;
            }
            crate::obs::handle_session_state(app, true);
        }
    }
}

fn log_error(app: &AppHandle, op: &str, error: &rusqlite::Error) {
    crate::storage::append_rolling_log(app, &format!("Local lifecycle: {op} failed ({error})"));
}

/// The single entry point every trigger (initial `GetStreamStatus`, a live
/// `StreamStateChanged` event, a reconnect, and the periodic sweep tick)
/// funnels through - one decision path, so "repeated events never create
/// duplicate sessions" and "sweep vs event race" are the same guarantee,
/// not two separately-maintained ones.
pub fn reconcile(app: &AppHandle, streaming: bool, now: DateTime<Utc>) {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return };

    let open = match store::find_open_session(conn) {
        Ok(session) => session,
        Err(error) => {
            log_error(app, "find_open_session", &error);
            return;
        }
    };
    let view = open.as_ref().and_then(SessionLifecycleView::from_session);
    let decision = decide(view.as_ref(), streaming, now);
    apply(app, conn, view.as_ref(), decision, now);
}

/// Called by obs.rs's stream-state watcher whenever it learns OBS's actual
/// streaming truth - the initial `GetStreamStatus` right after connecting
/// (including every reconnect), and every `StreamStateChanged` event.
/// Records the value (so the sweep tick and the status query below have
/// something to read even between watcher callbacks) and immediately
/// reconciles against it.
pub fn on_obs_streaming_known(app: &AppHandle, streaming: bool) {
    {
        let state = app.state::<crate::state::AppState>();
        state.0.lock().unwrap().obs_streaming = Some(streaming);
    }
    reconcile(app, streaming, Utc::now());
}

/// Starts the periodic sweep - the only thing that can finalize a
/// pending-end session when no further OBS event ever arrives (OBS stays
/// stopped, so there is nothing to react to at exactly the 30s mark).
/// Re-reconciles using the last known OBS streaming truth; a complete no-op
/// (`obs_streaming` still `None`) until the watcher has learned it at least
/// once, per the same "never guess OBS's state" rule the watcher itself
/// follows.
pub fn start_sweep(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SWEEP_INTERVAL);
        let streaming = {
            let state = app.state::<crate::state::AppState>();
            let value = state.0.lock().unwrap().obs_streaming;
            value
        };
        if let Some(streaming) = streaming {
            reconcile(&app, streaming, Utc::now());
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleSessionState {
    None,
    Open,
    PendingEnd,
    NeedsManualRecovery,
}

// WK-112 - field names deliberately left as plain Rust snake_case (no
// `rename_all = "camelCase"`), matching `StatusSnapshot` in state.rs, which
// this struct is the sibling of on the frontend - see e.g. `status.gsi_state`
// usages in AppShell.tsx.
#[derive(Debug, Clone, Serialize)]
pub struct LifecycleStatus {
    pub session_state: LifecycleSessionState,
    pub session_started_at: Option<String>,
    pub pending_end_at: Option<String>,
    pub obs_streaming: Option<bool>,
}

/// Read-only status for the frontend (see commands.rs). Deliberately
/// recomputes staleness directly from the open session's own age, not from
/// `decide()` - this must report `NeedsManualRecovery` even when OBS's
/// streaming truth is currently unknown (e.g. OBS unreachable at startup),
/// since a suspiciously old open session is worth surfacing regardless of
/// whatever OBS is doing right now.
pub fn status(app: &AppHandle) -> LifecycleStatus {
    let obs_streaming = app.state::<crate::state::AppState>().0.lock().unwrap().obs_streaming;
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else {
        return LifecycleStatus {
            session_state: LifecycleSessionState::None,
            session_started_at: None,
            pending_end_at: None,
            obs_streaming,
        };
    };
    let open = store::find_open_session(conn).ok().flatten();
    let Some(session) = open else {
        return LifecycleStatus {
            session_state: LifecycleSessionState::None,
            session_started_at: None,
            pending_end_at: None,
            obs_streaming,
        };
    };
    let view = SessionLifecycleView::from_session(&session);
    let now = Utc::now();
    let session_state = match &view {
        Some(view) if is_stale(view, now) => LifecycleSessionState::NeedsManualRecovery,
        Some(view) if view.pending_end_at.is_some() => LifecycleSessionState::PendingEnd,
        _ => LifecycleSessionState::Open,
    };
    LifecycleStatus {
        session_state,
        session_started_at: Some(session.started_at.clone()),
        pending_end_at: session.pending_end_at.clone(),
        obs_streaming,
    }
}

/// Manual stale-recovery action: "continue this session" - clears the flag
/// so it stops being reported as stale, and lets normal OBS-driven
/// reconciliation resume for it from here on.
pub fn stale_recovery_continue(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return Err("Local runtime is not available".into()) };
    let Some(session) = store::find_open_session(conn).map_err(|e| e.to_string())? else {
        return Err("No open session to continue".into());
    };
    store::acknowledge_stale(conn, &session.local_id).map_err(|e| e.to_string())
}

/// Manual stale-recovery action: "end this session". Always ends the old
/// session; if OBS is *currently* known to be streaming, immediately
/// reconciles afterward so a fresh session starts right away instead of
/// waiting for the next independent OBS event - this is what makes "end
/// and start a new one" and "end without a new one" the same underlying
/// action, driven by OBS's real current state rather than a separate user
/// choice (see WK-112's product decisions).
pub fn stale_recovery_end(app: &AppHandle) -> Result<(), String> {
    let now = Utc::now();
    {
        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let Some(conn) = guard.as_mut() else { return Err("Local runtime is not available".into()) };
        let Some(session) = store::find_open_session(conn).map_err(|e| e.to_string())? else {
            return Err("No open session to end".into());
        };
        store::finalize_session_end(conn, &session.local_id, now).map_err(|e| e.to_string())?;
    }
    crate::obs::handle_session_state(app, true);
    let streaming = app.state::<crate::state::AppState>().0.lock().unwrap().obs_streaming;
    if let Some(streaming) = streaming {
        reconcile(app, streaming, now);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(started_at: DateTime<Utc>, pending_end_at: Option<DateTime<Utc>>, stale_ack: bool) -> SessionLifecycleView {
        SessionLifecycleView { local_id: "s1".into(), started_at, pending_end_at, stale_ack }
    }

    // WK-112's architectural boundary, by direct analogy with WK-111's
    // match_transition_never_depends_on_backend_state and Game Sounds'
    // playback_resolution_never_depends_on_backend_state: pins `decide`'s
    // signature to plain local data only - no AppState, no backend/HTTP
    // client type, no companion_token. If a future change tried to gate a
    // lifecycle decision on backend reachability, it would not compile
    // against the signature asserted here.
    #[test]
    fn stream_lifecycle_never_depends_on_backend_state() {
        fn _type_check(
            open_session: Option<&SessionLifecycleView>,
            streaming: bool,
            now: DateTime<Utc>,
        ) -> LifecycleDecision {
            decide(open_session, streaming, now)
        }
        let now = Utc::now();
        assert_eq!(decide(None, true, now), LifecycleDecision::StartNewSession);
    }

    #[test]
    fn no_open_session_and_not_streaming_does_nothing() {
        assert_eq!(decide(None, false, Utc::now()), LifecycleDecision::NoOp);
    }

    #[test]
    fn no_open_session_and_streaming_starts_a_new_one() {
        assert_eq!(decide(None, true, Utc::now()), LifecycleDecision::StartNewSession);
    }

    #[test]
    fn open_session_still_streaming_just_continues() {
        let now = Utc::now();
        let session = view(now - Duration::minutes(10), None, false);
        assert_eq!(decide(Some(&session), true, now), LifecycleDecision::ContinueSession);
    }

    #[test]
    fn stop_streaming_begins_the_pending_end_countdown_not_an_instant_end() {
        let now = Utc::now();
        let session = view(now - Duration::minutes(10), None, false);
        assert_eq!(decide(Some(&session), false, now), LifecycleDecision::BeginPendingEnd);
    }

    #[test]
    fn streaming_again_within_grace_cancels_the_pending_end() {
        let now = Utc::now();
        let pending_since = now - Duration::seconds(10);
        let session = view(now - Duration::minutes(10), Some(pending_since), false);
        assert_eq!(decide(Some(&session), true, now), LifecycleDecision::CancelPendingEnd);
    }

    #[test]
    fn still_within_grace_and_not_streaming_does_nothing_yet() {
        let now = Utc::now();
        let pending_since = now - Duration::seconds(10);
        let session = view(now - Duration::minutes(10), Some(pending_since), false);
        assert_eq!(decide(Some(&session), false, now), LifecycleDecision::NoOp);
    }

    #[test]
    fn grace_elapsed_and_still_not_streaming_finalizes_the_end() {
        let now = Utc::now();
        let pending_since = now - Duration::seconds(31);
        let session = view(now - Duration::minutes(10), Some(pending_since), false);
        assert_eq!(decide(Some(&session), false, now), LifecycleDecision::FinalizeEnd);
    }

    #[test]
    fn exactly_at_the_grace_boundary_finalizes() {
        let now = Utc::now();
        let pending_since = now - Duration::seconds(30);
        let session = view(now - Duration::minutes(10), Some(pending_since), false);
        assert_eq!(decide(Some(&session), false, now), LifecycleDecision::FinalizeEnd);
    }

    #[test]
    fn a_session_older_than_the_stale_threshold_is_flagged_regardless_of_streaming_state() {
        let now = Utc::now();
        let ancient = view(now - Duration::hours(13), None, false);
        assert_eq!(decide(Some(&ancient), true, now), LifecycleDecision::FlagStaleForManualRecovery);
        assert_eq!(decide(Some(&ancient), false, now), LifecycleDecision::FlagStaleForManualRecovery);
    }

    #[test]
    fn a_stale_session_that_was_already_acknowledged_behaves_normally_again() {
        let now = Utc::now();
        let acknowledged = view(now - Duration::hours(13), None, true);
        assert_eq!(decide(Some(&acknowledged), true, now), LifecycleDecision::ContinueSession);
    }

    #[test]
    fn exactly_at_the_stale_boundary_is_not_yet_stale() {
        let now = Utc::now();
        let session = view(now - Duration::hours(12), None, false);
        assert_eq!(decide(Some(&session), true, now), LifecycleDecision::ContinueSession);
    }

    #[test]
    fn is_stale_ignores_streaming_state_entirely() {
        let now = Utc::now();
        let ancient = view(now - Duration::hours(20), None, false);
        assert!(is_stale(&ancient, now));
        let acknowledged = view(now - Duration::hours(20), None, true);
        assert!(!is_stale(&acknowledged, now));
    }

    // Integration-style tests below drive `decide` + the real store
    // functions together against an actual on-disk SQLite file (not just
    // in-memory), the same way WK-111's crash/restart tests do - proving
    // the store-layer half of this feature end to end. The `AppHandle`
    // glue in `reconcile`/`apply` above is intentionally left untested
    // directly, for the same reason `obs::handle_session_state` already is
    // (see obs.rs's test module doc comment): this Tauri version isn't
    // built with the `test` feature, so exercising it needs a real running
    // app, not a unit test.
    mod store_integration {
        use super::*;
        use crate::local_runtime::schema;
        use crate::local_runtime::store;
        use tempfile::TempDir;

        fn open_at(dir: &TempDir) -> Connection {
            let path = dir.path().join("local-runtime.sqlite3");
            let conn = Connection::open(&path).unwrap();
            schema::migrate(&conn).unwrap();
            conn
        }

        // WK-112 test matrix #13: crash/restart during the 30s pending-end
        // countdown must reconcile deterministically from SQLite + a fresh
        // OBS streaming answer - never from an assumption that an
        // in-memory timer survived the restart (there is none).
        #[test]
        fn crash_during_pending_end_then_restart_reconciles_from_disk_not_a_timer() {
            let dir = TempDir::new().unwrap();
            let t0 = Utc::now();
            let session_id = {
                let conn = open_at(&dir);
                let session = store::ensure_active_session(&conn, t0).unwrap();
                // OBS reported "not streaming" - begin the grace countdown,
                // durably, then "crash" (connection just drops here).
                store::begin_pending_end(&conn, &session.local_id, t0).unwrap();
                session.local_id
            };

            // "Restart": brand new connection to the same file, 40s later
            // (grace already elapsed while Companion was down), OBS still
            // says not streaming once reconnected.
            let conn = open_at(&dir);
            let open = store::find_open_session(&conn).unwrap().unwrap();
            assert_eq!(open.local_id, session_id);
            assert_eq!(open.pending_end_at, Some(t0.to_rfc3339()));

            let view = SessionLifecycleView::from_session(&open).unwrap();
            let t1 = t0 + Duration::seconds(40);
            assert_eq!(decide(Some(&view), false, t1), LifecycleDecision::FinalizeEnd);
            store::finalize_session_end(&conn, &open.local_id, t1).unwrap();
            assert!(store::find_open_session(&conn).unwrap().is_none());
        }

        // WK-112 test matrix #13 (the other branch): restart happens
        // within the grace window and OBS turns out to still be streaming -
        // must cancel the pending-end and keep the SAME session, not end it
        // just because a restart happened to occur during the countdown.
        #[test]
        fn crash_during_pending_end_then_restart_with_streaming_resumed_cancels_the_end() {
            let dir = TempDir::new().unwrap();
            let t0 = Utc::now();
            let session_id = {
                let conn = open_at(&dir);
                let session = store::ensure_active_session(&conn, t0).unwrap();
                store::begin_pending_end(&conn, &session.local_id, t0).unwrap();
                session.local_id
            };

            let conn = open_at(&dir);
            let open = store::find_open_session(&conn).unwrap().unwrap();
            let view = SessionLifecycleView::from_session(&open).unwrap();
            let t1 = t0 + Duration::seconds(10); // still within the 30s grace
            assert_eq!(decide(Some(&view), true, t1), LifecycleDecision::CancelPendingEnd);
            store::cancel_pending_end(&conn, &open.local_id).unwrap();

            let resumed = store::find_open_session(&conn).unwrap().unwrap();
            assert_eq!(resumed.local_id, session_id);
            assert_eq!(resumed.pending_end_at, None);
            assert!(resumed.ended_at.is_none());
        }

        // WK-112 test matrix #9/#10: Companion (re)started while OBS is
        // already streaming and no local session is open - one reconcile
        // call must create exactly one session, and a second, repeated
        // "streaming=true" answer (e.g. a StreamStateChanged retransmit)
        // must not create a duplicate.
        #[test]
        fn repeated_streaming_true_answers_never_create_a_second_session() {
            let conn = open_at(&TempDir::new().unwrap());
            let now = Utc::now();

            let first_decision = decide(None, true, now);
            assert_eq!(first_decision, LifecycleDecision::StartNewSession);
            let created = store::ensure_active_session(&conn, now).unwrap();

            // A second "streaming" answer arrives (event retransmit, or the
            // sweep tick) before anything else changes.
            let open = store::find_open_session(&conn).unwrap().unwrap();
            let view = SessionLifecycleView::from_session(&open).unwrap();
            assert_eq!(decide(Some(&view), true, now), LifecycleDecision::ContinueSession);

            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0)).unwrap();
            assert_eq!(count, 1);
            assert_eq!(created.local_id, open.local_id);
        }

        // WK-112 test matrix #12: a stale (>12h) open session must surface
        // for manual recovery even though OBS is unreachable (streaming
        // truth unknown) - `is_stale`/the read-only status path never
        // requires a streaming answer at all, only `decide` does.
        #[test]
        fn stale_session_is_flagged_by_status_independent_of_obs_reachability() {
            let conn = open_at(&TempDir::new().unwrap());
            let ancient_start = Utc::now() - Duration::hours(30);
            store::ensure_active_session(&conn, ancient_start).unwrap();

            let open = store::find_open_session(&conn).unwrap().unwrap();
            let view = SessionLifecycleView::from_session(&open).unwrap();
            // No `streaming` value is consulted here at all - this is
            // exactly what the read-only `status()` function does.
            assert!(is_stale(&view, Utc::now()));
        }
    }
}
