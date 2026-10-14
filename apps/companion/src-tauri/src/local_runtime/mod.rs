// WK-111 - local durable runtime: a passive, crash-safe SQLite mirror of
// stream-session/match/MMR state, built entirely from the same local GSI
// stream `obs::handle_gsi`/`game_sounds::handle_gsi` already consume (see
// `server::process_gsi_body`). This module is a SHADOW MIRROR ONLY (see
// docs/research/wk-110-local-first-audit.md §11):
//
// - it runs *alongside* today's `backend::try_send_pending` GSI-forwarding,
//   never in place of it;
// - it never calls the backend, never reads `AppState`'s `backend_*`
//   fields, and never makes a network call of any kind - `handle_gsi`
//   below only ever touches the local SQLite connection this module owns;
// - it does not decide when a STREAM session starts/ends (that's WK-112,
//   OBS-driven lifecycle) - `ensure_active_session` only ever lazily
//   creates a genuinely streamed one if none is open yet, mirroring the
//   backend's `getOrCreateActiveSession`, and nothing here ever closes a
//   streamed one (only OBS-driven lifecycle does). Since WK-137, match
//   EXISTENCE no longer depends on a stream session at all: `handle_gsi`
//   below may lazily open a non-streamed "gameplay session"
//   (`ensure_gameplay_session`) purely from GSI match evidence, and closes
//   it itself once that match resolves - see
//   docs/research/wk-137-match-session-decoupling.md;

// - the Home Dashboard's per-match correction commands (WK-115,
//   `correct_match_delta`/`correct_match_ranked_mode` below) are the one
//   exception to "shadow mirror only, no manual-correction workflow" above:
//   they are pure local writes against this module's own SQLite mirror
//   (never the backend), reanchoring only the affected local session's own
//   chain - see `store::reanchor_session`'s doc comment for the session-only
//   scope. `RankedMode::Unknown` (model.rs) is still never guessed - only
//   ever set from an explicit correction or an already-known detected value.
//
// See detector.rs's `match_transition_never_depends_on_backend_state` for
// the compiled-in regression test pinning the backend-independence
// guarantee, by direct analogy with Game Sounds'
// `playback_resolution_never_depends_on_backend_state`
// (game_sounds/mod.rs) - the reference architecture this module was built
// to match.

mod detector;
mod gsi;
pub mod lifecycle;
mod model;
mod schema;
mod store;
pub(crate) mod transaction_facade;
#[cfg(test)]
pub(crate) mod transaction_tests;
#[cfg(test)]
mod match_shadow_tests;
pub(crate) mod host_execution;
pub(crate) mod transaction_schema;
pub(crate) mod transaction_authorization;
pub mod summary;
pub mod sync;
pub mod watchdog;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

pub struct LocalRuntimeState(Mutex<Option<Connection>>,Mutex<Option<host_execution::Adapter>>);

impl LocalRuntimeState {
    /// Manual Prepare only: preserve the legacy optional sound accessor below.
    pub(crate) fn preparation_session(&self)->Result<Option<String>,String> {
        let guard=self.0.try_lock().map_err(|e|match e {
            std::sync::TryLockError::WouldBlock=>"history_busy",
            std::sync::TryLockError::Poisoned(_)=>"local_runtime_lock_poisoned",
        })?;
        let c=guard.as_ref().ok_or("local_runtime_unavailable")?;
        // Preserve legacy fallback to an open session, but never disguise both failed reads as absence.
        let active=store::find_active_match_anywhere(c);
        if let Ok(Some(m))=&active{return Ok(Some(m.session_local_id.clone()));}
        match store::find_open_session(c) {
            Ok(Some(s))=>Ok(Some(s.local_id)),
            Ok(None) if active.is_err()=>Err("match_lookup_failed".into()),
            Ok(None)=>Ok(None),
            Err(_)=>Err("session_lookup_failed".into()),
        }
    }
    pub(crate) fn audio_session(&self)->Option<String> {
        let guard=self.0.try_lock().ok()?;let c=guard.as_ref()?;
        store::find_active_match_anywhere(c).ok().flatten().map(|m|m.session_local_id)
            .or_else(||store::find_open_session(c).ok().flatten().map(|s|s.local_id))
    }
    pub fn new() -> Self {
        Self(Mutex::new(None),Mutex::new(None))
    }

