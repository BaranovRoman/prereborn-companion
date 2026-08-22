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
    pub backend_connected: bool,
    pub backend_last_sent_at: Option<String>,
    pub backend_last_error: Option<String>,
    pub obs_config: ObsConfig,
    pub obs_connected: bool,
    pub obs_state: ConnectionState,
    pub obs_active_scene: Option<BroadcastScene>,
    pub obs_last_error: Option<String>,
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
    pub backend_connected: bool,
    pub backend_last_sent_at: Option<String>,
    pub backend_last_error: Option<String>,
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
}

pub struct AppState(pub Mutex<InnerState>);

impl AppState {
    pub fn new() -> Self {
        AppState(Mutex::new(InnerState::default()))
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
            backend_connected: inner.backend_connected,
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
            companion_version: COMPANION_VERSION.to_string(),
        }
    }
}
