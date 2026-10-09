use crate::obs::{BroadcastScene, ObsConfig};
use serde::Serialize;
use std::sync::Mutex;
#[cfg(test)]
use std::time::Instant;

pub const GSI_PORT: u16 = 3665;
pub const GSI_CONFIG_FILE_NAME: &str = "gamestate_integration_dota_companion.cfg";

// Debug builds use the local API; release installers use production HTTPS.
// backend/config/env.ts, тот же паттерн для STEAM_OPENID_REALM) - companion
// не даёт настроить этот URL из UI в этой итерации (см. отчёт по фиче), это
// единственное место, которое нужно поменять для другого окружения/домена.
#[cfg(debug_assertions)]
pub const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:3001/api";
#[cfg(not(debug_assertions))]
pub const DEFAULT_BACKEND_URL: &str = "https://prereborn.ru/api";
// Same environment split as DEFAULT_BACKEND_URL, but for the web dashboard
// (no /api suffix) - used to open the Twitch settings page for re-linking.
#[cfg(debug_assertions)]
pub const DEFAULT_WEB_ORIGIN: &str = "http://127.0.0.1:3000";
#[cfg(not(debug_assertions))]
pub const DEFAULT_WEB_ORIGIN: &str = "https://prereborn.ru";
pub const COMPANION_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Default)]
pub struct LastEvent {
    pub timestamp: String,
    pub remote_addr: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatusSnapshot {
    pub dota_found: bool,
    pub dota_path: Option<String>,
    pub dota_source: Option<String>,
    pub gsi_installed: bool,
    pub gsi_config_path: Option<String>,
    pub server_running: bool,
    pub gsi_state: ConnectionState,
    pub gsi_last_error: Option<String>,
    pub server_port: u16,
    pub request_count: u32,
    pub last_event: Option<LastEvent>,
    pub log_dir: Option<String>,
    // True while a background thread is deleting a legacy logs/payloads
    // directory (see storage::cleanup_legacy_payloads) - surfaced so the UI
    // can show that a "Очистить лог" click is still finishing up in the
    // background instead of looking like it silently did nothing.
    pub legacy_cleanup_in_progress: bool,
    // Отправка состояния на backend (services/... на бэкенде,
    // src-tauri/src/backend/mod.rs здесь) - полностью независима от
    // локального GSI-сервера выше: сетевые сбои никогда не должны его
    // останавливать (см. отчёт, "не блокировать локальный GSI-сервер").
    pub backend_url: String,
    pub companion_token_configured: bool,
    pub backend_state: ConnectionState,
    pub backend_last_sent_at: Option<String>,
    pub backend_last_error: Option<String>,
    pub obs_config: ObsConfig,
    pub obs_connected: bool,
    pub obs_state: ConnectionState,
    pub obs_active_scene: Option<BroadcastScene>,
    pub obs_last_error: Option<String>,
    // WK-112 - OBS's own last-known streaming truth (from GetStreamStatus /
    // StreamStateChanged, see obs.rs's stream-state watcher), deliberately
    // separate from `obs_state`/`obs_connected` above: whether Companion
    // can currently talk to OBS at all is a different question from
    // whether OBS is currently streaming. `None` until the watcher has
    // learned it at least once (e.g. OBS unreachable since Companion
    // started) - never guessed.
    pub obs_streaming: Option<bool>,
    // WK-122 P0 diagnostics - RFC3339 timestamp of the last time the
    // stream-state watcher actually confirmed OBS's streaming truth (an
    // initial `GetStreamStatus`, a live `StreamStateChanged` event, or the
    // WK-122 heartbeat re-probe - see obs.rs's `run_stream_state_watcher_once`).
    // A missing match is only ever a symptom of no LocalSession being open;
    // this field is the one piece of evidence that answers "was the watcher
    // actually alive during the match, or silently stuck" without needing to
    // reproduce the bug - if this timestamp is stale by more than a couple of
    // heartbeat intervals while OBS was supposed to be streaming, the watcher
    // connection was the problem.
    pub obs_streaming_confirmed_at: Option<String>,
    // WK-114 - "Итоги стрима": true while the user has manually pinned OBS to
    // the Post Stream scene without ending the local session (see obs.rs's
    // `manual_summary_override`). Purely a display concern here - the pin
    // itself lives in `InnerState`/`resolve_desired_scene`.
    pub obs_manual_summary_active: bool,
    // WK-124 - global runtime visibility override for the local overlay
    // renderer (see overlay_server.rs's OverlayStateSnapshot). Purely a
    // display concern here, same shape as obs_manual_summary_active above -
    // the authoritative bool lives in InnerState/toggle_overlay_visible.
    // This is NOT BroadcastState: BroadcastState keeps resolving normally
    // while this is false, only the renderer's final visibility gate reads
    // it (see overlay-renderer/OverlayApp.tsx).
    pub overlay_visible: bool,
    // WK-153 P0 - local overlay HTTP server (:3666) bind status, mirroring
    // server_running/gsi_last_error above field-for-field (see overlay_server.rs's
    // init(), which now writes here exactly like server/mod.rs's start() already
    // does for GSI). Read by runtime_health.rs's overlay_server_component and by
    // the Оформление preview's readiness hook so a bind failure can surface its
    // REAL reason (port occupied, OS error, ...) instead of the frontend guessing
    // from a bare fetch failure.
    pub overlay_server_running: bool,
    pub overlay_state: ConnectionState,
    pub overlay_last_error: Option<String>,
    pub companion_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    #[default]
    Waiting,
    Connected,
    Recovering,
    Unavailable,
}

// Compatibility aggregate: one lock preserves atomic legacy snapshots and lock order.
// New code uses core/dota explicitly; Deref retains old game callers during migration.
#[derive(Debug, Default)]
pub struct InnerState {
    pub core: crate::core::state::CoreState,
    pub dota: crate::dota::state::DotaState,
}
impl std::ops::Deref for InnerState {
    type Target = crate::dota::state::DotaState;
    fn deref(&self) -> &Self::Target { &self.dota }
}
impl std::ops::DerefMut for InnerState {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.dota }
}

