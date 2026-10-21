use tauri::{AppHandle,Manager,State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use crate::{backend,clips::{self,ClipsStatus},storage,obs,diagnostics::{self,DiagnosticsStatusSnapshot},hotkeys::{self,SkipHotkeyStatus},silero::{self,SileroStatus,SileroVoice},state::{AppState,StatusSnapshot,DEFAULT_WEB_ORIGIN}};
#[cfg(windows)]
static UPDATER_EXIT_IN_PROGRESS:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
#[cfg(windows)]
pub(crate) fn updater_exit_in_progress()->bool{UPDATER_EXIT_IN_PROGRESS.load(std::sync::atomic::Ordering::SeqCst)}

#[tauri::command]
pub fn get_status(state: State<AppState>) -> StatusSnapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn check_companion_update(window:tauri::WebviewWindow)->Result<Option<serde_json::Value>,String>{
    use tauri_plugin_updater::UpdaterExt;
    if window.label()!="main"{return Err("updater_window_denied".into());}
    let app=window.app_handle().clone();let exit_app=app.clone();
    let webview:&tauri::Webview=window.as_ref();
    let updater=webview.updater_builder().on_before_exit(move||{
        #[cfg(windows)]
        if companion_plugin_protocol::windows::current_host_generation().is_some(){
            let Some(audio)=exit_app.try_state::<std::sync::Arc<crate::core::plugin_audio::HostAudio>>()else{std::process::exit(1);};
            UPDATER_EXIT_IN_PROGRESS.store(true,std::sync::atomic::Ordering::SeqCst);
            let result=audio.retire_host_for_stock_updater(||{
                if let Some(manager)=exit_app.try_state::<crate::core::plugin_manager::PluginManager>(){manager.shutdown();}
                crate::silero::stop(&exit_app);crate::hotkeys::stop(&exit_app);crate::clips::stop(&exit_app);
                for window in exit_app.webview_windows().into_values(){window.destroy().map_err(|_|"updater_webview_stop_unproven".to_string())?;}
                Ok(())
            });
            if let Err(code)=result{crate::storage::append_rolling_log(&exit_app,&format!("Updater stopped before installer launch: {code}"));std::process::exit(1);}
        }
        // Same cleanup performed by UpdaterExt's default callback.
        exit_app.cleanup_before_exit();
    }).build().map_err(|_|"updater_configuration_unavailable")?;
    let Some(update)=updater.check().await.map_err(|e|e.to_string())?else{return Ok(None);};
    let date=update.date.and_then(|date|chrono::DateTime::<chrono::Utc>::from_timestamp(date.unix_timestamp(),date.nanosecond())).map(|date|date.to_rfc3339());
    let mut metadata=serde_json::json!({"currentVersion":update.current_version,"version":update.version,"body":update.body,"date":date,"rawJson":update.raw_json});
    metadata["rid"]=serde_json::json!(webview.resources_table().add(update));Ok(Some(metadata))
}

#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = storage::logs_root(&app);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_stream_settings(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(format!("{DEFAULT_WEB_ORIGIN}/stream"), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_steam_integration_status(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::get_steam_integration_status(&app).await
}

#[tauri::command]
pub async fn disconnect_steam(app: AppHandle) -> Result<(), String> {
    backend::disconnect_steam(&app).await
}

#[tauri::command]
pub async fn get_twitch_integration_status(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::get_twitch_integration_status(&app).await
}

#[tauri::command]
pub async fn get_donation_alerts_integration_status(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::get_donation_alerts_integration_status(&app).await
}

