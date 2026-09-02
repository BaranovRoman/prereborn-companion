use crate::obs::{BroadcastScene, ObsConfig};
use serde::Serialize;
use std::sync::Mutex;
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

#[derive(Debug, Default)]
pub struct InnerState {
    pub dota_path: Option<String>,
    pub dota_source: Option<String>,
    pub gsi_installed: bool,
    pub gsi_config_path: Option<String>,
    pub server_running: bool,
    pub gsi_last_error: Option<String>,
    pub gsi_last_received_at: Option<Instant>,
    pub request_count: u32,
    pub last_event: Option<LastEvent>,
    pub log_dir: Option<String>,

    pub companion_token: Option<String>,
    // Whether at least one send attempt has completed (success or failure)
    // since Companion started or since the token was last (re)saved - lets
    // `snapshot()` tell "never checked yet" (Waiting) apart from "checked
    // and it failed" (Recovering/Unavailable), which a single bool cannot.
    pub backend_attempted: bool,
    // Consecutive failed send attempts. Reset to 0 on any success or on
    // token save. Compared against `backend::MAX_RETRY_ATTEMPT` (the same
    // cap the WK-78 backoff itself uses) to distinguish a transient blip
    // (still Recovering) from a sustained outage (Unavailable).
    pub backend_consecutive_failures: u32,
    pub backend_last_sent_at: Option<String>,
    pub backend_last_error: Option<String>,
    // Reliability pass - set the moment `backend_consecutive_failures` goes
    // from 0 to 1 (see backend::record_connectivity), cleared on the next
    // success. Lets a recovery log line report how long the backend was
    // actually degraded, instead of just that it recovered - see the
    // connectivity report for why `backend_state` needed a connectivity
    // signal from more than just the legacy gsi-state heartbeat.
    pub backend_degraded_since: Option<Instant>,
    // Последнее распарсенное (valid JSON) GSI-состояние - независимо от
    // того, было ли оно уже отправлено. `dirty` отличает "есть новое,
    // ещё не отправленное состояние" (используется фоновым троттлингом раз
    // в ~1с) от "отправить то же самое состояние ещё раз" (ручная кнопка
    // Resend всегда шлёт last_gsi_payload, даже если dirty=false).
    pub last_gsi_payload: Option<serde_json::Value>,
    pub dirty: bool,
    // Monotonic generation of last_gsi_payload. The sender records the
    // generation it started sending and only clears dirty if no newer GSI
    // payload arrived while the HTTP request was in flight.
    pub payload_version: u64,
    pub obs_config: ObsConfig,
    pub obs_connected: bool,
    pub obs_active_scene: Option<BroadcastScene>,
    pub obs_active_scene_name: Option<String>,
    pub obs_switch_pending: Option<BroadcastScene>,
    pub obs_retry_scene: Option<BroadcastScene>,
    pub obs_retry_attempt: u32,
    pub obs_retry_at: Option<Instant>,
    pub obs_last_checked_at: Option<Instant>,
    pub obs_check_pending: bool,
    pub obs_last_error: Option<String>,
    // WK-126 - RuntimeHealth: the stream-state watcher (obs.rs's
    // start_stream_state_watcher) is a SECOND, independent OBS WebSocket
    // connection that runs unconditionally (see its own WK-116 doc comment),
    // unlike `obs_connected` above, which only ever gets probed when scene
    // automation is enabled. Without this, RuntimeHealth's OBS component
    // would incorrectly read "unknown/unavailable" whenever automation is
    // off even though OBS is actually reachable - these two fields expose
    // that watcher's own connectivity truth, mirroring `obs_connected`/
    // `obs_last_error`'s shape but sourced from the other socket.
    pub obs_watcher_connected: bool,
    pub obs_watcher_last_error: Option<String>,
    // WK-99, now set by local_runtime::lifecycle::apply (WK-113) whenever
    // the local, OBS-driven session lifecycle finalizes an end/start - no
    // longer by a backend poll (see backend/mod.rs's removed
    // poll_session_state). Also still set by the legacy manual "Завершить
    // стрим" button on success (backend::end_stream_session). Read by
    // obs::resolve_desired_scene. Defaults to `false` (Default derive),
    // matching "unknown session state behaves like active" - automation
    // runs normally until told otherwise, never the reverse.
    pub session_ended: bool,
    // WK-106 - Custom Game Sounds. Persisted settings/bindings/managed asset
    // registry (see game_sounds/config.rs), loaded once at startup
    // (game_sounds::init) and kept here the same way obs_config is. The
    // detector's diff baseline is deliberately *not* persisted - it lives
    // only in memory, so every Companion restart (and every hero-swap reset,
    // see events::hero_identity_changed) starts from `None`/"no previous
    // snapshot", which is exactly the initial-snapshot-safety the task
    // requires: nothing on the very first tick is ever treated as a new
    // item/ability use.
    pub game_sounds_settings: crate::game_sounds::config::GameSoundSettings,
    pub game_sounds_previous_gsi: Option<serde_json::Value>,
    // WK-112 - see the field doc on StatusSnapshot::obs_streaming above.
    pub obs_streaming: Option<bool>,
    // WK-122 P0 diagnostics - see the field doc on
    // StatusSnapshot::obs_streaming_confirmed_at above.
    pub obs_streaming_confirmed_at: Option<String>,
    // WK-114 - "Итоги стрима" manual scene pin (see obs.rs's
    // `resolve_desired_scene`): while true, every automatic scene resolution
    // (GSI ticks, remote commands, config reapply) resolves to Post Stream
    // instead of the normally-derived scene, exactly like `session_ended`
    // already does - this is a second, independent reason to force Post
    // Stream, not a replacement for it. Cleared automatically whenever a new
    // local session starts (`obs::handle_session_state(_, false)`) so it can
    // never leak into the next stream, and manually via `resume_live_scene`.
    // Defaults to `false` (Default derive) - automation is unaffected until
    // the user explicitly asks to see the summary scene.
    pub obs_manual_summary_override: bool,
    // WK-115 audit - Post Stream is an optional OBS binding: the streamer
    // may never have created that scene in OBS at all. Set by
    // obs::schedule_switch when a switch to Post Stream fails specifically
    // because OBS reports the mapped scene doesn't exist (obs-websocket
    // RESOURCE_NOT_FOUND, see obs::is_resource_not_found) - from then on,
    // obs::resolve_desired_scene falls back to BetweenMatches instead of
    // repeatedly retrying a switch that can only fail the same way, so an
    // ended/manually-pinned session never leaves OBS stuck on a stale
    // gameplay/draft scene just because Post Stream isn't set up. Cleared
    // by obs::handle_session_state on the next local session start and by
    // commands::save_obs_config, so fixing the scene (or the mapping) gets
    // a fresh attempt without requiring a Companion restart. Defaults to
    // `false` (Default derive) - unaffected until a real "scene not found"
    // failure is observed.
    pub obs_post_stream_unavailable: bool,
    // WK-122 §19 - OverlayLayout cache. Kept as an opaque `serde_json::Value`
    // (same "pass through untyped" pattern `last_gsi_payload`/
    // `get_stream_session`'s return type already use in this codebase) since
    // Rust never needs to interpret individual widget fields - it only
    // fetches/caches/serves the same JSON blob apps/api's
    // `/account/me/overlay-layout` and `/companion/overlay-layout` already
    // exchange with a real browser editor. `overlay_layout_version` is
    // bumped on every successful fetch/save so overlay_server.rs's SSE
    // stream (already pushing OverlayStateSnapshot on every scene change)
    // can tell the local renderer "the layout changed, re-fetch it" without
    // a second push channel.
    pub overlay_layout: Option<serde_json::Value>,
    pub overlay_layout_version: u64,
    pub queue_settings: Option<serde_json::Value>,
    pub account_overlay_data: Option<serde_json::Value>,
    /// Normalized bounded Twitch chat status returned to the existing Chat
    /// UI. The localhost overlay reuses this cache; it never opens another
    /// Twitch connection.
    pub twitch_chat: Option<serde_json::Value>,
    pub last_history_log_signature: Option<String>,
    // WK-124 - global runtime visibility override for the local overlay
    // renderer: OFF makes the final renderer output fully transparent
    // without touching BroadcastState, the local overlay server, SSE, GSI,
    // LocalSession, OBS scene automation, or any other runtime subsystem -
    // see overlay_server.rs's OverlayStateSnapshot and
    // commands::toggle_overlay_visible. Deliberately in-memory only (not
    // persisted to SQLite/config/localStorage): a fresh Companion process
    // always starts with the overlay visible, so a streamer can never begin
    // a new stream with an unexpectedly hidden Browser Source just because
    // they forgot to turn it back on last time. `#[derive(Default)]` above
    // gives this `false`; `AppState::new()` below explicitly forces it to
    // `true` immediately after construction so the derive's per-field
    // default never has to special-case one bool among many.
    pub overlay_visible: bool,
}

