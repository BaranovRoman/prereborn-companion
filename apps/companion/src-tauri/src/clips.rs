use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::state::{AppState, DEFAULT_BACKEND_URL};
use crate::storage;

// WK-178 - "create a Twitch clip" global hotkey (F8 by default). Part of the
// Companion core: no OBS, no game plugin. The Twitch user token lives on the
// PreReborn backend (the existing Twitch OAuth link), so a press only asks
// the backend to clip; the backend talks to Helix Create Clip and answers
// once Get Clips has confirmed the clip (or with a coded failure).
//
// Same shape as hotkeys.rs (own config file, own register/unregister pair,
// rollback to the previous working combo on a failed registration) - kept as
// a separate module rather than a generic registry, per hotkeys.rs's note.

pub const CLIPS_STATE_EVENT: &str = "clips://state";
const DEFAULT_CLIP_SHORTCUT: &str = "F8";
// Helix Create Clip's `duration`: 5..60 s, 0.1 s precision, default 30.
pub const CLIP_DURATION_MIN_SECONDS: f64 = 5.0;
pub const CLIP_DURATION_MAX_SECONDS: f64 = 60.0;
pub const CLIP_DURATION_DEFAULT_SECONDS: f64 = 30.0;
const HISTORY_LIMIT: usize = 20;
// The backend holds the request open while it polls Get Clips (~15 s).
const CLIP_REQUEST_TIMEOUT: Duration = Duration::from_secs(40);
const ACCESS_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClipsConfig {
    pub enabled: bool,
    pub shortcut: String,
    pub duration_seconds: f64,
}