#[tauri::command]
pub async fn connect_twitch(app: AppHandle) -> Result<(), String> {
    let url = backend::connect_twitch(&app).await?;
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_twitch(app: AppHandle) -> Result<(), String> {
    backend::disconnect_twitch(&app).await
}

#[tauri::command]
pub async fn connect_donation_alerts(app: AppHandle) -> Result<(), String> {
    let url = backend::connect_donation_alerts(&app).await?;
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_donation_alerts(app: AppHandle) -> Result<(), String> {
    backend::disconnect_donation_alerts(&app).await
}

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
        inner.core.companion_token = Some(token);
        // WK-94 - a (re)saved token invalidates whatever backend_state the
        // previous token earned: clear the old error/failure streak and
        // "have we attempted yet" flag so the UI reads Waiting again
        // instead of carrying over a stale Unavailable/Recovering verdict.
        inner.core.backend_last_error = None;
        inner.core.backend_attempted = false;
        inner.core.backend_consecutive_failures = 0;
    }
    storage::append_rolling_log(&app, "Companion token saved locally.");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn get_account_status(app: AppHandle) -> backend::AccountStatus {
    backend::account_status(&app)
}

#[tauri::command]
pub async fn account_login(app: AppHandle, email: String, password: String) -> Result<backend::AccountStatus, String> {
    backend::login(&app, email, password).await
}

#[tauri::command]
pub async fn account_logout(app: AppHandle) -> Result<backend::AccountStatus, String> {
    backend::logout(&app).await
}

#[tauri::command]
pub async fn get_twitch_chat(app: AppHandle) -> Result<serde_json::Value, String> {
    backend::get_twitch_chat(&app).await
}

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

#[tauri::command]
pub fn get_skip_hotkey_status(app: AppHandle) -> SkipHotkeyStatus {
    hotkeys::status(&app)
}

#[tauri::command]
pub fn set_skip_hotkey(app: AppHandle, enabled: bool, shortcut: String) -> Result<SkipHotkeyStatus, String> {
    hotkeys::set_skip_hotkey(&app, enabled, shortcut)
}

// WK-178 - Twitch clip hotkey (see clips.rs). A press arrives through the
// global shortcut itself; the UI follows progress via "clips://state".
#[tauri::command]
pub fn get_clips_status(app: AppHandle) -> ClipsStatus {
    clips::status(&app)
}

#[tauri::command]
pub async fn get_clips_access(app: AppHandle) -> Result<serde_json::Value, String> {
    clips::access(&app).await
}

#[tauri::command]
pub fn set_clips_hotkey(app: AppHandle, enabled: bool, shortcut: String) -> Result<ClipsStatus, String> {
    clips::set_hotkey(&app, enabled, shortcut)
}

#[tauri::command]
pub fn set_clip_duration(app: AppHandle, duration_seconds: f64) -> Result<ClipsStatus, String> {
    clips::set_duration(&app, duration_seconds)
}

/// Same path as the hotkey; false when a clip is already being created.
#[tauri::command]
pub fn create_clip_now(app: AppHandle) -> bool {
    clips::trigger(&app)
}

#[tauri::command]
pub fn open_clip(app: AppHandle, id: String) -> Result<(), String> {
    let url = clips::clip_url(&app, &id)?;
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_clips_history(app: AppHandle) -> Result<ClipsStatus, String> {
    clips::clear_history(&app)
}

#[tauri::command]
pub fn diagnostics_export(app: AppHandle) -> Result<String, String> {
    let default_name = format!(
        "companion-diagnostics-{}.zip",
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
#[tauri::command]
pub async fn clear_log(app:AppHandle,state:State<'_,AppState>)->Result<StatusSnapshot,String>{storage::clear_logs(&app).map_err(|e|e.to_string())?;Ok(state.snapshot())}
#[tauri::command]
pub fn save_obs_config(app:AppHandle,state:State<AppState>,config:crate::core::obs_transport::ObsConfig)->Result<StatusSnapshot,String>{
 config.validate()?;{let mut inner=state.0.lock().map_err(|_|"obs_state_poisoned")?;let mut saved=inner.obs_config.clone();saved.enabled=config.enabled;saved.host=config.host;saved.port=config.port;if !config.password.is_empty(){saved.password=config.password;}saved.validate()?;storage::save_obs_config(&app,&saved).map_err(|_|"obs_configuration_write_failed")?;inner.obs_config=saved;inner.obs_connected=false;inner.obs_streaming=None;inner.obs_last_error=None;}
 Ok(state.snapshot())
}
#[tauri::command]
pub async fn test_obs_connection(app:AppHandle)->Result<Vec<String>,String>{
 let config=app.state::<AppState>().0.lock().map_err(|_|"obs_state_poisoned")?.obs_config.clone();let checking=config.clone();
 let result=tauri::async_runtime::spawn_blocking(move||obs::test_connection(&checking)).await.map_err(|_|"obs_check_failed")?;
 let state=app.state::<AppState>();let mut inner=state.0.lock().map_err(|_|"obs_state_poisoned")?;
 if inner.obs_config.host!=config.host||inner.obs_config.port!=config.port||inner.obs_config.password!=config.password{return Err("obs_configuration_changed".into());}inner.obs_connected=result.is_ok();inner.obs_last_error=result.as_ref().err().cloned();result
}
