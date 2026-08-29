use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::backend;
use crate::diagnostics::{self, DiagnosticsStatusSnapshot};
use crate::game_sounds::{
    self,
    config::GameSoundSettings,
    events::GameSoundEventKind,
    GameSoundCatalog, GameSoundPreviewPayload,
};
use crate::gsi::{config, finder};
use crate::hotkeys::{self, SkipHotkeyStatus};
use crate::local_runtime::lifecycle::{self, LifecycleStatus};
use crate::obs::{self, BroadcastScene, ObsConfig};
use crate::silero::{self, SileroStatus, SileroVoice};
use crate::state::{AppState, StatusSnapshot, DEFAULT_WEB_ORIGIN};
use crate::storage;

#[tauri::command]
pub fn get_status(state: State<AppState>) -> StatusSnapshot {
    state.snapshot()
}

// WK-112 - OBS-driven local stream lifecycle. Read-only status plus the two
// stale-session manual-recovery actions (see local_runtime::lifecycle) -
// deliberately no "start"/"end" commands here: normal lifecycle is fully
// automatic, driven by OBS Start/Stop Streaming, not by anything the UI
// calls directly.
#[tauri::command]
pub fn get_local_lifecycle_status(app: AppHandle) -> LifecycleStatus {
    lifecycle::status(&app)
}

#[tauri::command]
pub fn local_lifecycle_stale_continue(app: AppHandle) -> Result<(), String> {
    lifecycle::stale_recovery_continue(&app)
}

#[tauri::command]
pub fn local_lifecycle_stale_end(app: AppHandle) -> Result<(), String> {
    lifecycle::stale_recovery_end(&app)
}

// WK-114 - read-only projection of the local session/match/MMR data for the
// Home page (current session rating, W/L, current + recent matches) - see
// local_runtime::summary's doc comment for why this is the first command to
// expose LocalSession/LocalMatch data beyond the lifecycle state machine.
#[tauri::command]
pub fn get_local_session_summary(app: AppHandle) -> crate::local_runtime::summary::LocalSessionSummary {
    crate::local_runtime::summary::get(&app)
}

