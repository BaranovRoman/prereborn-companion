use serde::Serialize;
use std::sync::Mutex;

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
pub const COMPANION_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Default)]
pub struct LastEvent {
    pub timestamp: String,
    pub remote_addr: String,
    pub summary: String,
    pub payload_file: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatusSnapshot {
    pub dota_found: bool,
    pub dota_path: Option<String>,
    pub dota_source: Option<String>,
    pub gsi_installed: bool,
    pub gsi_config_path: Option<String>,
    pub server_running: bool,
    pub server_port: u16,
    pub request_count: u32,
    pub last_event: Option<LastEvent>,
    pub log_dir: Option<String>,
    // Отправка состояния на backend (services/... на бэкенде,
    // src-tauri/src/backend/mod.rs здесь) - полностью независима от
    // локального GSI-сервера выше: сетевые сбои никогда не должны его
    // останавливать (см. отчёт, "не блокировать локальный GSI-сервер").
    pub backend_url: String,
    pub companion_token_configured: bool,
    pub backend_connected: bool,
    pub backend_last_sent_at: Option<String>,
    pub backend_last_error: Option<String>,
}

#[derive(Debug, Default)]
pub struct InnerState {
    pub dota_path: Option<String>,
    pub dota_source: Option<String>,
    pub gsi_installed: bool,
    pub gsi_config_path: Option<String>,
    pub server_running: bool,
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
}

pub struct AppState(pub Mutex<InnerState>);

impl AppState {
    pub fn new() -> Self {
        AppState(Mutex::new(InnerState::default()))
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        let inner = self.0.lock().unwrap();
        StatusSnapshot {
            dota_found: inner.dota_path.is_some(),
            dota_path: inner.dota_path.clone(),
            dota_source: inner.dota_source.clone(),
            gsi_installed: inner.gsi_installed,
            gsi_config_path: inner.gsi_config_path.clone(),
            server_running: inner.server_running,
            server_port: GSI_PORT,
            request_count: inner.request_count,
            last_event: inner.last_event.clone(),
            log_dir: inner.log_dir.clone(),
            backend_url: DEFAULT_BACKEND_URL.to_string(),
            companion_token_configured: inner.companion_token.is_some(),
            backend_connected: inner.backend_connected,
            backend_last_sent_at: inner.backend_last_sent_at.clone(),
            backend_last_error: inner.backend_last_error.clone(),
        }
    }
}