impl Default for ClipsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_CLIP_SHORTCUT.to_string(),
            duration_seconds: CLIP_DURATION_DEFAULT_SECONDS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipHistoryEntry {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub edit_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClipPhase {
    Idle,
    Creating { started_at: String },
    Succeeded { clip: ClipHistoryEntry },
    Failed { code: String, message: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClipFailure {
    pub code: String,
    pub message: String,
}

impl ClipFailure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipsStatus {
    pub enabled: bool,
    pub shortcut: String,
    /// Same distinction as SkipHotkeyStatus: enabled in settings is not the
    /// same as live with the OS.
    pub registered: bool,
    pub last_error: Option<String>,
    pub duration_seconds: f64,
    pub phase: ClipPhase,
    pub history: Vec<ClipHistoryEntry>,
}

pub struct ClipsInner {
    config: ClipsConfig,
    registered_shortcut: Option<String>,
    last_error: Option<String>,
    phase: ClipPhase,
    history: Vec<ClipHistoryEntry>,
}

impl Default for ClipsInner {
    fn default() -> Self {
        Self {
            config: ClipsConfig::default(),
            registered_shortcut: None,
            last_error: None,
            phase: ClipPhase::Idle,
            history: Vec::new(),
        }
    }
}

pub struct ClipsState {
    inner: Mutex<ClipsInner>,
    /// Held for the whole create+confirm round trip: repeated presses while a
    /// clip is being made are dropped instead of queuing more Twitch requests.
    in_flight: AtomicBool,
}

impl ClipsState {
    pub fn new() -> Self {
        Self { inner: Mutex::new(ClipsInner::default()), in_flight: AtomicBool::new(false) }
    }
}

fn data_path(app: &AppHandle, name: &str) -> PathBuf {
    app.path().app_data_dir().expect("app_data_dir must resolve").join(name)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: PathBuf) -> T {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)?)
}

fn load_config(app: &AppHandle) -> ClipsConfig {
    let mut config: ClipsConfig = read_json(data_path(app, "clips-config.json"));
    config.duration_seconds = clamp_duration(config.duration_seconds);
    config
}

fn save_config(app: &AppHandle, config: &ClipsConfig) -> std::io::Result<()> {
    write_json(data_path(app, "clips-config.json"), config)
}

fn load_history(app: &AppHandle) -> Vec<ClipHistoryEntry> {
    let mut history: Vec<ClipHistoryEntry> = read_json(data_path(app, "clips-history.json"));
    history.truncate(HISTORY_LIMIT);
    history
}

fn save_history(app: &AppHandle, history: &[ClipHistoryEntry]) -> std::io::Result<()> {
    write_json(data_path(app, "clips-history.json"), &history)
}

pub fn clamp_duration(seconds: f64) -> f64 {
    if !seconds.is_finite() {
        return CLIP_DURATION_DEFAULT_SECONDS;
    }
    (seconds.clamp(CLIP_DURATION_MIN_SECONDS, CLIP_DURATION_MAX_SECONDS) * 10.0).round() / 10.0
}

fn should_register(config: &ClipsConfig) -> bool {
    config.enabled && !config.shortcut.trim().is_empty()
}

fn validate_shortcut(enabled: bool, shortcut: &str) -> Result<(), String> {
    if enabled && shortcut.trim().is_empty() {
        return Err("Укажите комбинацию клавиш.".to_string());
    }
    Ok(())
}

/// Newest first, one entry per clip id, bounded.
fn push_history(history: &mut Vec<ClipHistoryEntry>, entry: ClipHistoryEntry) {
    history.retain(|existing| existing.id != entry.id);
    history.insert(0, entry);
    history.truncate(HISTORY_LIMIT);
}

fn try_begin(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

/// Turns the backend's answer into a history entry or a coded failure. The
/// backend's `error` text is already user-facing Russian copy.
fn interpret_clip_response(status: u16, body: Option<serde_json::Value>) -> Result<ClipHistoryEntry, ClipFailure> {
    if (200..300).contains(&status) {
        return body
            .and_then(|body| body.get("clip").cloned())
            .and_then(|clip| serde_json::from_value::<ClipHistoryEntry>(clip).ok())
            .ok_or_else(|| ClipFailure::new("backend_error", "Сервер PreReborn вернул неожиданный ответ."));
    }
    let code = body.as_ref().and_then(|b| b.get("code")).and_then(serde_json::Value::as_str);
    let message = body.as_ref().and_then(|b| b.get("error")).and_then(serde_json::Value::as_str);
    match (code, message) {
        (Some(code), Some(message)) => Err(ClipFailure::new(code, message)),
        _ if status == 401 => Err(ClipFailure::new(
            "account_not_connected",
            "Companion не подключён к аккаунту PreReborn. Войдите в Настройках.",
        )),
        _ => Err(ClipFailure::new("backend_error", format!("Сервер PreReborn ответил {status}."))),
    }
}

fn request_clip(token: &str, duration_seconds: f64) -> Result<ClipHistoryEntry, ClipFailure> {
    let unavailable = || {
        ClipFailure::new("backend_unavailable", "Не удалось связаться с сервером PreReborn. Проверьте подключение.")
    };
    let response = reqwest::blocking::Client::builder()
        .timeout(CLIP_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| unavailable())?
        .post(format!("{DEFAULT_BACKEND_URL}/stream/companion/twitch/clips"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "durationSeconds": duration_seconds }))
        .send()
        .map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    interpret_clip_response(status, response.json().ok())
}

fn companion_token(app: &AppHandle) -> Option<String> {
    app.state::<AppState>().0.lock().ok().and_then(|inner| inner.core.companion_token.clone())
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit(CLIPS_STATE_EVENT, status(app));
}

fn set_phase(app: &AppHandle, phase: ClipPhase) {
    if let Ok(mut inner) = app.state::<ClipsState>().inner.lock() {
        inner.phase = phase;
    }
    emit_status(app);
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        storage::append_rolling_log(app, &format!("Twitch clip: system notification failed ({error})"));
    }
}

