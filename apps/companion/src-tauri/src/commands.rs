use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::backend;
use crate::diagnostics::{self, DiagnosticsStatusSnapshot};
use crate::gsi::{config, finder};
use crate::hotkeys::{self, SkipHotkeyStatus};
use crate::obs::{self, BroadcastScene, ObsConfig};
use crate::silero::{self, SileroStatus, SileroVoice};
use crate::state::{AppState, StatusSnapshot, DEFAULT_WEB_ORIGIN};
use crate::storage;
use crate::tts::{self, TtsStatus};

#[tauri::command]
pub fn get_status(state: State<AppState>) -> StatusSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn find_dota(app: AppHandle, state: State<AppState>) -> StatusSnapshot {
    if let Some(path) = finder::find_dota_auto() {
        let mut inner = state.0.lock().unwrap();
        inner.dota_path = Some(path.clone());
        inner.dota_source = Some("auto".to_string());
        drop(inner);
        storage::append_rolling_log(&app, &format!("Dota auto-detected at {path}"));
    } else {
        storage::append_rolling_log(
            &app,
            "Dota auto-detection found nothing; manual folder pick required.",
        );
    }
    state.snapshot()
}

#[tauri::command]
pub fn pick_dota_folder(app: AppHandle, state: State<AppState>) -> Result<StatusSnapshot, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(state.snapshot());
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("Invalid folder selection: {e}"))?
        .to_string_lossy()
        .to_string();

    if !finder::validate_dota_path(&path) {
        storage::append_rolling_log(
            &app,
            &format!("Selected folder does not look like a Dota install: {path}"),
        );
        return Err(format!(
            "'{path}' does not contain a game/dota folder — is this really the Dota 2 install directory?"
        ));
    }

    {
        let mut inner = state.0.lock().unwrap();
        inner.dota_path = Some(path.clone());
        inner.dota_source = Some("manual".to_string());
    }
    storage::append_rolling_log(&app, &format!("Dota folder set manually: {path}"));
    Ok(state.snapshot())
}

#[tauri::command]
pub fn install_gsi(app: AppHandle, state: State<AppState>) -> Result<StatusSnapshot, String> {
    let dota_path = {
        let inner = state.0.lock().unwrap();
        inner.dota_path.clone()
    };
    let Some(dota_path) = dota_path else {
        return Err("No Dota folder selected yet.".to_string());
    };

    let target = config::install_gsi(&dota_path)?;
    {
        let mut inner = state.0.lock().unwrap();
        inner.gsi_installed = true;
        inner.gsi_config_path = Some(target.to_string_lossy().to_string());
    }
    storage::append_rolling_log(&app, &format!("GSI config written to {}", target.display()));
    Ok(state.snapshot())
}

#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = storage::logs_root(&app);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_dota_folder(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let dota_path = {
        let inner = state.0.lock().unwrap();
        inner.dota_path.clone()
    };
    let Some(dota_path) = dota_path else {
        return Err("No Dota folder selected yet.".to_string());
    };
    app.opener()
        .open_path(dota_path, None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_twitch_settings(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(format!("{DEFAULT_WEB_ORIGIN}/stream"), None::<String>)
        .map_err(|e| e.to_string())
}

// `async` so this never blocks the main IPC/UI thread (see the WK-78 note
// on get_twitch_chat/resend_current_state below for why a plain `fn` command
// is dangerous here) - the rename step is fast regardless of how many files
// the legacy directory holds, but a plain `fn` would still stall the UI
// thread for however long that filesystem call takes. The actual bulk
// deletion always happens on a separate background thread
// (storage::cleanup_legacy_payloads), so this command returns as soon as the
// (cheap) staging step is done - it never waits for the deletion to finish.
#[tauri::command]
pub async fn clear_log(app: AppHandle, state: State<'_, AppState>) -> Result<StatusSnapshot, String> {
    storage::clear_logs(&app).map_err(|e| e.to_string())?;
    {
        let mut inner = state.0.lock().unwrap();
        inner.request_count = 0;
        inner.last_event = None;
    }
    Ok(state.snapshot())
}

// Never logged - not even to the rolling log - unlike every other command
// here, which logs a one-line breadcrumb of what happened.
#[tauri::command]
pub fn save_companion_token(
    app: AppHandle,
    state: State<AppState>,
    token: String,
) -> Result<StatusSnapshot, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Токен не может быть пустым.".to_string());
    }

    storage::save_companion_token(&app, &token).map_err(|e| e.to_string())?;
    {
        let mut inner = state.0.lock().unwrap();
        inner.companion_token = Some(token);
        inner.backend_last_error = None;
    }
    storage::append_rolling_log(&app, "Companion token saved locally.");
    Ok(state.snapshot())
}