pub struct AppState(pub Mutex<InnerState>);

impl AppState {
    pub fn new() -> Self {
        AppState(Mutex::new(InnerState {
            dota: crate::dota::state::DotaState { overlay_visible: true, ..Default::default() },
            ..InnerState::default()
        }))
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        let inner = self.0.lock().unwrap();
        let gsi_state = if !inner.server_running {
            if inner.gsi_last_error.is_some() {
                ConnectionState::Recovering
            } else {
                ConnectionState::Unavailable
            }
        } else if inner
            .gsi_last_received_at
            .is_some_and(|at| at.elapsed().as_secs() <= 10)
        {
            ConnectionState::Connected
        } else if inner.gsi_last_received_at.is_some() {
            ConnectionState::Recovering
        } else {
            ConnectionState::Waiting
        };
        let backend_state = if !inner.core.backend_attempted {
            ConnectionState::Waiting
        } else if inner.core.backend_consecutive_failures == 0 {
            ConnectionState::Connected
        } else if inner.core.backend_consecutive_failures < crate::backend::MAX_RETRY_ATTEMPT {
            ConnectionState::Recovering
        } else {
            ConnectionState::Unavailable
        };
        let obs_state = if inner.obs_connected {
            ConnectionState::Connected
        } else if inner.obs_switch_pending.is_some() || inner.obs_check_pending || inner.obs_retry_at.is_some() {
            ConnectionState::Recovering
        } else if inner.obs_config.enabled || inner.obs_last_error.is_some() {
            ConnectionState::Unavailable
        } else {
            ConnectionState::Waiting
        };
        // Same shape as gsi_state above, minus the "packets received"
        // dimension the overlay server has no equivalent of - it's either
        // bound (Connected) or it isn't, and if it isn't, whether a real
        // bind attempt has already failed (Recovering, with the actual OS
        // error string) or genuinely hasn't run yet (Unavailable, the
        // sub-millisecond startup window before overlay_server::init's
        // first attempt completes - see its own doc comment).
        let overlay_state = if inner.overlay_server_running {
            ConnectionState::Connected
        } else if inner.overlay_last_error.is_some() {
            ConnectionState::Recovering
        } else {
            ConnectionState::Unavailable
        };
        StatusSnapshot {
            dota_found: inner.dota_path.is_some(),
            dota_path: inner.dota_path.clone(),
            dota_source: inner.dota_source.clone(),
            gsi_installed: inner.gsi_installed,
            gsi_config_path: inner.gsi_config_path.clone(),
            server_running: inner.server_running,
            gsi_state,
            gsi_last_error: inner.gsi_last_error.clone(),
            server_port: GSI_PORT,
            request_count: inner.request_count,
            last_event: inner.last_event.clone(),
            log_dir: inner.core.log_dir.clone(),
            legacy_cleanup_in_progress: crate::storage::legacy_cleanup_in_progress(),
            backend_url: DEFAULT_BACKEND_URL.to_string(),
            companion_token_configured: inner.core.companion_token.is_some(),
            backend_state,
            backend_last_sent_at: inner.core.backend_last_sent_at.clone(),
            backend_last_error: inner.core.backend_last_error.clone(),
            obs_config: {
                let mut config = inner.obs_config.clone();
                config.password.clear();
                config
            },
            obs_connected: inner.obs_connected,
            obs_state,
            obs_active_scene: inner.obs_active_scene,
            obs_last_error: inner.obs_last_error.clone(),
            obs_streaming: inner.obs_streaming,
            obs_streaming_confirmed_at: inner.obs_streaming_confirmed_at.clone(),
            obs_manual_summary_active: inner.obs_manual_summary_override,
            overlay_visible: inner.overlay_visible,
            overlay_server_running: inner.overlay_server_running,
            overlay_state,
            overlay_last_error: inner.overlay_last_error.clone(),
            companion_version: COMPANION_VERSION.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_state_is_waiting_before_first_attempt() {
        let state = AppState::new();
        assert_eq!(state.snapshot().backend_state, ConnectionState::Waiting);
    }

    // WK-124 - fresh AppState (a real Companion process start) must always
    // show the overlay - see InnerState::overlay_visible's doc comment for
    // why this is forced explicitly rather than relying on Default.
    #[test]
    fn overlay_is_visible_by_default_on_a_fresh_app_state() {
        let state = AppState::new();
        assert!(state.0.lock().unwrap().overlay_visible);
        assert!(state.snapshot().overlay_visible);
    }

    #[test]
    fn backend_state_is_waiting_once_token_configured_but_unchecked() {
        let state = AppState::new();
        state.0.lock().unwrap().core.companion_token = Some("token".to_string());
        let snapshot = state.snapshot();
        assert!(snapshot.companion_token_configured);
        assert_eq!(snapshot.backend_state, ConnectionState::Waiting);
    }

    #[test]
    fn backend_state_is_connected_after_first_success() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.core.backend_attempted = true;
            inner.core.backend_consecutive_failures = 0;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Connected);
    }