    /// Convenience accessor used by `lifecycle.rs` (and anything else that
    /// needs the connection outside this file) - same lock, just without
    /// spelling out `.0.lock().unwrap()` at every call site.
    pub fn lock(&self) -> MutexGuard<'_, Option<Connection>> {
        self.0.lock().unwrap()
    }

    /// Fallible access for bounded read-only plugin projections; legacy callers unchanged.
    pub fn try_lock(&self) -> Result<MutexGuard<'_, Option<Connection>>, &'static str> {
        self.0.lock().map_err(|_| "local_runtime_lock_poisoned")
    }
    pub(crate) fn with_transaction_adapter<T>(&self,write:impl FnOnce(&mut host_execution::Adapter,&mut Connection)->Result<T,String>)->Result<T,String> {
        let mut connection=self.try_lock().map_err(str::to_string)?;let conn=connection.as_mut().ok_or("local_runtime_unavailable")?;
        let mut adapter=self.1.lock().map_err(|_|"transaction_adapter_lock_poisoned")?;
        if adapter.is_none(){*adapter=Some(host_execution::Adapter::attach(conn)?);}write(adapter.as_mut().unwrap(),conn)
    }
    pub(crate) fn execute_plugin_plan(&self,manager:&crate::core::plugin_manager::PluginManager,grant:&crate::core::plugin_manager::MatchExecutionGrant,request:&companion_dota_domain::match_execution::Request)->Result<companion_dota_domain::match_execution::Response,String> {
        manager.with_verified_match_grant(grant,|pin|self.with_transaction_adapter(|adapter,conn|adapter.execute_plugin(conn,pin,request)))
    }
    pub(crate) fn migrate_transactions(&self,backup:&std::path::Path)->Result<(),String> {
        let mut connection=self.try_lock().map_err(str::to_string)?;let conn=connection.as_mut().ok_or("local_runtime_unavailable")?;
        if self.1.lock().map_err(|_|"transaction_adapter_lock_poisoned")?.is_some(){return Err("coordinator_already_attached".into());}
        transaction_schema::migrate(conn,backup)
    }
    pub(crate) fn recover_plugin_plan(&self,manager:&crate::core::plugin_manager::PluginManager,grant:&crate::core::plugin_manager::MatchExecutionGrant,request:&companion_dota_domain::match_execution::Request)->Result<companion_dota_domain::match_execution::Response,String> {
        manager.with_verified_match_grant(grant,|pin|self.with_transaction_adapter(|adapter,conn|adapter.recover_plugin(conn,pin,request)))
    }
}

impl Default for LocalRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod prepare_diagnostics {
    use super::*;
    #[test] fn session_lookup_distinguishes_busy_unavailable_absent_and_sql_errors() {
        let state=LocalRuntimeState::new();
        assert_eq!(state.preparation_session().unwrap_err(),"local_runtime_unavailable");
        let mut c=Connection::open_in_memory().unwrap();schema::migrate(&mut c).unwrap();
        *state.0.lock().unwrap()=Some(c);
        assert!(state.preparation_session().unwrap().is_none());
        {let guard=state.0.lock().unwrap();assert_eq!(state.preparation_session().unwrap_err(),"history_busy");drop(guard);}
        {let mut guard=state.0.lock().unwrap();let c=guard.as_mut().unwrap();
         let session=store::ensure_active_session(c,chrono::Utc::now()).unwrap();
         assert!(!session.local_id.is_empty());}
        assert!(state.preparation_session().unwrap().is_some());
        *state.0.lock().unwrap()=Some(Connection::open_in_memory().unwrap());
        assert_eq!(state.preparation_session().unwrap_err(),"session_lookup_failed");
    }
    #[test] fn poisoned_history_is_not_reported_as_absent_session() {
        let state=LocalRuntimeState::new();
        let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _guard=state.0.lock().unwrap();panic!("fixture");}));
        assert_eq!(state.preparation_session().unwrap_err(),"local_runtime_lock_poisoned");
    }
}

fn db_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("local-runtime.sqlite3")
}

/// Opens (creating if needed) the local runtime's SQLite file and runs
/// migrations - called once from `lib.rs`'s `setup()`, same lifecycle
/// point as `game_sounds::init`/`hotkeys::init`. A failure here (corrupt
/// file, disk full, migration error) is logged and left as `None` rather
/// than panicking the whole app - WK-111's acceptance criteria explicitly
/// require that a local-runtime storage failure must not take down
/// Companion; the existing backend-driven runtime (GSI ingest, OBS
/// automation, backend forwarding - none of which read this state) keeps
/// working exactly as it does today with this module simply inert.
pub fn init(app: &AppHandle) {
    let path = db_path(app);
    if let Some(dir) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(dir) {
            crate::storage::append_rolling_log(
                app,
                &format!("Local runtime: could not create data dir ({error}); shadow mirror disabled this run."),
            );
            return;
        }
    }
    match Connection::open(&path).and_then(|conn| schema::migrate(&conn).map(|journal_mode| (conn, journal_mode))) {
        Ok((conn, journal_mode)) => {
            if let Ok(summary) = store::log_summary(&conn) {
                crate::storage::append_rolling_log(app, &format!("Local runtime: opened ({summary})"));
            }
            // WK-127 - WAL is the crash-safety property this whole module
            // depends on (see schema::migrate's doc comment); this can only
            // ever fire if the environment silently couldn't honor it (e.g.
            // some network-redirected profile directories), never on a
            // normal desktop install.
            if !journal_mode.eq_ignore_ascii_case("wal") {
                crate::storage::append_rolling_log(
                    app,
                    &format!("Local runtime: journal_mode is '{journal_mode}', not WAL - this environment may not support WAL (e.g. a network-redirected data directory); crash-safety guarantees are reduced."),
                );
            }
            if let Some(gate)=app.try_state::<crate::core::dota_live::LiveDota>(){gate.observe_storage(&conn);}
            *app.state::<LocalRuntimeState>().0.lock().unwrap() = Some(conn);
        }
        Err(error) => {
            // Deliberately not a retry loop and not a delete-and-recreate
            // fallback - a corrupt local-runtime file is exactly the kind
            // of thing a human should look at once (it's a shadow mirror,
            // not load-bearing yet), not something Companion should ever
            // silently discard on its own.
            crate::storage::append_rolling_log(
                app,
                &format!("Local runtime: failed to open/migrate {path:?} ({error}); shadow mirror disabled this run."),
            );
            if let Some(gate)=app.try_state::<crate::core::dota_live::LiveDota>(){gate.storage_open_failed(&path);}
        }
    }
}