// WK-78 - both `async` so the blocking, network-bound backend call inside
// runs via `spawn_blocking` on Tauri's blocking pool instead of the main
// IPC/UI thread (a plain `fn` command here would freeze the whole window
// for up to REQUEST_TIMEOUT on every call - see backend/mod.rs).

#[tauri::command]
pub async fn get_twitch_chat(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::get_twitch_chat(&app).await
}
#[tauri::command]
pub async fn resend_current_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StatusSnapshot, String> {
    backend::resend_now(&app).await?;
    Ok(state.snapshot())
}

#[tauri::command]
pub fn save_obs_config(
    app: AppHandle,
    state: State<AppState>,
    mut config: ObsConfig,
) -> Result<StatusSnapshot, String> {
    config.host = config.host.trim().to_string();
    config.between_matches_scene = config.between_matches_scene.trim().to_string();
    config.draft_scene = config.draft_scene.trim().to_string();
    config.gameplay_scene = config.gameplay_scene.trim().to_string();
    if config.host.is_empty() {
        return Err("Укажите адрес OBS WebSocket.".into());
    }
    let mapping_changed = {
        let inner = state.0.lock().unwrap();
        if config.password.is_empty() {
            config.password = inner.obs_config.password.clone();
        }
        config.mapped_scene_names() != inner.obs_config.mapped_scene_names()
    };
    config.validate_mapping(None)?;
    let verification = obs::test_connection(&config);
    if let Ok(scenes) = &verification {
        if config.enabled || mapping_changed {
            config.validate_mapping(Some(scenes))?;
        }
    }
    storage::save_obs_config(&app, &config).map_err(|e| e.to_string())?;
    {
        let mut inner = state.0.lock().unwrap();
        let automation_was_enabled = inner.obs_config.enabled;
        inner.obs_config = config;
        if !automation_was_enabled && inner.obs_config.enabled {
            inner.obs_active_scene_name = None;
        }
        match &verification {
            Ok(_) => {
                inner.obs_connected = true;
                inner.obs_last_error = None;
            }
            Err(error) => {
                inner.obs_connected = false;
                inner.obs_last_error = Some(format!(
                    "Настройки сохранены, но сейчас невозможно проверить сцены: {error}"
                ));
            }
        }
    }
    storage::append_rolling_log(&app, "OBS scene switching settings saved locally.");
    let desired = {
        let inner = state.0.lock().unwrap();
        if inner.obs_config.enabled {
            inner.obs_active_scene.or_else(|| {
                inner
                    .last_gsi_payload
                    .as_ref()
                    .map(BroadcastScene::from_gsi)
            })
        } else {
            None
        }
    };
    if let Some(desired) = desired {
        obs::reapply_current_mapping(&app, desired);
    }
    Ok(state.snapshot())
}

#[tauri::command]
pub fn test_obs_connection(app: AppHandle, state: State<AppState>) -> Result<Vec<String>, String> {
    let config = state.0.lock().unwrap().obs_config.clone();
    match obs::test_connection(&config) {
        Ok(scenes) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = true;
            inner.obs_last_error = None;
            inner.obs_retry_attempt = 0;
            inner.obs_retry_at = None;
            drop(inner);
            storage::append_rolling_log(
                &app,
                &format!("OBS WebSocket connected; {} scenes found.", scenes.len()),
            );
            Ok(scenes)
        }
        Err(error) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = false;
            inner.obs_last_error = Some(error.clone());
            drop(inner);
            storage::append_rolling_log(&app, &format!("OBS WebSocket error: {error}"));
            Err(error)
        }
    }
}

#[tauri::command]
pub fn switch_obs_scene(
    app: AppHandle,
    state: State<AppState>,
    scene: BroadcastScene,
) -> Result<StatusSnapshot, String> {
    let config = state.0.lock().unwrap().obs_config.clone();
    match obs::switch_scene(&config, scene) {
        Ok(()) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = true;
            inner.obs_active_scene = Some(scene);
            inner.obs_active_scene_name = Some(scene.obs_scene_name(&config).to_string());
            inner.obs_last_error = None;
            drop(inner);
            storage::append_rolling_log(
                &app,
                &format!(
                    "OBS scene switched manually to {}.",
                    scene.obs_scene_name(&config)
                ),
            );
            Ok(state.snapshot())
        }
        Err(error) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = false;
            inner.obs_last_error = Some(error.clone());
            drop(inner);
            storage::append_rolling_log(&app, &format!("Manual OBS scene switch failed: {error}"));
            Err(error)
        }
    }
}

// Diagnostic-mode GSI capture - see src-tauri/src/diagnostics/mod.rs. Off by
// default, purely additive: none of these touch AppState, the GSI config,
// or anything the regular (non-diagnostic) UI reads.

#[tauri::command]
pub fn diagnostics_get_status(app: AppHandle) -> DiagnosticsStatusSnapshot {
    diagnostics::status(&app)
}

