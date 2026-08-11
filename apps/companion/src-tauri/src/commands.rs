use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::backend;
use crate::diagnostics::{self, DiagnosticsStatusSnapshot};
use crate::gsi::{config, finder};
use crate::obs::{self, BroadcastScene, ObsConfig};
use crate::state::{AppState, StatusSnapshot};
use crate::storage;

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
pub fn clear_log(app: AppHandle, state: State<AppState>) -> Result<StatusSnapshot, String> {
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

#[tauri::command]
pub fn resend_current_state(
    app: AppHandle,
    state: State<AppState>,
) -> Result<StatusSnapshot, String> {
    backend::resend_now(&app)?;
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
    {
        let inner = state.0.lock().unwrap();
        if config.password.is_empty() {
            config.password = inner.obs_config.password.clone();
        }
    }
    storage::save_obs_config(&app, &config).map_err(|e| e.to_string())?;
    {
        let mut inner = state.0.lock().unwrap();
        inner.obs_config = config;
        inner.obs_connected = false;
        inner.obs_active_scene = None;
        inner.obs_switch_pending = None;
        inner.obs_last_error = None;
    }
    storage::append_rolling_log(&app, "OBS scene switching settings saved locally.");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn test_obs_connection(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let config = state.0.lock().unwrap().obs_config.clone();
    match obs::test_connection(&config) {
        Ok(scenes) => {
            let expected = [
                &config.between_matches_scene,
                &config.draft_scene,
                &config.gameplay_scene,
            ];
            let missing: Vec<&str> = expected
                .into_iter()
                .filter(|name| !scenes.contains(*name))
                .map(String::as_str)
                .collect();
            if !missing.is_empty() {
                let error = format!(
                    "OBS подключён, но не найдены сцены: {}",
                    missing.join(", ")
                );
                let mut inner = state.0.lock().unwrap();
                inner.obs_connected = false;
                inner.obs_last_error = Some(error.clone());
                return Err(error);
            }
            let active_scene = obs::current_scene(&config).unwrap_or(None);
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = true;
            inner.obs_active_scene = active_scene;
            inner.obs_last_error = None;
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
pub fn set_obs_automation(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<StatusSnapshot, String> {
    let mut config = state.0.lock().unwrap().obs_config.clone();
    config.enabled = enabled;
    storage::save_obs_config(&app, &config).map_err(|e| e.to_string())?;
    state.0.lock().unwrap().obs_config = config;
    storage::append_rolling_log(
        &app,
        if enabled {
            "OBS automation enabled."
        } else {
            "OBS automation disabled; manual mode active."
        },
    );
    Ok(state.snapshot())
}

#[tauri::command]
pub fn switch_obs_scene(
    app: AppHandle,
    state: State<AppState>,
    scene: BroadcastScene,
) -> Result<StatusSnapshot, String> {
    let config = {
        let mut inner = state.0.lock().unwrap();
        // A manual scene choice is a durable override until automation is
        // explicitly enabled again.
        inner.obs_config.enabled = false;
        inner.obs_switch_pending = None;
        inner.obs_config.clone()
    };
    storage::save_obs_config(&app, &config).map_err(|e| e.to_string())?;
    match obs::switch_scene(&config, scene) {
        Ok(()) => {
            let mut inner = state.0.lock().unwrap();
            inner.obs_connected = true;
            inner.obs_active_scene = Some(scene);
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

#[tauri::command]
pub fn diagnostics_export(app: AppHandle) -> Result<String, String> {
    let default_name = format!("gsi-diagnostics-{}.zip", chrono::Local::now().format("%Y-%m-%dT%H-%M-%S"));
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