/// Entry point called from `server::process_gsi_body`, alongside
/// `obs::handle_gsi`/`game_sounds::handle_gsi` - the one place raw GSI
/// reaches this feature. A no-op whenever `init` didn't manage to open the
/// local store (see above) - mirrors `diagnostics::observe`'s
/// "no-op unless active" shape.
// WK-116 - generic over `R: Runtime` so this, the real production GSI
// entry point (see server::process_gsi_body), can be driven end to end by
// an integration test using `tauri::test::mock_app()` - previously only the
// pure decision layer underneath it (detector.rs/store.rs) was testable,
// which is exactly how the OBS-watcher wiring bug this ticket fixes went
// undetected. Every real call site keeps compiling unchanged (`R = Wry` by
// inference).
pub fn handle_gsi<R: Runtime>(app: &AppHandle<R>, payload: &Value) {
    let _ = handle_gsi_shadow(app, payload);
}
pub(crate) fn handle_gsi_shadow<R: Runtime>(app: &AppHandle<R>, payload: &Value) -> Option<companion_dota_domain::match_shadow::Context> {
    let Some(snapshot) = gsi::parse(payload) else { return None };
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return None };

    let now = chrono::Utc::now();

    // WK-137 - session resolution no longer requires OBS to have started a
    // stream (see docs/research/wk-137-match-session-decoupling.md). Three
    // tiers, in order:
    //   1. Whatever match is currently active anywhere on the device keeps
    //      being tracked in ITS session, even if that session has already
    //      `ended_at` (OBS stopped + the 30s grace elapsed mid-match) - a
    //      match's own lifecycle, not its session's, decides whether ticks
    //      still apply to it.
    //   2. Otherwise, the current open session, if any - a streamed session
    //      with no match in progress yet, or a gameplay session already
    //      open for the match this tick is about to resume.
    //   3. Otherwise, only if THIS tick itself carries genuine new-match
    //      evidence (the same gate detector.rs uses to create a match),
    //      lazily open a gameplay session for it. An ordinary menu/idle tick
    //      with nothing open creates nothing, exactly as before WK-137.
    let session_local_id = match store::find_active_match_anywhere(conn) {
        Ok(Some(active)) => active.session_local_id,
        Ok(None) => match store::find_open_session(conn) {
            Ok(Some(session)) => session.local_id,
            Ok(None) => {
                if !detector::is_new_match_evidence(&snapshot) {
                    return None;
                }
                match store::ensure_gameplay_session(conn, now) {
                    Ok(session) => session.local_id,
                    Err(error) => {
                        crate::storage::append_rolling_log(app, &format!("Local runtime: ensure_gameplay_session failed ({error})"));
                        return None;
                    }
                }
            }
            Err(error) => {
                crate::storage::append_rolling_log(app, &format!("Local runtime: find_open_session failed ({error})"));
                return None;
            }
        },
        Err(error) => {
            crate::storage::append_rolling_log(app, &format!("Local runtime: find_active_match_anywhere failed ({error})"));
            return None;
        }
    };

    let ranked_mode = sync::cached_ranked_mode(conn);
    // WK-116 observability - captured before/after the pure decision layer
    // runs (detector.rs stays AppHandle-free, per its own architectural
    // pin) so a match's creation/transition/finalization is visible in
    // app.log without adding a single per-tick log line - this only ever
    // logs on an actual state change, never on a no-op tick.
    let before = store::find_active_match(conn, &session_local_id).ok().flatten();
    // The exact same pre-write context drives legacy execution and immutable shadow input.
    let context = match detector::context(conn, &session_local_id, ranked_mode, now) {
        Ok(context) => context,
        Err(error) => {crate::storage::append_rolling_log(app, &format!("Local runtime: handle_snapshot failed ({error})")); return None;},
    };
    let mut shadow = if app.try_state::<crate::core::dota_observer::Observer>().is_some_and(|observer|observer.active()) {
        match (crate::core::dota_observer::project(payload), store::find_session(conn, &session_local_id)) {
            (Ok(projected), Ok(Some(session))) => {
                let mut captured=context.clone();
                captured.snapshot_identity=companion_dota_domain::match_shadow::snapshot_identity(&projected);
                captured.session.ended=session.ended_at.is_some(); captured.session.streamed=session.is_streamed;
                Some(captured)
            }, _ => None,
        }
    } else {None};
    if let Err(error) = detector::handle_snapshot_with_context(conn, &session_local_id, &snapshot, now, &context) {
        crate::storage::append_rolling_log(app, &format!("Local runtime: handle_snapshot failed ({error})"));
        if let Some(context)=&mut shadow {context.inconclusive_reason=Some("legacy_store_failure".into());}
        return shadow;
    }
    let after = store::find_active_match(conn, &session_local_id).ok().flatten();
    let terminal = before
        .as_ref()
        .filter(|_| after.is_none())
        .and_then(|old| store::find_match(conn, &old.local_id).ok().flatten());

    if let Some(captured)=&mut shadow {
        let expected=companion_dota_domain::match_shadow::decide(captured,&snapshot);
        if expected.end_gameplay_session != (terminal.is_some() && !captured.session.streamed) {
            // INSERT OR IGNORE/conditional lookup outcome is not a pure snapshot decision.
            captured.inconclusive_reason=Some("conditional_store_outcome".into());
        }
    }

    // WK-137 - a gameplay session (not yet/never streamed) is 1:1 with the
    // match that opened it: close it the moment that match resolves for a
    // TERMINAL reason (finalized or needs_review - not interrupted, which
    // can still resume within the existing reconnect window). If OBS
    // graduated this session in the meantime (`is_streamed` is now true,
    // see `lifecycle::apply`'s ContinueSession arm), it behaves like any
    // other stream session from here on and is left alone - it now only
    // ends via the normal OBS-stop + grace path. See the decision note for
    // why this mirrors "one continuous period ends when the thing that was
    // happening ends" rather than leaving gameplay sessions open forever.
    if terminal.is_some() {
        match store::find_session(conn, &session_local_id) {
            Ok(Some(session)) if companion_dota_domain::match_shadow::should_end_gameplay(session.is_streamed, true) => {
                if let Err(error) = store::finalize_session_end(conn, &session_local_id, now) {
                    crate::storage::append_rolling_log(app, &format!("Local runtime: finalize_session_end (gameplay) failed ({error})"));
                    if let Some(context)=&mut shadow{context.inconclusive_reason=Some("legacy_store_failure".into());}
                }
            }
            Ok(_) => {}
            Err(error) => {
                crate::storage::append_rolling_log(app, &format!("Local runtime: find_session failed ({error})"));
            }
        }
    }

    log_match_transition(app, &session_local_id, before.as_ref(), after.as_ref(), terminal.as_ref());
    shadow
}