#[tauri::command]
pub fn diagnostics_start(app: AppHandle) -> Result<DiagnosticsStatusSnapshot, String> {
    diagnostics::start(&app)
}

#[tauri::command]
pub fn diagnostics_stop(app: AppHandle) -> Result<DiagnosticsStatusSnapshot, String> {
    diagnostics::stop(&app)
}

#[tauri::command]
pub fn diagnostics_clear(app: AppHandle) -> Result<DiagnosticsStatusSnapshot, String> {
    diagnostics::clear(&app)
}

// WK-75 - local Piper TTS sidecar (see src-tauri/src/tts.rs). Downloading
// resources and running synthesis can each take real time (network,
// ~15s synthesis timeout) - both commands are `async fn` so Tauri runs
// them off the main IPC thread instead of blocking other commands.

#[tauri::command]
pub fn get_tts_status(app: AppHandle) -> TtsStatus {
    tts::status(&app)
}

#[tauri::command]
pub async fn set_tts_enabled(app: AppHandle, enabled: bool) -> Result<TtsStatus, String> {
    tts::set_enabled(&app, enabled).await
}

#[tauri::command]
pub async fn synthesize_piper_tts(app: AppHandle, text: String, message_id: Option<String>) -> Result<String, String> {
    tts::synthesize_base64(&app, &text, message_id.as_deref())
}

// WK-81 - local Silero TTS sidecar (see src-tauri/src/silero.rs), the
// primary synthesis engine; Piper above remains the fallback. Same
// async-for-download/synthesis-latency reasoning as the Piper commands.

#[tauri::command]
pub fn get_silero_status(app: AppHandle) -> SileroStatus {
    silero::status(&app)
}

#[tauri::command]
pub async fn set_silero_enabled(app: AppHandle, enabled: bool) -> Result<SileroStatus, String> {
    silero::set_enabled(&app, enabled).await
}

#[tauri::command]
pub fn set_silero_voice(app: AppHandle, voice: SileroVoice) -> Result<SileroStatus, String> {
    silero::set_voice(&app, voice)
}

#[tauri::command]
pub async fn synthesize_silero_tts(
    app: AppHandle,
    text: String,
    voice: SileroVoice,
    message_id: Option<String>,
) -> Result<String, String> {
    silero::synthesize_base64(&app, &text, voice, message_id.as_deref())
}

/// Frontend-owned half of the TTS diagnostics trace (see
/// diagnostics/tts_trace.rs) - queue/playback-stage timestamps the Rust
/// side never observes. `source`/`local_time` are filled in here rather
/// than trusted from the caller. No-op unless a diagnostics session is
/// active (see `diagnostics::observe_tts_stage`), so this is safe to call
/// unconditionally/fire-and-forget from the frontend on every TTS message.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendTtsTraceInput {
    message_id: String,
    engine: Option<String>,
    stages: std::collections::BTreeMap<String, f64>,
    #[serde(default)]
    detail: serde_json::Value,
}

#[tauri::command]
pub fn diagnostics_trace_tts_frontend(app: AppHandle, event: FrontendTtsTraceInput) {
    use crate::diagnostics::tts_trace::{TtsTraceEvent, TtsTraceSource};
    let full = TtsTraceEvent {
        message_id: event.message_id,
        source: TtsTraceSource::Frontend,
        local_time: chrono::Local::now().to_rfc3339(),
        engine: event.engine,
        stages: event.stages,
        detail: event.detail,
    };
    diagnostics::observe_tts_stage(&app, &full);
}

// Global "skip current TTS" hotkey (see src-tauri/src/hotkeys.rs) - the
// hotkey itself only emits an event the frontend listens for
// (useTwitchChatSession.ts's skipTts()); these commands just let the
// settings UI read/change which combo is registered.

#[tauri::command]
pub fn get_skip_hotkey_status(app: AppHandle) -> SkipHotkeyStatus {
    hotkeys::status(&app)
}

#[tauri::command]
pub fn set_skip_hotkey(app: AppHandle, enabled: bool, shortcut: String) -> Result<SkipHotkeyStatus, String> {
    hotkeys::set_skip_hotkey(&app, enabled, shortcut)
}

#[tauri::command]
pub fn diagnostics_export(app: AppHandle) -> Result<String, String> {
    let default_name = format!(
        "gsi-diagnostics-{}.zip",
        chrono::Local::now().format("%Y-%m-%dT%H-%M-%S")
    );
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("ZIP archive", &["zip"])
        .blocking_save_file();

    let Some(picked) = picked else {
        return Err("Экспорт отменён.".to_string());
    };
    let output_path = picked
        .into_path()
        .map_err(|e| format!("Invalid save location: {e}"))?;

    diagnostics::export(&app, output_path)
}
