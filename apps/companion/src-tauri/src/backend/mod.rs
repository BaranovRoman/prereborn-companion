use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, COMPANION_VERSION, DEFAULT_BACKEND_URL};
use crate::storage;
use crate::obs::{self, BroadcastScene};

const SEND_LOOP_INTERVAL: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_secs(1);
// WK-99 - Post Stream's trigger is session lifecycle, not GSI, so it needs
// its own poll of the endpoint WK-83's "continue previous stream?" prompt
// already uses (fetch_stream_session below) - a few seconds of latency to
// notice `ended` is fine for a calm final scene, so this stays deliberately
// slower than COMMAND_POLL_INTERVAL rather than adding load on every tick.
const SESSION_POLL_INTERVAL: Duration = Duration::from_secs(3);

// WK-94 - same cap `retry_delay` uses for its backoff shape, reused as the
// single source of truth for when `state::AppState::snapshot()` should stop
// calling a run of failures "Recovering" and call it "Unavailable" instead.
// Keeps the UI's read of an outage tied to the same backoff window the send
// loop is already retrying within, instead of a second, independent notion
// of "how long is too long".
pub const MAX_RETRY_ATTEMPT: u32 = 5;

/// Capped exponential backoff (same `2^attempt` / 30s cap shape as
/// `obs::retry_delay`) plus a little jitter so a hard-down backend can't
/// turn a fast-failing error (e.g. connection refused, which returns in
/// milliseconds rather than waiting out REQUEST_TIMEOUT) into a tight
/// retry-storm loop against `/gsi-state` (WK-78). No `rand` dependency -
/// system-clock sub-second jitter is precise enough for spreading retries.
fn retry_delay(attempt: u32) -> Duration {
    let base = Duration::from_secs(2_u64.saturating_pow(attempt.min(MAX_RETRY_ATTEMPT)).min(30));
    let jitter_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_nanos()) % 500)
        .unwrap_or(0);
    base + Duration::from_millis(jitter_ms)
}

enum SendOutcome {
    Sent,
    Skipped,
    Failed,
}

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
        let mut last_session_poll = Instant::now() - SESSION_POLL_INTERVAL;
        let mut send_failures: u32 = 0;
        let mut next_send_attempt_at = Instant::now();
        loop {
            std::thread::sleep(SEND_LOOP_INTERVAL);
            if Instant::now() >= next_send_attempt_at {
                match try_send_pending(&app_for_loop) {
                    SendOutcome::Sent | SendOutcome::Skipped => {
                        send_failures = 0;
                        next_send_attempt_at = Instant::now();
                    }
                    SendOutcome::Failed => {
                        send_failures = send_failures.saturating_add(1);
                        next_send_attempt_at = Instant::now() + retry_delay(send_failures);
                    }
                }
            }
            if last_command_poll.elapsed() >= COMMAND_POLL_INTERVAL {
                poll_obs_command(&app_for_loop);
                last_command_poll = Instant::now();
            }
            if last_session_poll.elapsed() >= SESSION_POLL_INTERVAL {
                poll_session_state(&app_for_loop);
                last_session_poll = Instant::now();
            }
        }
    });
}

/// WK-99 - Post Stream's trigger. Deliberately best-effort and silent on
/// any failure (no companion token yet, backend unreachable, malformed
/// response) - same fail-quiet-and-retry-next-tick shape as
/// `poll_obs_command` right below. This must never be able to block or
/// affect the web `ended` transition itself: that's a plain backend DB
/// write the web cabinet makes directly, with no dependency on Companion
/// being online, connected, or even running at all - this poll only ever
/// *reads* that state, and only to drive OBS automation.
fn poll_session_state(app: &AppHandle) {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone();
    let Some(token) = token else { return };
    let Ok(session) = fetch_stream_session(&token) else {
        return;
    };
    let ended = session.get("state").and_then(serde_json::Value::as_str) == Some("ended");
    obs::handle_session_state(app, ended);
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
fn try_send_pending(app: &AppHandle) -> SendOutcome {
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
        return SendOutcome::Skipped;
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
            SendOutcome::Sent
        } else {
            SendOutcome::Failed
        }
    } else {
        SendOutcome::Skipped
    }
}

