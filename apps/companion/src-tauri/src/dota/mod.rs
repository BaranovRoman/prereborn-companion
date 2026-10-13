// Built-in Dota boundary, not a second runtime or a downloadable plugin.
// Preserve the legacy bootstrap phases: state before logs, ingest before
// backend/OBS, then workers after shared backend/OBS initialization.
pub(crate) mod broadcast_state;
pub(crate) mod gsi;
pub(crate) mod state;

use std::sync::Once;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{draft_reminder, game_sounds, local_runtime, obs,
    opendota_overlay_cache, overlay_server, quiz_overlay, server, storage};
use crate::state::AppState;

pub(crate) struct BuiltInDotaRuntime {
    initialize: Once,
    ingest: Once,
    workers: Once,
}

impl Default for BuiltInDotaRuntime {
    fn default() -> Self {
        Self { initialize: Once::new(), ingest: Once::new(), workers: Once::new() }
    }
}

pub(crate) fn initialize(app: &AppHandle) {
    app.state::<BuiltInDotaRuntime>().initialize.call_once(|| {
        game_sounds::init(app);
        local_runtime::init(app);
    });
}

pub(crate) fn start_ingest(app: &AppHandle) {
    app.state::<BuiltInDotaRuntime>().ingest.call_once(|| {
        server::start(app.clone());
        try_auto_provision(app);
    });
}

pub(crate) fn start_workers(app: &AppHandle) {
    app.state::<BuiltInDotaRuntime>().workers.call_once(|| {
        local_runtime::lifecycle::start_sweep(app.clone());
        local_runtime::watchdog::start_sweep(app.clone());
        local_runtime::sync::start_sync_worker(app.clone());
        overlay_server::init(app.clone());
        opendota_overlay_cache::init(app.clone());
        quiz_overlay::init(app.clone());
    });
}

// Same synchronous fan-out and order as the original GSI request path.
// Diagnostics, HTTP acknowledgement, last payload and forwarding stay with ingest.
pub(crate) fn handle_gsi(app: &AppHandle, payload: &Value) {
    let gate=app.state::<crate::core::dota_live::LiveDota>();
    let Some(_admission)=gate.builtin() else {
        let context={let state=app.state::<AppState>();let i=state.0.lock().unwrap();companion_dota_domain::contracts::ReplayContext{observer_session:None,session_ended:i.session_ended,manual_summary_override:i.obs_manual_summary_override}};
        gate.enqueue_with_context(payload,context);return;
    };
    let legacy_scene={let state=app.state::<AppState>();let i=state.0.lock().unwrap();companion_dota_domain::broadcast_state::resolve(companion_dota_domain::broadcast_state::BroadcastState::from_gsi(payload),i.session_ended,i.obs_manual_summary_override)};
    gate.resolve_overlay(legacy_scene);
    obs::handle_gsi(app, payload);
    game_sounds::handle_gsi(app, payload);
    let shadow=local_runtime::handle_gsi_shadow(app, payload);
    draft_reminder::handle_gsi(app, payload);
    crate::core::dota_observer::forward_with_context(app, payload, shadow);
}

// Called while both admissions remain closed, after the external process/effects are fenced.
// Do not diff the first BuiltIn frame against a pre-handover inventory/cooldown snapshot.
pub(crate) fn reset_after_external_fence(app:&AppHandle)->Result<(),String> {
    let state=app.state::<AppState>();let mut inner=state.0.lock().map_err(|_|"dota_state_poisoned")?;
    inner.game_sounds_previous_gsi=None;
    inner.game_sounds_pending_item_confirmations=Default::default();
    inner.obs_retry_scene=None;inner.obs_retry_at=None;inner.obs_retry_attempt=0;
    Ok(())
}

/// Runs once at startup: tries to find Dota and write the GSI config with no
/// user interaction, so the happy path is zero clicks. Failures here are not
/// fatal — the UI's "Find Dota" / "Install GSI" buttons cover the fallback.
fn try_auto_provision(app: &tauri::AppHandle) {
    let Some(dota_path) = gsi::finder::find_dota_auto() else {
        storage::append_rolling_log(
            app,
            "Startup auto-detection found no Dota install; waiting for manual folder pick.",
        );
        return;
    };
    storage::append_rolling_log(app, &format!("Dota auto-detected at {dota_path}"));

    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.dota_path = Some(dota_path.clone());
        inner.dota_source = Some("auto".to_string());
    }

    match gsi::config::install_gsi(&dota_path) {
        Ok(target) => {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.gsi_installed = true;
            inner.gsi_config_path = Some(target.to_string_lossy().to_string());
            drop(inner);
            storage::append_rolling_log(
                app,
                &format!("GSI config auto-installed at {}", target.display()),
            );
        }
        Err(e) => {
            storage::append_rolling_log(
                app,
                &format!("GSI auto-install failed, use the Install GSI button: {e}"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};

    #[test]
    fn concurrent_bootstrap_attempts_cannot_start_two_sets_of_game_services() {
        let runtime = Arc::new(BuiltInDotaRuntime::default());
        let counts = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0)]);
        let attempts: Vec<_> = (0..8).map(|_| {
            let runtime = Arc::clone(&runtime);
            let counts = Arc::clone(&counts);
            std::thread::spawn(move || {
                runtime.initialize.call_once(|| { counts[0].fetch_add(1, Ordering::SeqCst); });
                runtime.ingest.call_once(|| { counts[1].fetch_add(1, Ordering::SeqCst); });
                runtime.workers.call_once(|| { counts[2].fetch_add(1, Ordering::SeqCst); });
            })
        }).collect();
        for attempt in attempts { attempt.join().unwrap(); }
        for count in counts.iter() { assert_eq!(count.load(Ordering::SeqCst), 1); }
    }
}