fn finish(app: &AppHandle, result: Result<ClipHistoryEntry, ClipFailure>) {
    match result {
        Ok(clip) => {
            let history = {
                let state = app.state::<ClipsState>();
                let mut inner = state.inner.lock().unwrap();
                push_history(&mut inner.history, clip.clone());
                inner.history.clone()
            };
            if let Err(error) = save_history(app, &history) {
                storage::append_rolling_log(app, &format!("Twitch clip: history not saved ({error})"));
            }
            storage::append_rolling_log(app, &format!("Twitch clip created ({}).", clip.id));
            notify(app, "Клип создан", &clip.url);
            set_phase(app, ClipPhase::Succeeded { clip });
        }
        Err(failure) => {
            storage::append_rolling_log(app, &format!("Twitch clip failed ({}).", failure.code));
            notify(app, "Клип не создан", &failure.message);
            set_phase(app, ClipPhase::Failed { code: failure.code, message: failure.message });
        }
    }
}

/// Starts one clip. Returns false (and does nothing) while another clip is
/// still being created - this is the hotkey-mashing guard.
pub fn trigger(app: &AppHandle) -> bool {
    if !try_begin(&app.state::<ClipsState>().in_flight) {
        return false;
    }
    let duration = app.state::<ClipsState>().inner.lock().map(|inner| inner.config.duration_seconds).unwrap_or(CLIP_DURATION_DEFAULT_SECONDS);
    set_phase(app, ClipPhase::Creating { started_at: chrono::Utc::now().to_rfc3339() });
    let app = app.clone();
    std::thread::spawn(move || {
        let result = match companion_token(&app) {
            Some(token) => request_clip(&token, duration),
            None => Err(ClipFailure::new(
                "account_not_connected",
                "Companion не подключён к аккаунту PreReborn. Войдите в Настройках.",
            )),
        };
        finish(&app, result);
        app.state::<ClipsState>().in_flight.store(false, Ordering::Release);
    });
    true
}

fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                trigger(app);
            }
        })
        .map_err(|e| {
            format!("Не удалось зарегистрировать «{shortcut}»: комбинация занята другим приложением или недоступна ({e}).")
        })
}

fn unregister_shortcut(app: &AppHandle, shortcut: &str) {
    let _ = app.global_shortcut().unregister(shortcut);
}

pub fn init(app: &AppHandle) {
    let config = load_config(app);
    let history = load_history(app);
    let result = if should_register(&config) { register_shortcut(app, &config.shortcut) } else { Ok(()) };
    if let Err(error) = &result {
        storage::append_rolling_log(app, &format!("Twitch clip hotkey: {error}"));
    }
    let state = app.state::<ClipsState>();
    let mut inner = state.inner.lock().unwrap();
    inner.registered_shortcut =
        if result.is_ok() && should_register(&config) { Some(config.shortcut.clone()) } else { None };
    inner.last_error = result.err();
    inner.config = config;
    inner.history = history;
}

pub fn status(app: &AppHandle) -> ClipsStatus {
    let state = app.state::<ClipsState>();
    let inner = state.inner.lock().unwrap();
    ClipsStatus {
        enabled: inner.config.enabled,
        shortcut: inner.config.shortcut.clone(),
        registered: inner.registered_shortcut.is_some(),
        last_error: inner.last_error.clone(),
        duration_seconds: inner.config.duration_seconds,
        phase: inner.phase.clone(),
        history: inner.history.clone(),
    }
}

pub fn set_hotkey(app: &AppHandle, enabled: bool, shortcut: String) -> Result<ClipsStatus, String> {
    let shortcut = shortcut.trim().to_string();
    validate_shortcut(enabled, &shortcut)?;
    let state = app.state::<ClipsState>();
    let (previous_registered, previous_config) = {
        let inner = state.inner.lock().unwrap();
        (inner.registered_shortcut.clone(), inner.config.clone())
    };
    if let Some(previous) = &previous_registered {
        unregister_shortcut(app, previous);
    }
    let attempted = ClipsConfig { enabled, shortcut, ..previous_config.clone() };
    let attempt = if should_register(&attempted) { register_shortcut(app, &attempted.shortcut) } else { Ok(()) };
    if let Err(error) = attempt {
        // Roll back to what worked before rather than leaving no hotkey.
        if let Some(previous) = &previous_registered {
            let _ = register_shortcut(app, previous);
        }
        state.inner.lock().unwrap().last_error = Some(error.clone());
        emit_status(app);
        return Err(error);
    }
    let persisted = save_config(app, &attempted);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.registered_shortcut = if should_register(&attempted) { Some(attempted.shortcut.clone()) } else { None };
        inner.last_error = persisted.err().map(|e| format!("Настройка применена, но не сохранена на диск: {e}"));
        inner.config = attempted.clone();
    }
    storage::append_rolling_log(
        app,
        &format!(
            "Twitch clip hotkey {}.",
            if attempted.enabled { format!("set to {}", attempted.shortcut) } else { "disabled".to_string() }
        ),
    );
    emit_status(app);
    Ok(status(app))
}