/// Sets/corrects Current MMR on the authoritative open local session.
/// Match history is never rewritten; see store::set_current_rating.
pub fn set_current_rating<R: Runtime>(app: &AppHandle<R>, rating: i64) -> Result<summary::LocalSessionSummary, String> {
    if !(0..=30_000).contains(&rating) {
        return Err("MMR must be between 0 and 30000".to_string());
    }

    let previous = {
        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().ok_or_else(|| "Local runtime is unavailable".to_string())?;
        let previous = store::find_open_session(conn)
            .map_err(|error| error.to_string())?
            .and_then(|session| session.rating_current);
        store::set_current_rating(conn, rating).map_err(|error| error.to_string())?;
        previous
    };

    crate::storage::append_rolling_log(
        app,
        &format!("Local current MMR corrected: previous={previous:?} current={rating}"),
    );
    Ok(summary::get(app))
}

/// WK-115 - Dashboard "+/- and ×2" correction for one finalized match's
/// effective rating delta. `effective_delta = None` clears any existing
/// correction. See `store::correct_match_delta` for the detected-delta
/// immutability invariant and `store::reanchor_session` for how later
/// matches in the same session pick up the change.
pub fn correct_match_delta<R: Runtime>(
    app: &AppHandle<R>,
    local_id: &str,
    effective_delta: Option<i64>,
) -> Result<summary::LocalSessionSummary, String> {
    if let Some(value) = effective_delta {
        if !(-1_000..=1_000).contains(&value) {
            return Err("Rating delta must be between -1000 and 1000".to_string());
        }
    }

    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let conn = guard.as_mut().ok_or_else(|| "Local runtime is unavailable".to_string())?;
    let updated = store::correct_match_delta(conn, local_id, effective_delta).map_err(|error| error.to_string())?;
    drop(guard);

    crate::storage::append_rolling_log(
        app,
        &format!("Local match delta corrected: match={local_id} effective_delta={effective_delta:?} rating_after={:?}", updated.and_then(|m| m.rating_after)),
    );
    Ok(summary::get(app))
}