pub struct AppState(pub Mutex<InnerState>);

impl AppState {
    pub fn new() -> Self {
        AppState(Mutex::new(InnerState {
            overlay_visible: true,
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
        let backend_state = if !inner.backend_attempted {
            ConnectionState::Waiting
        } else if inner.backend_consecutive_failures == 0 {
            ConnectionState::Connected
        } else if inner.backend_consecutive_failures < crate::backend::MAX_RETRY_ATTEMPT {
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
            log_dir: inner.log_dir.clone(),
            legacy_cleanup_in_progress: crate::storage::legacy_cleanup_in_progress(),
            backend_url: DEFAULT_BACKEND_URL.to_string(),
            companion_token_configured: inner.companion_token.is_some(),
            backend_state,
            backend_last_sent_at: inner.backend_last_sent_at.clone(),
            backend_last_error: inner.backend_last_error.clone(),
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
        state.0.lock().unwrap().companion_token = Some("token".to_string());
        let snapshot = state.snapshot();
        assert!(snapshot.companion_token_configured);
        assert_eq!(snapshot.backend_state, ConnectionState::Waiting);
    }

    #[test]
    fn backend_state_is_connected_after_first_success() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.backend_attempted = true;
            inner.backend_consecutive_failures = 0;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Connected);
    }

    #[test]
    fn backend_state_is_recovering_on_single_transient_failure() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.backend_attempted = true;
            inner.backend_consecutive_failures = 1;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Recovering);
    }

    #[test]
    fn backend_state_stays_recovering_while_under_retry_cap() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.backend_attempted = true;
            inner.backend_consecutive_failures = crate::backend::MAX_RETRY_ATTEMPT - 1;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Recovering);
    }

    #[test]
    fn backend_state_becomes_unavailable_once_retry_cap_is_reached() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.backend_attempted = true;
            inner.backend_consecutive_failures = crate::backend::MAX_RETRY_ATTEMPT;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Unavailable);
    }

    #[test]
    fn backend_state_recovers_to_connected_after_success_following_failures() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.backend_attempted = true;
            inner.backend_consecutive_failures = 3;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Recovering);
        {
            let mut inner = state.0.lock().unwrap();
            inner.backend_consecutive_failures = 0;
        }
        assert_eq!(state.snapshot().backend_state, ConnectionState::Connected);
    }

    #[test]
    fn missing_gsi_packets_alone_do_not_affect_backend_state() {
        let state = AppState::new();
        {
            let mut inner = state.0.lock().unwrap();
            inner.server_running = true;
            inner.backend_attempted = true;
            inner.backend_consecutive_failures = 0;
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