pub fn set_duration(app: &AppHandle, duration_seconds: f64) -> Result<ClipsStatus, String> {
    let state = app.state::<ClipsState>();
    let config = {
        let mut inner = state.inner.lock().unwrap();
        inner.config.duration_seconds = clamp_duration(duration_seconds);
        inner.config.clone()
    };
    save_config(app, &config).map_err(|e| format!("Длительность не сохранена на диск: {e}"))?;
    emit_status(app);
    Ok(status(app))
}

/// Opens a clip that is already in the local history - never an arbitrary
/// URL handed in from the webview.
pub fn clip_url(app: &AppHandle, id: &str) -> Result<String, String> {
    let state = app.state::<ClipsState>();
    let inner = state.inner.lock().unwrap();
    inner
        .history
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.url.clone())
        .ok_or_else(|| "Клип не найден в истории.".to_string())
}

pub fn clear_history(app: &AppHandle) -> Result<ClipsStatus, String> {
    app.state::<ClipsState>().inner.lock().unwrap().history.clear();
    save_history(app, &[]).map_err(|e| format!("История не очищена на диске: {e}"))?;
    emit_status(app);
    Ok(status(app))
}

/// Whether the linked Twitch token can create clips (clips:edit) - the
/// Settings block uses this to offer a re-auth before the first press fails.
pub async fn access(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = companion_token(app).ok_or_else(|| "Companion не подключён к аккаунту.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let response = reqwest::blocking::Client::builder()
            .timeout(ACCESS_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("HTTP client error: {error}"))?
            .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/twitch/clips/access"))
            .bearer_auth(&token)
            .send()
            .map_err(|_| "Не удалось проверить доступ к клипам: сервер PreReborn недоступен.".to_string())?;
        if !response.status().is_success() {
            return Err(format!("Backend ответил {}", response.status()));
        }
        response.json().map_err(|error| format!("Неверный ответ сервера: {error}"))
    })
    .await
    .map_err(|error| format!("Internal error: {error}"))?
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<ClipsState>();
    if let Ok(mut inner) = state.inner.lock() {
        if let Some(shortcut) = inner.registered_shortcut.take() {
            unregister_shortcut(app, &shortcut);
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> ClipHistoryEntry {
        ClipHistoryEntry {
            id: id.to_string(),
            url: format!("https://clips.twitch.tv/{id}"),
            edit_url: None,
            title: None,
            duration_seconds: Some(30.0),
            created_at: "2026-10-21T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn default_config_is_f8_enabled_30_seconds() {
        let config = ClipsConfig::default();
        assert!(config.enabled);
        assert_eq!(config.shortcut, "F8");
        assert_eq!(config.duration_seconds, 30.0);
    }

    #[test]
    fn an_empty_or_partial_persisted_config_falls_back_to_defaults() {
        let config: ClipsConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(config, ClipsConfig::default());
        let config: ClipsConfig = serde_json::from_value(serde_json::json!({ "enabled": false })).unwrap();
        assert_eq!(config.shortcut, "F8");
        assert!(!config.enabled);
    }

    #[test]
    fn config_round_trips_through_json() {
        let config = ClipsConfig { enabled: true, shortcut: "Ctrl+F9".to_string(), duration_seconds: 45.0 };
        let restored: ClipsConfig = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(restored, config);
    }

    #[test]
    fn the_default_f8_shortcut_parses() {
        use std::str::FromStr;
        tauri_plugin_global_shortcut::Shortcut::from_str(DEFAULT_CLIP_SHORTCUT).expect("F8 must parse");
    }

    #[test]
    fn duration_is_clamped_to_twitchs_range() {
        assert_eq!(clamp_duration(2.0), 5.0);
        assert_eq!(clamp_duration(120.0), 60.0);
        assert_eq!(clamp_duration(12.34), 12.3);
        assert_eq!(clamp_duration(f64::NAN), 30.0);
    }

    #[test]
    fn disabled_or_blank_hotkeys_are_never_registered() {
        assert!(!should_register(&ClipsConfig { enabled: false, ..ClipsConfig::default() }));
        assert!(!should_register(&ClipsConfig { shortcut: "  ".to_string(), ..ClipsConfig::default() }));
        assert!(should_register(&ClipsConfig::default()));
        assert!(validate_shortcut(true, "").is_err());
        assert!(validate_shortcut(false, "").is_ok());
    }

    #[test]
    fn a_second_press_while_a_clip_is_in_flight_is_ignored() {
        let flag = AtomicBool::new(false);
        assert!(try_begin(&flag));
        assert!(!try_begin(&flag));
        assert!(!try_begin(&flag));
        flag.store(false, Ordering::Release);
        assert!(try_begin(&flag));
    }

    #[test]
    fn history_is_newest_first_deduplicated_and_bounded() {
        let mut history = Vec::new();
        push_history(&mut history, entry("a"));
        push_history(&mut history, entry("b"));
        push_history(&mut history, entry("a"));
        assert_eq!(history.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        for i in 0..30 {
            push_history(&mut history, entry(&format!("c{i}")));
        }
        assert_eq!(history.len(), HISTORY_LIMIT);
        assert_eq!(history[0].id, "c29");
    }

    #[test]
    fn a_successful_backend_response_becomes_a_history_entry() {
        let body = serde_json::json!({ "clip": {
            "id": "Clip1", "url": "https://clips.twitch.tv/Clip1", "editUrl": "https://clips.twitch.tv/Clip1/edit",
            "title": "Rampage", "durationSeconds": 30, "createdAt": "2026-10-21T10:00:00Z", "thumbnailUrl": null
        }});
        let clip = interpret_clip_response(201, Some(body)).unwrap();
        assert_eq!(clip.id, "Clip1");
        assert_eq!(clip.title.as_deref(), Some("Rampage"));
        assert_eq!(clip.edit_url.as_deref(), Some("https://clips.twitch.tv/Clip1/edit"));
    }

    #[test]
    fn coded_backend_failures_keep_their_code_and_message() {
        for code in ["not_live", "clips_restricted", "reauth_required", "twitch_unavailable", "clip_failed"] {
            let body = serde_json::json!({ "code": code, "error": "текст" });
            assert_eq!(interpret_clip_response(409, Some(body)), Err(ClipFailure::new(code, "текст")));
        }
    }

    #[test]
    fn uncoded_failures_are_classified_without_leaking_details() {
        assert_eq!(interpret_clip_response(401, None).unwrap_err().code, "account_not_connected");
        assert_eq!(interpret_clip_response(500, None).unwrap_err().code, "backend_error");
        assert_eq!(interpret_clip_response(201, Some(serde_json::json!({}))).unwrap_err().code, "backend_error");
    }

    #[test]
    fn phase_serializes_with_a_kind_tag_and_camel_case_fields() {
        let value = serde_json::to_value(ClipPhase::Creating { started_at: "t".to_string() }).unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "creating", "startedAt": "t" }));
        let value = serde_json::to_value(ClipPhase::Failed { code: "not_live".into(), message: "m".into() }).unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "failed", "code": "not_live", "message": "m" }));
    }
}