/// WK-115 - Dashboard "Ranked -> Unranked" correction (and its reverse) for
/// one finalized match. `ranked = None` clears the override, restoring the
/// match's detected classification (`ranked_mode_detected`) verbatim -
/// never a hardcoded Ranked. `ranked = Some(true/false)` forces Ranked/
/// Unranked. See `store::correct_match_ranked_mode`.
pub fn correct_match_ranked_mode<R: Runtime>(
    app: &AppHandle<R>,
    local_id: &str,
    ranked: Option<bool>,
) -> Result<summary::LocalSessionSummary, String> {
    let target = ranked.map(|value| if value { model::RankedMode::Ranked } else { model::RankedMode::Unranked });

    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let conn = guard.as_mut().ok_or_else(|| "Local runtime is unavailable".to_string())?;
    let updated = store::correct_match_ranked_mode(conn, local_id, target).map_err(|error| error.to_string())?;
    drop(guard);

    crate::storage::append_rolling_log(
        app,
        &format!("Local match ranked mode corrected: match={local_id} target={ranked:?} ranked_mode={:?}", updated.map(|m| m.ranked_mode)),
    );
    Ok(summary::get(app))
}

/// WK-116 - logs only on an actual change in the session's active match, so
/// a real stream produces a handful of lines (created/transition/finalized/
/// interrupted), never one line per GSI tick. Correlated by
/// session_local_id + match_local_id so a support investigation can follow
/// one match end to end through app.log without needing raw payloads.
fn log_match_transition<R: Runtime>(
    app: &AppHandle<R>,
    session_local_id: &str,
    before: Option<&model::LocalMatch>,
    after: Option<&model::LocalMatch>,
    terminal: Option<&model::LocalMatch>,
) {
    match (before, after) {
        (None, Some(new)) => {
            crate::storage::append_rolling_log(
                app,
                &format!(
                    "Local match created: session={session_local_id} match={} hero={} match_id={:?} ranked_mode={:?}",
                    new.local_id, new.hero_id, new.match_id, new.ranked_mode
                ),
            );
        }
        (Some(old), Some(new)) if old.local_id == new.local_id && old.state != new.state => {
            crate::storage::append_rolling_log(
                app,
                &format!(
                    "Local match transition: session={session_local_id} match={} {:?} -> {:?} result={:?}",
                    new.local_id, old.state, new.state, new.result
                ),
            );
        }
        (Some(old), None) => {
            crate::storage::append_rolling_log(
                app,
                &format!(
                    "Local match finalized: session={session_local_id} match={} hero={} state={:?} result={:?} rating_delta={:?} rating_after={:?} kda_present={} items_present={} persisted_successfully={}",
                    old.local_id,
                    terminal.map(|value| value.hero_id).unwrap_or(old.hero_id),
                    terminal.map(|value| value.state).unwrap_or(old.state),
                    terminal.and_then(|value| value.result),
                    terminal.and_then(|value| value.detected_rating_delta),
                    terminal.and_then(|value| value.rating_after),
                    terminal.is_some_and(|value| value.kills.is_some() && value.deaths.is_some() && value.assists.is_some()),
                    terminal.is_some_and(|value| value.inventory.iter().any(Option::is_some)),
                    terminal.is_some(),
                ),
            );
        }
        (Some(old), Some(new)) if old.local_id != new.local_id => {
            crate::storage::append_rolling_log(
                app,
                &format!(
                    "Local match superseded: session={session_local_id} old_match={} new_match={}",
                    old.local_id, new.local_id
                ),
            );
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::gsi::GsiSnapshot;
    use chrono::Utc;
    use rusqlite::params;
    use tempfile::TempDir;

    fn open_at(dir: &TempDir) -> Connection {
        let path = dir.path().join("local-runtime.sqlite3");
        let conn = Connection::open(&path).unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    fn in_progress_tick(match_id: &str, hero_id: i64) -> GsiSnapshot {
        GsiSnapshot {
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

    // WK-116 P0 regression coverage - drives the REAL production entry
    // point (`handle_gsi`, exactly what `server::process_gsi_body` calls)
    // with raw JSON payloads shaped like actual Dota GSI ticks, through a
    // real (mocked) `AppHandle` - not `detector::handle_snapshot` called
    // directly with a hand-built `GsiSnapshot`, which is what every other
    // test in this file does and which cannot catch a broken call site
    // between the GSI server and the decision layer (see this ticket's
    // report: that's exactly how the OBS-watcher wiring bug went
    // undetected through WK-111/112/113's own test suites). The LocalSession
    // itself is created directly via `store::ensure_active_session` here
    // (simulating "OBS already started the stream") - that trigger has its
    // own dedicated coverage in lifecycle.rs; this test's job is the GSI-to-
    // LocalMatch half of the chain.
    #[test]
    fn real_gsi_entrypoint_creates_tracks_and_finalizes_a_match_end_to_end() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());

        let mut conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        let session_local_id = session.local_id.clone();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let handle = app.handle();
        let tick = |game_state: &str, win_team: Option<&str>| {
            let mut payload = serde_json::json!({
                "map": { "game_state": game_state, "matchid": "555" },
                "player": { "activity": "playing", "team_name": "radiant" },
                "hero": { "id": 14 },
            });
            if let Some(win_team) = win_team {
                payload["map"]["win_team"] = serde_json::json!(win_team);
            }
            handle_gsi(handle, &payload);
        };

        tick("DOTA_GAMERULES_STATE_HERO_SELECTION", None);
        tick("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", None);
        tick("DOTA_GAMERULES_STATE_POST_GAME", Some("radiant")); // first observation
        tick("DOTA_GAMERULES_STATE_POST_GAME", Some("radiant")); // confirming observation

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();

        assert!(
            store::find_active_match(conn, &session_local_id).unwrap().is_none(),
            "the match must be finalized (no longer active) after a confirmed post-game result"
        );
        let match_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_matches WHERE session_local_id = ?1", params![session_local_id], |row| row.get(0))
            .unwrap();
        assert_eq!(match_count, 1, "exactly one LocalMatch must exist for the whole sequence, not one per tick");
        let (match_state, result): (String, String) = conn
            .query_row("SELECT state, result FROM local_matches WHERE session_local_id = ?1", params![session_local_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(match_state, "finalized");
        assert_eq!(result, "win");

        let outbox_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE event_type = 'match_finalized'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox_count, 1, "exactly one match_finalized sync event must be enqueued");

        // Recent-match query (what Главная actually reads, see
        // local_runtime::summary) must return this match too.
        let recent = store::list_recent_matches(conn, &session_local_id, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].match_id.as_deref(), Some("555"));
    }


    #[test]
    fn real_reduced_post_game_payload_updates_rating_history_and_outbox_once() {
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());

        let mut conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        let session = store::ensure_active_session(&mut conn, Utc::now()).unwrap();
        store::set_current_rating(&mut conn, 6000).unwrap();
        conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('cached_game_mode', 'ranked') \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
        let session_local_id = session.local_id.clone();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let handle = app.handle();
        handle_gsi(
            handle,
            &serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": 8123456789_i64, "customgamename": "" },
                "player": { "activity": "playing", "team_name": "radiant" },
                "hero": { "id": 14 }
            }),
        );
        let reduced_post_game = serde_json::json!({
            "map": {
                "game_state": "DOTA_GAMERULES_STATE_POST_GAME",
                "matchid": 8123456789_i64,
                "win_team": "radiant"
            },
            "player": { "activity": "menu" }
        });
        handle_gsi(handle, &reduced_post_game);
        handle_gsi(handle, &reduced_post_game);
        handle_gsi(handle, &reduced_post_game); // repeated final screen must be idempotent

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let summary = store::find_open_session(conn).unwrap().unwrap();
        assert_eq!(summary.rating_current, Some(6025));
        assert_eq!(store::session_match_tally(conn, &session_local_id).unwrap(), (1, 0));
        let recent = store::list_recent_matches(conn, &session_local_id, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].match_id.as_deref(), Some("8123456789"));
        assert_eq!(recent[0].detected_rating_delta, Some(25));
        let outbox_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE event_type = 'match_finalized'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox_count, 1);
    }

    // WK-116 - same real entry point, proving a GSI tick is silently
    // ignored (not queued, not errored, not logged as a match) when no
    // LocalSession is open - the exact symptom the OBS-watcher bug produced
    // in production. Pins the CURRENT, intentional contract (session
    // creation is exclusively OBS-driven, see this function's own doc
    // comment) so a future change can't reintroduce silent GSI-triggered
    // session creation without this test forcing a conscious decision.
    #[test]
    fn real_gsi_entrypoint_opens_a_nonstreamed_gameplay_session_for_a_real_match_with_no_obs_session_open() {
        // WK-137 - this is the ticket's core fix, pinned at the real
        // production entry point: a fully-observed match must not require
        // OBS to have started a stream session first. Superseded the old
        // "handle_gsi must never create a session itself" contract this
        // test name/assertion used to pin (WK-113) - see
        // docs/research/wk-137-match-session-decoupling.md.
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());

        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let handle = app.handle();
        handle_gsi(
            handle,
            &serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": "1" },
                "player": { "activity": "playing", "team_name": "radiant" },
                "hero": { "id": 14 },
            }),
        );

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let session_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0)).unwrap();
        let match_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(session_count, 1, "real match evidence with no session open must lazily open exactly one gameplay session");
        assert_eq!(match_count, 1, "the match itself must be created, not dropped");
        let is_streamed: i64 =
            conn.query_row("SELECT is_streamed FROM local_sessions", [], |row| row.get(0)).unwrap();
        assert_eq!(is_streamed, 0, "a session opened from GSI evidence alone must never claim to be an OBS broadcast");
    }

    #[test]
    fn real_gsi_entrypoint_still_ignores_ordinary_ticks_with_no_match_evidence_and_no_session_open() {
        // WK-137 - the flip side of the fix above: an idle/menu tick must
        // still create nothing when there is no open session and no real
        // match evidence - only genuine GSI evidence of a match may lazily
        // open a gameplay session, never every GSI tick unconditionally
        // (that was the WK-113 problem this ticket deliberately does not
        // reintroduce - see docs/research/wk-137-match-session-decoupling.md's
        // "Alternatives rejected").
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());

        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);

        let handle = app.handle();
        handle_gsi(
            handle,
            &serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_DISCONNECT" },
                "player": { "activity": "menu" },
            }),
        );

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let session_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0)).unwrap();
        let match_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(session_count, 0, "an ordinary idle tick must never lazily open a session");
        assert_eq!(match_count, 0);
    }

    #[test]
    fn a_nonstreamed_gameplay_session_closes_itself_once_its_match_finalizes() {
        // WK-137 - "one gameplay session per match": once the match that
        // opened a non-streamed session finalizes, that session must close
        // itself so a later, unrelated match doesn't inherit it.
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);
        let handle = app.handle();

        let in_progress = serde_json::json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": "42" },
            "player": { "activity": "playing", "team_name": "radiant" },
            "hero": { "id": 14 },
        });
        handle_gsi(handle, &in_progress);

        let post_game = serde_json::json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_POST_GAME", "matchid": "42", "win_team": "radiant" },
            "player": { "activity": "menu" },
        });
        handle_gsi(handle, &post_game);
        handle_gsi(handle, &post_game); // second confirming tick finalizes

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let (ended_at, is_streamed): (Option<String>, i64) =
            conn.query_row("SELECT ended_at, is_streamed FROM local_sessions", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert!(ended_at.is_some(), "a gameplay session must close itself once its match finalizes");
        assert_eq!(is_streamed, 0);
        let match_state: String =
            conn.query_row("SELECT state FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(match_state, "finalized");
    }

    // WK-111 acceptance criterion #2: Companion closed mid-match, reopened -
    // state must not be lost or corrupted. Simulated here by literally
    // closing the SQLite connection (dropping it) and reopening a fresh one
    // against the same on-disk file, exactly what happens across a real
    // process restart.
    #[test]
    fn a_match_still_finalizes_correctly_after_its_session_has_already_ended() {
        // WK-137 - scenario 5 (OBS stops streaming mid-match): the existing
        // 30s grace period ends the session (`store::finalize_session_end`,
        // simulated directly here rather than through the full OBS/reconcile
        // machinery, which lifecycle.rs's own tests already cover) without
        // any awareness of whether a match is still active. Ticks for that
        // match must keep resolving into ITS session - not be dropped, not
        // attach to a different session - and MMR must land correctly on
        // the now-ended session.
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);
        let handle = app.handle();

        let session_id = {
            let state = app.state::<LocalRuntimeState>();
            let mut guard = state.lock();
            let conn = guard.as_mut().unwrap();
            let session = store::ensure_active_session(conn, Utc::now()).unwrap();
            store::set_current_rating(conn, 5_000).unwrap();
            session.local_id
        };

        handle_gsi(
            handle,
            &serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": "99" },
                "player": { "activity": "playing", "team_name": "radiant" },
                "hero": { "id": 14 },
            }),
        );

        {
            let state = app.state::<LocalRuntimeState>();
            let mut guard = state.lock();
            let conn = guard.as_mut().unwrap();
            store::finalize_session_end(conn, &session_id, Utc::now()).unwrap();
            assert!(store::find_open_session(conn).unwrap().is_none(), "session must actually be ended for this test to prove anything");
        }

        let post_game = serde_json::json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_POST_GAME", "matchid": "99", "win_team": "radiant" },
            "player": { "activity": "menu" },
        });
        handle_gsi(handle, &post_game);
        handle_gsi(handle, &post_game);

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let session_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0)).unwrap();
        assert_eq!(session_count, 1, "no second session must be created just because the first had already ended");
        let (state_str, session_local_id): (String, String) =
            conn.query_row("SELECT state, session_local_id FROM local_matches", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(state_str, "finalized");
        assert_eq!(session_local_id, session_id, "the match must finalize into the SAME session it started tracking in, even though that session already ended");
    }

    #[test]
    fn obs_starting_mid_match_graduates_the_gameplay_session_without_duplicating_the_match() {
        // WK-137 - scenario 4 (OBS starts streaming mid-match): the match
        // must stay in the same session, which simply becomes streamed -
        // never a second session, never a moved/duplicated match. Graduation
        // itself (`store::mark_session_streamed`) is invoked directly here,
        // exactly as `lifecycle::apply`'s `ContinueSession` arm does - that
        // OBS-truth-to-decision wiring is lifecycle.rs's own concern
        // (`obs_streaming_while_a_gameplay_session_is_open_continues_it_for_graduation`);
        // this test's job is what happens to the match/session data once it fires.
        let app = tauri::test::mock_app();
        app.manage(LocalRuntimeState::new());
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        *app.state::<LocalRuntimeState>().lock() = Some(conn);
        let handle = app.handle();

        handle_gsi(
            handle,
            &serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": "7" },
                "player": { "activity": "playing", "team_name": "radiant" },
                "hero": { "id": 14 },
            }),
        );

        let session_id = {
            let state = app.state::<LocalRuntimeState>();
            let mut guard = state.lock();
            let conn = guard.as_mut().unwrap();
            let session = store::find_open_session(conn).unwrap().expect("gameplay session must already be open");
            assert!(!session.is_streamed);
            store::mark_session_streamed(conn, &session.local_id, Utc::now()).unwrap();
            session.local_id
        };

        let post_game = serde_json::json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_POST_GAME", "matchid": "7", "win_team": "radiant" },
            "player": { "activity": "menu" },
        });
        handle_gsi(handle, &post_game);
        handle_gsi(handle, &post_game);

        let state = app.state::<LocalRuntimeState>();
        let mut guard = state.lock();
        let conn = guard.as_mut().unwrap();
        let session_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0)).unwrap();
        assert_eq!(session_count, 1, "graduation must not create a second session");
        let match_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_matches", [], |row| row.get(0)).unwrap();
        assert_eq!(match_count, 1, "the match must not be duplicated across the graduation");
        let (state_str, session_local_id): (String, String) =
            conn.query_row("SELECT state, session_local_id FROM local_matches", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(state_str, "finalized");
        assert_eq!(session_local_id, session_id);
        let is_streamed: i64 = conn.query_row("SELECT is_streamed FROM local_sessions WHERE local_id = ?1", params![session_id], |row| row.get(0)).unwrap();
        assert_eq!(is_streamed, 1, "the session must still be marked streamed after the match finalizes into it");
        // A now-streamed session must NOT auto-close the way a gameplay
        // session does once its match finalizes - it only ever ends via the
        // normal OBS-stop + grace path from here on.
        let ended_at: Option<String> = conn.query_row("SELECT ended_at FROM local_sessions WHERE local_id = ?1", params![session_id], |row| row.get(0)).unwrap();
        assert!(ended_at.is_none(), "a graduated (now-streamed) session must not auto-close just because its match finalized");
    }

    #[test]
    fn crash_mid_match_then_restart_preserves_the_in_progress_match() {
        let dir = TempDir::new().unwrap();
        let now = Utc::now();

        {
            let mut conn = open_at(&dir);
            let session = store::ensure_active_session(&mut conn, now).unwrap();
            detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Unknown, &in_progress_tick("111", 14), now).unwrap();
            // Connection dropped here without any explicit close/flush call -
            // WAL mode (schema::migrate) is what makes this safe.
        }

        let mut conn = open_at(&dir);
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        let active = store::find_active_match(&conn, &session.local_id).unwrap();
        assert!(active.is_some(), "the in-progress match must survive a Companion restart");
        assert_eq!(active.unwrap().state, model::LocalMatchState::InProgress);
    }

    // WK-111 acceptance criterion #3: backend unreachable for the whole
    // match - nothing in this test ever touches a network type, only the
    // local SQLite connection, proving the local match is fully created,
    // tracked, and finalized without any backend involvement at all.
    #[test]
    fn backend_offline_for_the_entire_match_still_produces_a_correctly_finalized_local_match() {
        let dir = TempDir::new().unwrap();
        let now = Utc::now();
        let mut conn = open_at(&dir);
        let session = store::ensure_active_session(&mut conn, now).unwrap();

        detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Ranked, &in_progress_tick("222", 14), now).unwrap();
        let post_game = GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_POST_GAME".to_string(),
            activity: Some("playing".to_string()),
            custom_game_name: None,
            match_id: Some("222".to_string()),
            win_team: Some("radiant".to_string()),
            hero_id: Some(14),
            team_name: Some("radiant".to_string()),
            telemetry: Default::default(),
        };
        detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Ranked, &post_game, now).unwrap();
        detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Ranked, &post_game, now).unwrap();

        let (state, result): (String, String) = conn
            .query_row("SELECT state, result FROM local_matches WHERE match_id = '222'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(state, "finalized");
        assert_eq!(result, "win");
    }

    // WK-111 acceptance criterion #5: restart between matches must keep the
    // session's rating fields as they were (not reset local_id/rating on
    // every reopen).
    #[test]
    fn restart_between_matches_keeps_the_same_session_and_its_rating() {
        let dir = TempDir::new().unwrap();
        let now = Utc::now();

        let session_id = {
            let mut conn = open_at(&dir);
            let session = store::ensure_active_session(&mut conn, now).unwrap();
            conn.execute(
                "UPDATE local_sessions SET rating_current = 6050 WHERE local_id = ?1",
                [&session.local_id],
            )
            .unwrap();
            session.local_id
        };

        let mut conn = open_at(&dir);
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        assert_eq!(session.local_id, session_id);
        assert_eq!(session.rating_current, Some(6050));
    }
}