    #[test]
    fn backend_state_is_recovering_on_single_transient_failure() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.core.backend_attempted = true;
            inner.core.backend_consecutive_failures = 1;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Recovering);
    }

    #[test]
    fn backend_state_stays_recovering_while_under_retry_cap() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.core.backend_attempted = true;
            inner.core.backend_consecutive_failures = crate::backend::MAX_RETRY_ATTEMPT - 1;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Recovering);
    }

    #[test]
    fn backend_state_becomes_unavailable_once_retry_cap_is_reached() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.core.backend_attempted = true;
            inner.core.backend_consecutive_failures = crate::backend::MAX_RETRY_ATTEMPT;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Unavailable);
    }

    #[test]
    fn backend_state_recovers_to_connected_after_success_following_failures() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.core.backend_attempted = true;
            inner.core.backend_consecutive_failures = 3;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Recovering);
        {
            let mut inner = state.0.lock().unwrap();
            inner.core.backend_consecutive_failures = 0;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Connected);
    }

    #[test]
    fn missing_gsi_packets_alone_do_not_affect_backend_state() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.server_running = true;
            inner.core.backend_attempted = true;
            inner.core.backend_consecutive_failures = 0;
            // No GSI packets received at all (gsi_last_received_at stays None).
        }
        let snapshot = state.snapshot();
        assert_eq!(snapshot.gsi_state, ConnectionState::Waiting);
        assert_eq!(snapshot.backend_state, ConnectionState::Connected);
    }

    // Post-0.5.27 diagnostic pass (real-stream report: "Главная shows GSI/
    // Companion as not connected"). `gsi_state` had zero direct test
    // coverage despite `backend_state` above having 7 - these close that
    // gap and pin the exact 10s freshness boundary the manual report turned
    // out to hinge on. `Instant::now() - Duration::from_secs(n)` gives a
    // precise, fast (no real sleep) way to simulate "received n seconds
    // ago" - Instant supports `Sub<Duration>` directly.
    mod gsi_state_tests {
        use super::*;
        use std::time::Duration;

        #[test]
        fn unavailable_before_the_local_gsi_server_has_bound_at_all() {
            let state = AppState::new();
            // InnerState::default(): server_running=false, no gsi_last_error
            // yet either (that only gets set on an actual bind failure) - in
            // practice this is a sub-millisecond window at startup before
            // server::start()'s background thread completes its first bind,
            // not something a user is expected to ever actually observe.
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Unavailable);
        }

        #[test]
        fn recovering_if_the_local_gsi_listener_itself_failed_to_bind() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = false;
                inner.gsi_last_error = Some("Could not bind 127.0.0.1:3665: address in use".into());
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Recovering);
        }

        #[test]
        fn waiting_when_the_server_is_up_but_dota_has_never_sent_a_packet() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = true;
                // gsi_last_received_at stays None - GSI cfg may not even be
                // loaded by Dota yet (game not started, or started before
                // the cfg file existed - Dota only reads it at launch).
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Waiting);
        }

        #[test]
        fn connected_immediately_after_a_fresh_packet() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = true;
                inner.gsi_last_received_at = Some(Instant::now());
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Connected);
        }

        #[test]
        fn still_connected_right_at_the_10s_boundary() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = true;
                inner.gsi_last_received_at = Some(Instant::now() - Duration::from_secs(10));
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Connected);
        }

        #[test]
        fn recovering_just_past_the_10s_freshness_window() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = true;
                inner.gsi_last_received_at = Some(Instant::now() - Duration::from_secs(11));
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Recovering);
        }

        #[test]
        fn a_new_packet_recovers_gsi_state_back_to_connected() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = true;
                inner.gsi_last_received_at = Some(Instant::now() - Duration::from_secs(30));
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Recovering);
            {
                let mut inner = state.0.lock().unwrap();
                inner.gsi_last_received_at = Some(Instant::now());
            }
            assert_eq!(state.snapshot().gsi_state, ConnectionState::Connected);
        }

        // Regression guard for the exact symptom reported: a healthy,
        // actively-streaming GSI feed alongside a backend that hasn't
        // completed its first send yet must show gsi_state=Connected
        // regardless of backend_state - these are independent signals, one
        // must never mask or depend on the other.
        #[test]
        fn gsi_connected_is_independent_of_backend_state_being_unconfirmed() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.server_running = true;
                inner.gsi_last_received_at = Some(Instant::now());
                // backend_attempted stays false - no companion token yet, or
                // no send has completed - backend_state stays Waiting.
            }
            let snapshot = state.snapshot();
            assert_eq!(snapshot.gsi_state, ConnectionState::Connected);
            assert_eq!(snapshot.backend_state, ConnectionState::Waiting);
        }
    }

    // WK-153 P0 - production regression: Оформление preview and OBS Browser
    // Source both stopped updating, and the frontend's only actionable copy
    // was the nonsensical "проверьте что Companion запущен" (the user was
    // demonstrably already inside a running Companion). These pin the new
    // overlay_state/overlay_last_error derivation `overlay_server::init` now
    // feeds and runtime_health.rs's overlay_server_component consumes, so a
    // real bind failure reason (not a guess) can reach the UI.
    mod overlay_state_tests {
        use super::*;

        #[test]
        fn unavailable_before_the_local_overlay_server_has_bound_at_all() {
            let state = AppState::new();
            // Same sub-millisecond startup window gsi_state's own equivalent
            // test documents - not something a user is expected to observe.
            assert_eq!(state.snapshot().overlay_state, ConnectionState::Unavailable);
            assert!(!state.snapshot().overlay_server_running);
            assert_eq!(state.snapshot().overlay_last_error, None);
        }

        #[test]
        fn recovering_with_the_real_reason_when_the_bind_attempt_itself_failed() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.overlay_server_running = false;
                inner.overlay_last_error = Some("Could not bind 127.0.0.1:3666: Address already in use (os error 48)".into());
            }
            let snapshot = state.snapshot();
            assert_eq!(snapshot.overlay_state, ConnectionState::Recovering);
            assert_eq!(
                snapshot.overlay_last_error.as_deref(),
                Some("Could not bind 127.0.0.1:3666: Address already in use (os error 48)")
            );
        }

        #[test]
        fn connected_once_the_listener_is_actually_bound() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.overlay_server_running = true;
                inner.overlay_last_error = Some("stale error from a previous attempt".into());
            }
            // A successful bind clears the stale error in the real init()
            // supervisor (mirrors gsi_last_error's own clear-on-success) -
            // this test only pins that overlay_state itself reflects
            // `running` correctly regardless of a stale error field; the
            // clearing behavior is covered by overlay_server.rs's own tests.
            assert_eq!(state.snapshot().overlay_state, ConnectionState::Connected);
        }
    }

    // Parity coverage for obs_state (confirmed working correctly in manual
    // QA - these protect that, they don't change any behavior).
    mod obs_state_tests {
        use super::*;

        #[test]
        fn waiting_when_automation_is_off_and_nothing_has_failed() {
            let state = AppState::new();
            // InnerState::default(): obs_connected=false, obs_config.enabled
            // defaults false, no last_error, nothing pending.
            assert_eq!(state.snapshot().obs_state, ConnectionState::Waiting);
        }

        #[test]
        fn connected_when_the_obs_websocket_is_up() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.obs_connected = true;
            }
            assert_eq!(state.snapshot().obs_state, ConnectionState::Connected);
        }

        #[test]
        fn unavailable_when_automation_is_enabled_but_not_connected() {
            let state = AppState::new();
            {
                let mut inner = state.0.lock().unwrap();
                inner.obs_config.enabled = true;
            }
            assert_eq!(state.snapshot().obs_state, ConnectionState::Unavailable);
        }
    }
}