// WK-119 - sync_outbox (WK-113) had zero UI surface until now: pending/
// dead-lettered counts for ProblemBar's pending/dead-letter states and
// Диагностика's detail view. Read-only, same "inert if local runtime failed
// to open" contract as the two commands above.
#[tauri::command]
pub fn get_sync_outbox_status(app: AppHandle) -> crate::local_runtime::sync::SyncOutboxStatus {
    crate::local_runtime::sync::status(&app)
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
        // WK-94 - a (re)saved token invalidates whatever backend_state the
        // previous token earned: clear the old error/failure streak and
        // "have we attempted yet" flag so the UI reads Waiting again
        // instead of carrying over a stale Unavailable/Recovering verdict.
        inner.backend_last_error = None;
        inner.backend_attempted = false;
        inner.backend_consecutive_failures = 0;
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
pub async fn get_stream_session(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::get_stream_session(&app).await
}

#[tauri::command]
pub async fn reset_stream_session(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::reset_stream_session(&app).await
}

#[tauri::command]
pub async fn end_stream_session(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::end_stream_session(&app).await
}

#[tauri::command]
pub async fn get_favorite_heroes(app: AppHandle) -> Result<Vec<u32>, String> {
    backend::get_favorite_heroes(&app).await
}

#[tauri::command]
pub async fn save_favorite_heroes(app: AppHandle, hero_ids: Vec<u32>) -> Result<Vec<u32>, String> {
    backend::save_favorite_heroes(&app, hero_ids).await
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
        // WK-115 audit - a settings save is the user actively fixing their
        // OBS setup (e.g. creating/renaming the Post Stream scene); give
        // the mapped scene a fresh attempt instead of staying downgraded to
        // the BetweenMatches fallback from an earlier failed switch.
        inner.obs_post_stream_unavailable = false;
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

// WK-121 - OBS Browser Source migration (§13). Read-only detection - never
// mutates AppState.obs_connected/obs_last_error (those track the scene-
// switching connection's health, a separate concern from "is there a
// PreReborn Browser Source and where does it point").
#[tauri::command]
pub fn detect_obs_browser_source(state: State<AppState>) -> Result<obs::BrowserSourceDetection, String> {
    let config = state.0.lock().unwrap().obs_config.clone();
    obs::detect_browser_source(&config)
}

#[tauri::command]
pub fn migrate_obs_browser_source(
    app: AppHandle,
    state: State<AppState>,
    input_name: String,
) -> Result<(), String> {
    let config = state.0.lock().unwrap().obs_config.clone();
    let result = obs::migrate_browser_source(&config, &input_name);
    match &result {
        Ok(()) => storage::append_rolling_log(
            &app,
            &format!("OBS Browser Source '{input_name}' migrated to the local overlay URL."),
        ),
        Err(error) => storage::append_rolling_log(
            &app,
            &format!("OBS Browser Source migration failed for '{input_name}': {error}"),
        ),
    }
    result
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

// WK-114 - "Итоги стрима": a manual OBS scene action, not a lifecycle action.
// Switches to Post Stream (via the exact same primitive `switch_obs_scene`
// above uses) and pins it there via `obs_manual_summary_override` so
// automation (if enabled) doesn't drag the scene back on the next GSI tick -
// see `obs::resolve_desired_scene`. Deliberately does NOT touch
// `session_ended`, does not call `local_runtime::lifecycle`, and enqueues no
// sync event: the local session and the real OBS stream both keep running.
#[tauri::command]
pub fn show_stream_summary_scene(app: AppHandle, state: State<AppState>) -> Result<StatusSnapshot, String> {
    let config = state.0.lock().unwrap().obs_config.clone();
    match obs::switch_scene(&config, BroadcastScene::PostStream) {
        Ok(()) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_manual_summary_override = true;
            inner.obs_connected = true;
            inner.obs_active_scene = Some(BroadcastScene::PostStream);
            inner.obs_active_scene_name = Some(BroadcastScene::PostStream.obs_scene_name(&config).to_string());
            inner.obs_last_error = None;
            drop(inner);
            storage::append_rolling_log(&app, "Manual 'Итоги стрима' scene shown (Post Stream), session unaffected.");
            Ok(state.snapshot())
        }
        Err(error) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = false;
            inner.obs_last_error = Some(error.clone());
            drop(inner);
            storage::append_rolling_log(&app, &format!("'Итоги стрима' scene switch failed: {error}"));
            Err(error)
        }
    }
}

// WK-114 - reverses show_stream_summary_scene: clears the pin only. If OBS
// automation is enabled, the very next GSI tick (~1s) naturally resolves and
// switches to whatever scene the current match phase actually implies (see
// obs::handle_gsi) - no scene is forced here. If automation is disabled
// (manual mode), the user already controls scenes by hand via the existing
// scene buttons, same as for any other manual scene change.
#[tauri::command]
pub fn resume_live_scene(state: State<AppState>) -> StatusSnapshot {
    state.0.lock().unwrap().obs_manual_summary_override = false;
    state.snapshot()
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

// WK-81 - local Silero TTS sidecar (see src-tauri/src/silero.rs), the
// primary (and, since WK-80 removed Piper, only local) synthesis engine -
// system speechSynthesis is the fallback, handled entirely on the frontend.
// Downloading resources and running synthesis can each take real time
// (network, subprocess startup) - both commands are `async fn` so Tauri
// runs them off the main IPC thread instead of blocking other commands.

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

// WK-106 - Custom Game Sounds. Detection itself runs unconditionally inside
// server/mod.rs's process_gsi_body -> game_sounds::handle_gsi (mirrors how
// obs::handle_gsi is wired in) - everything here is just the settings/
// catalog/managed-file surface the "Звуки" UI reads and writes through.

#[tauri::command]
pub fn get_game_sound_catalog() -> GameSoundCatalog {
    game_sounds::get_catalog()
}

#[tauri::command]
pub fn get_game_sound_settings(app: AppHandle) -> GameSoundSettings {
    game_sounds::get_settings(&app)
}

#[tauri::command]
pub fn update_game_sound_master(app: AppHandle, enabled: bool, volume: u8) -> Result<GameSoundSettings, String> {
    game_sounds::update_master(&app, enabled, volume)
}

#[tauri::command]
pub fn set_game_sound_binding(
    app: AppHandle,
    event_id: String,
    kind: GameSoundEventKind,
    asset_id: String,
) -> Result<GameSoundSettings, String> {
    game_sounds::set_binding(&app, event_id, kind, asset_id)
}

#[tauri::command]
pub fn remove_game_sound_binding(app: AppHandle, event_id: String) -> Result<GameSoundSettings, String> {
    game_sounds::remove_binding(&app, event_id)
}

// WK-106 self-review - import and bind happen as one Tauri command
// (game_sounds::import_and_bind) rather than two separate round-trips, so a
// failure partway through can never leave an imported file with nothing
// bound to it (see that function's doc comment).
#[tauri::command]
pub fn import_and_bind_game_sound(
    app: AppHandle,
    event_id: String,
    kind: GameSoundEventKind,
) -> Result<GameSoundSettings, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Audio", &["wav", "mp3", "ogg"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Err("Выбор файла отменён.".to_string());
    };
    let original_name = picked
        .as_path()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "sound".to_string());
    let path = picked.into_path().map_err(|e| format!("Некорректный путь к файлу: {e}"))?;
    game_sounds::import_and_bind(&app, event_id, kind, path, original_name)
}

#[tauri::command]
pub fn preview_game_sound(app: AppHandle, asset_id: String) -> Result<GameSoundPreviewPayload, String> {
    game_sounds::preview_sound(&app, asset_id)
}

// WK-108 latency addendum - the frontend half of the Game Sounds timing
// instrumentation (see game_sounds/mod.rs's log_frontend_timing doc
// comment). useGameSoundEngine.ts calls this once per pipeline stage it
// observes for an actually-played sound, never per GSI tick.
#[tauri::command]
pub fn log_game_sound_timing(app: AppHandle, correlation_id: String, stage: String, elapsed_ms: u64) {
    game_sounds::log_frontend_timing(&app, &correlation_id, &stage, elapsed_ms);
}
