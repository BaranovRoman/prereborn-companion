use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, COMPANION_VERSION, DEFAULT_BACKEND_URL};
use crate::storage;
use crate::obs::{self, BroadcastScene};

const SEND_LOOP_INTERVAL: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(serde::Deserialize)]
struct ObsCommand {
    scene: BroadcastScene,
}

/// Loads a persisted companion token (if any) and starts the ~1/s background
/// sender loop. Called once from `lib.rs::run().setup()`.
pub fn init(app: AppHandle) {
    if let Some(token) = storage::load_companion_token(&app) {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.companion_token = Some(token);
    }
    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.obs_config = storage::load_obs_config(&app);
    }

    let app_for_loop = app.clone();
    std::thread::spawn(move || {
        let mut last_command_poll = Instant::now() - COMMAND_POLL_INTERVAL;
        loop {
        std::thread::sleep(SEND_LOOP_INTERVAL);
        try_send_pending(&app_for_loop);
            if last_command_poll.elapsed() >= COMMAND_POLL_INTERVAL {
                poll_obs_command(&app_for_loop);
                last_command_poll = Instant::now();
            }
        }
    });
}

fn poll_obs_command(app: &AppHandle) {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone();
    let Some(token) = token else { return };
    let client = match reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let response = match client
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/commands"))
        .bearer_auth(token)
        .send()
    {
        Ok(response) => response,
        Err(_) => return,
    };
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return;
    }
    if let Ok(command) = response.json::<ObsCommand>() {
        obs::handle_remote_command(app, command.scene);
    }
}

/// The throttled path: only fires when a new GSI payload arrived since the
/// last send (`dirty`), and never more than once per loop tick (~1s) - this
/// is what keeps Dota's multiple-updates-per-second GSI stream from turning
/// into a flood of outbound requests.
fn try_send_pending(app: &AppHandle) {
    let (should_send, payload, token, payload_version) = {
        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        if !inner.dirty || inner.companion_token.is_none() {
            (false, None, None, 0)
        } else {
            (
                true,
                inner.last_gsi_payload.clone(),
                inner.companion_token.clone(),
                inner.payload_version,
            )
        }
    };

    if !should_send {
        return;
    }

    if let (Some(payload), Some(token)) = (payload, token) {
        let result = send_state(&token, &payload);
        apply_result(app, &result);
        if result.is_ok() {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            if inner.payload_version == payload_version {
                inner.dirty = false;
            }
        }
    }
}

/// Manual "resend current state" - ignores `dirty`, sends whatever the last
/// known GSI payload was (even if it was already sent successfully before).

pub fn get_twitch_chat(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/twitch-chat"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Twitch-чат недоступен: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ Twitch-чата: {error}"))
}
pub fn resend_now(app: &AppHandle) -> Result<(), String> {
    let (payload, token) = {
        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        (inner.last_gsi_payload.clone(), inner.companion_token.clone())
    };

    let Some(token) = token else {
        return Err("Сначала вставьте companion token.".to_string());
    };
    let Some(payload) = payload else {
        return Err("Пока нет ни одного GSI-события для отправки.".to_string());
    };

    let result = send_state(&token, &payload);
    apply_result(app, &result);
    result
}

fn send_state(token: &str, payload: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::json!({
        "payload": payload,
        "timestamp": chrono::Local::now().to_rfc3339(),
        "companionVersion": COMPANION_VERSION,
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let response = client
        .put(format!("{DEFAULT_BACKEND_URL}/stream/companion/gsi-state"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|e| format!("Сеть недоступна: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }

    Ok(())
}

fn apply_result(app: &AppHandle, result: &Result<(), String>) {
    let state = app.state::<AppState>();
    let mut inner = state.0.lock().unwrap();
    match result {
        Ok(()) => {
            inner.backend_connected = true;
            inner.backend_last_sent_at = Some(chrono::Local::now().to_rfc3339());
            inner.backend_last_error = None;
        }
        Err(e) => {
            inner.backend_connected = false;
            inner.backend_last_error = Some(e.clone());
        }
    }
    drop(inner);

    storage::append_rolling_log(
        app,
        &match result {
            Ok(()) => "Backend: состояние отправлено".to_string(),
            Err(e) => format!("Backend: ошибка отправки — {e}"),
        },
    );
    let _ = app.emit("backend-status", app.state::<AppState>().snapshot());
}