/// WK-83 - "continue previous stream?" startup prompt. `async` +
/// `spawn_blocking` for the same reason as `get_twitch_chat` above - called
/// once at Companion startup, must never block the IPC/UI thread.
pub async fn get_stream_session(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || fetch_stream_session(&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

fn fetch_stream_session(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/session"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Стрим-сессия недоступна: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ сессии: {error}"))
}

/// WK-83 - "Начать новый стрим" button in `SessionPromptBanner`. Reuses the
/// exact same backend `resetActiveSession` service function the web
/// cabinet's own reset button calls (via the companion-token-authenticated
/// `/stream/companion/session/reset` route) - not a parallel reset
/// implementation. `async` + `spawn_blocking` because this is a direct user
/// click that must not freeze the window.
pub async fn reset_stream_session(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || post_reset_stream_session(&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

fn post_reset_stream_session(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .post(format!("{DEFAULT_BACKEND_URL}/stream/companion/session/reset"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось сбросить сессию: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ сброса сессии: {error}"))
}

/// Manual "resend current state" - ignores `dirty`, sends whatever the last
/// known GSI payload was (even if it was already sent successfully before).

/// `async` + `spawn_blocking` so this (invoked every 1.5s by the Chat page
/// poll - see `TwitchChatPage.tsx`) can never block the main IPC/UI thread,
/// even for its full REQUEST_TIMEOUT (WK-78). A plain `fn` command here
/// would run inline on the thread that dispatches WebView IPC messages.
pub async fn get_twitch_chat(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || fetch_twitch_chat(&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

fn fetch_twitch_chat(token: &str) -> Result<serde_json::Value, String> {
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

/// `async` + `spawn_blocking` for the same reason as `get_twitch_chat`
/// above - this is invoked directly from a user click ("Отправить снова"),
/// but a plain `fn` command would still freeze the whole window for up to
/// REQUEST_TIMEOUT while the backend is unreachable (WK-78).
pub async fn resend_now(app: &AppHandle) -> Result<(), String> {
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

    let result = tauri::async_runtime::spawn_blocking(move || send_state(&token, &payload))
        .await
        .map_err(|e| format!("Internal error: {e}"))?;
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

    if response.status() == reqwest::StatusCode::UPGRADE_REQUIRED {
        return Err(format!(
            "Companion устарел ({COMPANION_VERSION}) — скачайте новую версию с сайта."
        ));
    }

    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }

    Ok(())
}

fn apply_result(app: &AppHandle, result: &Result<(), String>) {
    let state = app.state::<AppState>();
    let mut inner = state.0.lock().unwrap();
    inner.backend_attempted = true;
    match result {
        Ok(()) => {
            inner.backend_consecutive_failures = 0;
            inner.backend_last_sent_at = Some(chrono::Local::now().to_rfc3339());
            inner.backend_last_error = None;
        }
        Err(e) => {
            // A single failure (and a run of them under MAX_RETRY_ATTEMPT)
            // is surfaced by `snapshot()` as Recovering, not Unavailable -
            // WK-78's backoff is already retrying, so this isn't a final
            // "disconnected" state yet (see state.rs::AppState::snapshot).
            inner.backend_consecutive_failures = inner.backend_consecutive_failures.saturating_add(1);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gsi_send_backoff_is_bounded_and_capped_at_30s() {
        assert!(retry_delay(0) >= Duration::from_secs(1) && retry_delay(0) < Duration::from_secs(2));
        assert!(retry_delay(1) >= Duration::from_secs(2) && retry_delay(1) < Duration::from_secs(3));
        assert!(retry_delay(4) >= Duration::from_secs(16) && retry_delay(4) < Duration::from_secs(17));
        // attempt is clamped to 5 internally, so 5 and 20 must land in the same capped bucket.
        assert!(retry_delay(5) >= Duration::from_secs(30) && retry_delay(5) < Duration::from_secs(31));
        assert!(retry_delay(20) >= Duration::from_secs(30) && retry_delay(20) < Duration::from_secs(31));
    }
}
