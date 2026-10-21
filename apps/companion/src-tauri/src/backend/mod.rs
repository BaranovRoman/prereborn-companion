//! Account/Twitch and bounded signed-resource transport. No game background writers.
use std::time::{Duration,Instant};
use tauri::{AppHandle,Emitter,Manager,Runtime};
use crate::state::{AppState,DEFAULT_BACKEND_URL};
use crate::storage;
pub mod heartbeat;
const REQUEST_TIMEOUT:Duration=Duration::from_secs(5);
pub const MAX_RETRY_ATTEMPT:u32=5;
pub(crate) fn plugin_request(app:&AppHandle,resource:&companion_plugin_protocol::backend::Resource,request:&companion_plugin_protocol::backend::Request)->companion_plugin_protocol::backend::Response{
    let token={let state=app.state::<AppState>();let Ok(inner)=state.0.lock()else{return companion_plugin_protocol::backend::Response::failed(request,"account_state_unavailable");};inner.core.companion_token.clone()};
    let Some(token)=token else{return companion_plugin_protocol::backend::Response::failed(request,"account_not_connected");};
    let response=crate::core::backend_transport::request_plugin_resource(DEFAULT_BACKEND_URL,&token,resource,request);
    let signal=match response.status.and_then(|code|reqwest::StatusCode::from_u16(code).ok()){Some(status)=>classify_status(status),None=>ConnectivitySignal::Transient(response.error.clone().unwrap_or_else(||"backend_response_unavailable".into()))};
    record_connectivity(app,"plugin-resource",signal);response
}
/// Manual settings are pinned to the account observed at admission. A refresh
/// or login race is uncertain, never silently redirected to a different user.
pub(crate) fn plugin_request_pinned(app:&AppHandle,resource:&companion_plugin_protocol::backend::Resource,request:&companion_plugin_protocol::backend::Request,expected:&str)->companion_plugin_protocol::backend::Response{
 use companion_plugin_protocol::backend::Response;
 let same=||{let state=app.state::<AppState>();state.0.lock().is_ok_and(|s|s.companion_token.as_deref()==Some(expected))};
 if !same(){return Response::failed(request,"backend_account_changed");}
 let response=crate::core::backend_transport::request_plugin_resource(DEFAULT_BACKEND_URL,expected,resource,request);
 if !same(){return Response::failed(request,"backend_account_changed");}
 response
}
pub enum ConnectivitySignal {
    Success,
    Transient(String),
}

/// Any actual HTTP response - even a 4xx - proves the request reached the
/// backend and got answered, which is itself confirmation of connectivity;
/// only a 5xx (the server failing to handle it), 408, or 429 reads as the
/// backend itself struggling. This is what keeps an auth failure (401/403)
/// or a permanent rejection (422/400) from ever being misread as "backend
/// unavailable" - see the report's "backend connectivity vs auth failure
/// vs permanent rejection" split.
pub(crate) fn classify_status(status: reqwest::StatusCode) -> ConnectivitySignal {
    if status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        ConnectivitySignal::Transient(format!("HTTP {status}"))
    } else {
        ConnectivitySignal::Success
    }
}

/// Updates the shared connectivity counters (`backend_attempted`,
/// `backend_consecutive_failures`, `backend_last_error`) that
/// `AppState::snapshot` derives `backend_state` from, and logs ONLY the
/// meaningful transitions (first failure of a run, the run crossing into
/// `Unavailable`, and the recovery back to healthy) rather than every tick -
/// the previous gsi-state-only path used to log a line on every single
/// send, which at ~1 send/s during a live match could crowd real signal out
/// of the bounded rolling log (see the report's logging section).
// Generic over `R: Runtime` (same "no-op unless active" shape reasoning as
// local_runtime::handle_gsi, see its own doc comment) purely so the tests
// below can drive this with `tauri::test::mock_app()` end to end instead of
// only exercising `AppState::snapshot`'s threshold math in isolation - every
// real call site keeps compiling unchanged (`R = Wry` by inference).
pub(crate) fn record_connectivity<R: Runtime>(app: &AppHandle<R>, operation: &str, signal: ConnectivitySignal) {
    let state = app.state::<AppState>();
    let mut inner = state.0.lock().unwrap();
    inner.core.backend_attempted = true;
    match signal {
        ConnectivitySignal::Success => {
            let was_degraded = inner.core.backend_consecutive_failures > 0;
            let degraded_since = inner.core.backend_degraded_since.take();
            inner.core.backend_consecutive_failures = 0;
            inner.core.backend_last_error = None;
            drop(inner);
            if was_degraded {
                let degraded_secs = degraded_since.map(|since| since.elapsed().as_secs()).unwrap_or(0);
                storage::append_rolling_log(
                    app,
                    &format!("Backend: recovered ({operation}); was degraded for {degraded_secs}s"),
                );
            }
        }
        ConnectivitySignal::Transient(error) => {
            let first_failure_in_run = inner.core.backend_consecutive_failures == 0;
            if first_failure_in_run {
                inner.core.backend_degraded_since = Some(Instant::now());
            }
            inner.core.backend_consecutive_failures = inner.core.backend_consecutive_failures.saturating_add(1);
            let attempt = inner.core.backend_consecutive_failures;
            inner.core.backend_last_error = Some(error.clone());
            drop(inner);
            if first_failure_in_run {
                storage::append_rolling_log(app, &format!("Backend: degraded ({operation}) — {error}"));
            } else if attempt == MAX_RETRY_ATTEMPT {
                storage::append_rolling_log(
                    app,
                    &format!("Backend: unavailable ({operation}) after {attempt} consecutive failures — {error}"),
                );
            }
        }
    }
    let _ = app.emit("backend-status", app.state::<AppState>().snapshot());
}


pub fn init(app:AppHandle){
 {let state=app.state::<AppState>();let mut inner=state.0.lock().unwrap();inner.core.companion_token=storage::load_companion_token(&app);inner.obs_config=storage::load_obs_config(&app);}
 start_session_refresher(app.clone());
 heartbeat::start(app);
}
const SESSION_REFRESH_INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(serde::Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountMethod {
    /// No credential at all - the very first run, or after a full logout
    /// with no legacy token ever configured either.
    None,
    /// The new email/password session - the only method that carries an
    /// email to display and can be cleanly logged out of.
    Session,
    /// A pre-WK-122 install's opaque static token, generated once on the
    /// website and pasted in - kept working verbatim, never migrated
    /// automatically. No email is known for this method.
    LegacyToken,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub connected: bool,
    pub method: AccountMethod,
    pub email: Option<String>,
}

/// Read-only status for Settings/Diagnostics (see commands.rs) - never
/// exposes the token/refresh-token itself, only enough to render "Не
/// настроено" / "romaromych — Подключено" / a legacy-install's plain
/// "Подключено" per the task's explicit "не показывать secret" rule.
pub fn account_status(app: &AppHandle) -> AccountStatus {
    if let Some(session) = storage::load_session(app) {
        return AccountStatus { connected: true, method: AccountMethod::Session, email: Some(session.email) };
    }
    let has_legacy_token = app.state::<AppState>().0.lock().unwrap().core.companion_token.is_some();
    if has_legacy_token {
        AccountStatus { connected: true, method: AccountMethod::LegacyToken, email: None }
    } else {
        AccountStatus { connected: false, method: AccountMethod::None, email: None }
    }
}

#[derive(serde::Deserialize)]
struct LoginUser {
    email: String,
}

#[derive(serde::Deserialize)]
struct LoginResponse {
    user: LoginUser,
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
}

/// "Войти" in Settings → Аккаунт. `async` + `spawn_blocking` like every
/// other direct-user-action command in this file - a login click must never
/// freeze the window while the backend is being reached.
pub async fn login(app: &AppHandle, email: String, password: String) -> Result<AccountStatus, String> {
    let response = tauri::async_runtime::spawn_blocking(move || post_login(&email, &password))
        .await
        .map_err(|e| format!("Internal error: {e}"))??;

    storage::save_session(
        app,
        &storage::CompanionSession { email: response.user.email, refresh_token: response.refresh_token },
    )
    .map_err(|e| e.to_string())?;
    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.core.companion_token = Some(response.access_token);
        // WK-94 - same reasoning as save_companion_token: a fresh login
        // invalidates whatever backend_state a previous failed
        // token/session earned.
        inner.core.backend_last_error = None;
        inner.core.backend_attempted = false;
        inner.core.backend_consecutive_failures = 0;
    }
    storage::append_rolling_log(app, "Companion account: logged in.");
    // WK-122 - deliberately does NOT spawn a second refresher thread here:
    // `init` already started one persistent loop for the app's whole
    // lifetime (see `start_session_refresher`'s doc comment) that will pick
    // this session up on its own next tick, well within the access token's
    // 1h TTL. Two independent refresher loops would race the refresh
    // token's rotation - the second one to run in a given window would see
    // the first's already-rotated value as `Revoked` and wrongly clear a
    // perfectly good session.
    Ok(account_status(app))
}

fn post_login(email: &str, password: &str) -> Result<LoginResponse, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .post(format!("{DEFAULT_BACKEND_URL}/stream/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .map_err(|error| format!("Не удалось связаться с PreReborn: {error}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Неверный email или пароль.".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response.json().map_err(|error| format!("Неверный ответ входа: {error}"))
}

/// "Выйти" in Settings → Аккаунт. WK-125 fix: this single button covers both
/// connection methods (email/password session AND a legacy pasted-in
/// companion token, see `AccountMethod`), so it must clear whichever secret
/// is actually in play - previously it only ever cleared the session,
/// silently leaving a legacy token to be reloaded on the next launch (see
/// docs/security/desktop-secret-storage-audit.md).
pub async fn logout(app: &AppHandle) -> Result<AccountStatus, String> {
    if let Some(session) = storage::load_session(app) {
        // Best-effort revoke - a failed/offline logout must never trap the
        // user in a "connected" state locally; the refresh token simply
        // expires server-side on its own 30-day TTL if this never reaches it.
        let _ = tauri::async_runtime::spawn_blocking(move || post_logout(&session.refresh_token)).await;
    }
    storage::clear_session(app).map_err(|e| e.to_string())?;
    storage::clear_companion_token(app).map_err(|e| e.to_string())?;
    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.core.companion_token = None;
    }
    storage::append_rolling_log(app, "Companion account: logged out.");
    Ok(account_status(app))
}

fn post_logout(refresh_token: &str) -> Result<(), String> {
    reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .post(format!("{DEFAULT_BACKEND_URL}/stream/auth/logout"))
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .map_err(|error| format!("Не удалось разорвать сессию на сервере: {error}"))?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct RefreshResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
}

enum RefreshError {
    /// The refresh token itself is gone/expired/already rotated elsewhere -
    /// retrying with the same value can only ever fail the same way, so the
    /// session must be cleared rather than kept around as false "connected"
    /// state.
    Revoked,
    /// Anything else (network blip, backend down) - the stored session
    /// stays as-is, the next periodic tick tries again.
    Transient(String),
}

fn post_refresh(refresh_token: &str) -> Result<RefreshResponse, RefreshError> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| RefreshError::Transient(format!("HTTP client error: {error}")))?
        .post(format!("{DEFAULT_BACKEND_URL}/stream/auth/refresh"))
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .map_err(|error| RefreshError::Transient(format!("Не удалось обновить сессию: {error}")))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(RefreshError::Revoked);
    }
    if !response.status().is_success() {
        return Err(RefreshError::Transient(format!("Backend ответил {}", response.status())));
    }
    response
        .json()
        .map_err(|error| RefreshError::Transient(format!("Неверный ответ обновления сессии: {error}")))
}

/// Refreshes the in-memory access token (`AppState.companion_token`) from
/// the stored refresh token, rotating and persisting the new refresh token
/// on success (the server deletes the old one on rotation - reusing it
/// again would itself count as `Revoked`, so the freshly-rotated value must
/// be the one saved). Called once immediately by `start_session_refresher`
/// and every `SESSION_REFRESH_INTERVAL` thereafter - comfortably inside the
/// backend's 1h access-token TTL, so `companion_token` should never actually
/// be observed expired by any of this file's other callers.
fn refresh_session_access_token(app: &AppHandle) -> Result<(), String> {
    let Some(session) = storage::load_session(app) else { return Ok(()) };
    match post_refresh(&session.refresh_token) {
        Ok(refreshed) => {
            storage::save_session(
                app,
                &storage::CompanionSession { email: session.email, refresh_token: refreshed.refresh_token },
            )
            .map_err(|e| e.to_string())?;
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.core.companion_token = Some(refreshed.access_token);
            drop(inner);
            record_connectivity(app, "session-refresh", ConnectivitySignal::Success);
            Ok(())
        }
        // Deliberately NOT fed into `record_connectivity` - an expired/
        // rotated refresh token is a credential problem, not evidence the
        // backend is unreachable (see the report's "auth failure vs backend
        // connectivity" split). The backend clearly responded (with a 401),
        // which if anything confirms connectivity.
        Err(RefreshError::Revoked) => {
            let _ = storage::clear_session(app);
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.core.companion_token = None;
            Err("Сессия недействительна — нужно войти заново.".to_string())
        }
        Err(RefreshError::Transient(message)) => {
            record_connectivity(app, "session-refresh", ConnectivitySignal::Transient(message.clone()));
            Err(message)
        }
    }
}

/// Started exactly once, from `init`, for the app's entire lifetime -
/// always runs (a cheap no-op tick whenever no session is stored, same
/// "always run" shape as `obs::start_stream_state_watcher`), immediately
/// refreshing on the very first tick and every `SESSION_REFRESH_INTERVAL`
/// after. `login` deliberately does NOT start a second one of these - see
/// its own comment for why that would race the refresh token's rotation.
fn start_session_refresher(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Err(error) = refresh_session_access_token(&app) {
            storage::append_rolling_log(&app, &format!("Companion account: session refresh failed ({error})"));
        }
        std::thread::sleep(SESSION_REFRESH_INTERVAL);
    });
}
pub async fn get_twitch_chat(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .core.companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    let account=token.clone();
    let fetch_app=app.clone();
    let response = tauri::async_runtime::spawn_blocking(move || fetch_twitch_chat(&fetch_app,&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))??;
    let (merged, previous_count, current_count) = cache_twitch_chat_response(app, response, &account)?;
    if current_count != previous_count {
        storage::append_rolling_log(
            app,
            &format!(
                "Local overlay chat cache: messages={current_count} new_messages={}",
                current_count.saturating_sub(previous_count)
            ),
        );
    }
    Ok(merged)
}

// WK-133 - Settings → Интеграции (Steam/Twitch status + Steam unlink) and
// Hero Detail's OpenDota panel. Same shape as `get_twitch_chat`/
// `fetch_twitch_chat` above: a private blocking fn (bearer_auth'd reqwest
// call against the same `/stream/integrations/*` REST contract apps/web
// already uses) wrapped by a public `async` + `spawn_blocking` fn so a click
// never freezes the window. Deliberately does NOT call `record_connectivity`
// - these are on-demand, secondary calls a streamer triggers from Settings/
// Hero Detail, not part of the core GSI-state heartbeat `AppState.backend_state`
// represents; an OpenDota/Steam hiccup must never flip Companion's main
// "PreReborn недоступен" banner (see this task's failure-isolation
// requirement). Responses are passed through as `serde_json::Value` - same
// convention `get_stream_session`/`get_account_overlay_data` already use -
// the frontend types/parses the discriminated `status` contract itself.

// Generic over `Runtime` (not just the concrete Wry handle every other
// function in this file uses) so the WK-133 unit tests below can exercise it
// against `tauri::test::MockRuntime` - same pattern local_runtime::handle_gsi
// already established for this exact need (see commands.rs's WK-127 doc
// comment on why command fns themselves can't do this).
fn require_companion_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    app.state::<AppState>()
        .0
        .lock()
        .unwrap()
        .core.companion_token
        .clone()
        .ok_or_else(|| "Companion не подключён к аккаунту.".to_string())
}

fn fetch_steam_integration_status(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/integrations/steam"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Steam-статус недоступен: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ Steam-статуса: {error}"))
}

pub async fn get_steam_integration_status(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || fetch_steam_integration_status(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

fn perform_disconnect_steam(token: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .delete(format!("{DEFAULT_BACKEND_URL}/stream/integrations/steam"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось отвязать Steam: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    Ok(())
}

pub async fn disconnect_steam(app: &AppHandle) -> Result<(), String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || perform_disconnect_steam(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

fn fetch_twitch_integration_status(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/integrations/twitch"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Twitch-статус недоступен: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ Twitch-статуса: {error}"))
}

pub async fn get_twitch_integration_status(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || fetch_twitch_integration_status(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

// WK-133 follow-up (visual review) - DonationAlerts was missed by the
// original Settings → Интеграции audit: it's an existing OAuth account
// integration (see apps/api's donation-alerts-integration-service.ts),
// already consumed by Companion's own overlay renderer (topDonors feed the
// Between Matches "Donaters" panel, see overlay-renderer/types.ts and
// DesignPage.tsx's hint text). Same shape as get_twitch_integration_status -
// status only, no new OAuth, existing `/stream/integrations/donation-alerts`
// endpoint.
fn fetch_donation_alerts_integration_status(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/integrations/donation-alerts"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("DonationAlerts-статус недоступен: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ DonationAlerts-статуса: {error}"))
}

pub async fn get_donation_alerts_integration_status(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || fetch_donation_alerts_integration_status(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

// WK-149 - Twitch/DonationAlerts connect+disconnect from Companion itself,
// mirroring Steam's existing get/disconnect pair above exactly (same
// Bearer-token/reqwest::blocking shape). `/connect` returns
// `{redirectUrl}` (JSON, not a server redirect - see
// apps/api/src/controllers/stream/twitch.ts:38) precisely so any client that
// holds a companion token can open it itself; Companion does that via
// `commands::connect_twitch`'s `app.opener().open_url(...)`, the same call
// `open_stream_settings` already uses. Completion is picked up by
// IntegrationsPanel's existing window-focus refetch - no deep-link/callback
// handling needed here.
fn fetch_twitch_connect_url(token: &str) -> Result<String, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/integrations/twitch/connect"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось получить ссылку для подключения Twitch: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|error| format!("Неверный ответ Twitch connect: {error}"))?;
    body.get("redirectUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Backend не вернул redirectUrl".to_string())
}

pub async fn connect_twitch(app: &AppHandle) -> Result<String, String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || fetch_twitch_connect_url(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

fn perform_disconnect_twitch(token: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .delete(format!("{DEFAULT_BACKEND_URL}/stream/integrations/twitch"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось отвязать Twitch: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    Ok(())
}

pub async fn disconnect_twitch(app: &AppHandle) -> Result<(), String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || perform_disconnect_twitch(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

fn fetch_donation_alerts_connect_url(token: &str) -> Result<String, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/integrations/donation-alerts/connect"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось получить ссылку для подключения DonationAlerts: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|error| format!("Неверный ответ DonationAlerts connect: {error}"))?;
    body.get("redirectUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Backend не вернул redirectUrl".to_string())
}

pub async fn connect_donation_alerts(app: &AppHandle) -> Result<String, String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || fetch_donation_alerts_connect_url(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}

fn perform_disconnect_donation_alerts(token: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .delete(format!("{DEFAULT_BACKEND_URL}/stream/integrations/donation-alerts"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось отвязать DonationAlerts: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    Ok(())
}

pub async fn disconnect_donation_alerts(app: &AppHandle) -> Result<(), String> {
    let token = require_companion_token(app)?;
    tauri::async_runtime::spawn_blocking(move || perform_disconnect_donation_alerts(&token))
        .await
        .map_err(|error| format!("Internal error: {error}"))?
}
const LOCAL_CHAT_HISTORY_LIMIT: usize = 50;

fn merge_twitch_chat_status(
    cached: Option<&serde_json::Value>,
    mut incoming: serde_json::Value,
) -> serde_json::Value {
    let mut by_id = std::collections::BTreeMap::<String, serde_json::Value>::new();
    for source in [cached, Some(&incoming)].into_iter().flatten() {
        if let Some(messages) = source.get("messages").and_then(serde_json::Value::as_array) {
            for message in messages {
                if let Some(id) = message.get("id").and_then(serde_json::Value::as_str) {
                    by_id.insert(id.to_string(), message.clone());
                }
            }
        }
    }
    let mut messages: Vec<_> = by_id.into_values().collect();
    messages.sort_by(|left, right| {
        let left_key = left.get("receivedAt").and_then(serde_json::Value::as_str).unwrap_or("");
        let right_key = right.get("receivedAt").and_then(serde_json::Value::as_str).unwrap_or("");
        left_key.cmp(right_key).then_with(|| {
            left.get("id").and_then(serde_json::Value::as_str).unwrap_or("")
                .cmp(right.get("id").and_then(serde_json::Value::as_str).unwrap_or(""))
        })
    });
    if messages.len() > LOCAL_CHAT_HISTORY_LIMIT {
        messages.drain(..messages.len() - LOCAL_CHAT_HISTORY_LIMIT);
    }
    incoming["messages"] = serde_json::Value::Array(messages);
    incoming
}

fn cache_twitch_chat_response(app: &AppHandle, incoming: serde_json::Value, account:&str) -> Result<(serde_json::Value, usize, usize),String> {
    let state = app.state::<AppState>();
    let mut inner = state.0.lock().unwrap();
    if inner.core.companion_token.as_deref()!=Some(account){return Err("chat_account_changed".into());}
    use sha2::{Digest,Sha256};
    let authority=format!("{:x}",Sha256::digest(account.as_bytes()));
    if inner.core.twitch_chat_authority.as_ref()!=Some(&authority){inner.core.twitch_chat=None;}
    let previous_count = inner.core.twitch_chat.as_ref()
        .and_then(|value| value.get("messages"))
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let merged = merge_twitch_chat_status(inner.core.twitch_chat.as_ref(), incoming);
    let current_count = merged.get("messages").and_then(serde_json::Value::as_array).map_or(0, Vec::len);
    inner.core.twitch_chat = Some(merged.clone());
    inner.core.twitch_chat_observed_at_ms=u64::try_from(chrono::Utc::now().timestamp_millis()).ok();
    inner.core.twitch_chat_authority=Some(authority);
    Ok((merged, previous_count, current_count))
}

fn fetch_twitch_chat(app:&AppHandle,token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/twitch-chat"))
        .bearer_auth(token)
        .send()
        .map_err(|error| {let message=format!("Twitch-чат недоступен: {error}");record_connectivity(app,"twitch-chat",ConnectivitySignal::Transient(message.clone()));message})?;
    record_connectivity(app,"twitch-chat",classify_status(response.status()));
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ Twitch-чата: {error}"))
}
#[cfg(test)]
mod connectivity_tests {
    use super::*;
    use crate::state::ConnectionState;

    fn mock_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        app.handle().clone()
    }

    #[test]
    fn classify_status_treats_5xx_408_429_as_transient() {
        for status in [
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::BAD_GATEWAY,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            reqwest::StatusCode::GATEWAY_TIMEOUT,
            reqwest::StatusCode::REQUEST_TIMEOUT,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert!(
                matches!(classify_status(status), ConnectivitySignal::Transient(_)),
                "{status} must read as a connectivity problem"
            );
        }
    }

    // WK reliability pass - item 3/5 of the connectivity audit: auth
    // failure and permanent (validation) rejection must never read as
    // "backend unavailable". Any actual HTTP response, even an error one,
    // proves the request reached the backend and got answered.
    #[test]
    fn classify_status_treats_auth_and_validation_4xx_as_connectivity_success() {
        for status in [
            reqwest::StatusCode::OK,
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::BAD_REQUEST,
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
        ] {
            assert!(
                matches!(classify_status(status), ConnectivitySignal::Success),
                "{status} must never be misread as a backend outage"
            );
        }
    }

    #[test]
    fn a_single_transient_failure_reads_as_recovering_not_a_persistent_outage() {
        let handle = mock_handle();
        record_connectivity(&handle, "test-op", ConnectivitySignal::Transient("blip".into()));
        let snapshot = handle.state::<AppState>().snapshot();
        assert_eq!(snapshot.backend_state, ConnectionState::Recovering);
        assert_eq!(snapshot.backend_last_error.as_deref(), Some("blip"));
    }

    #[test]
    fn reaching_max_retry_attempt_marks_the_backend_unavailable() {
        let handle = mock_handle();
        for _ in 0..MAX_RETRY_ATTEMPT {
            record_connectivity(&handle, "test-op", ConnectivitySignal::Transient("down".into()));
        }
        assert_eq!(handle.state::<AppState>().snapshot().backend_state, ConnectionState::Unavailable);
    }

    #[test]
    fn a_success_after_a_run_of_failures_recovers_to_connected_and_clears_the_error() {
        let handle = mock_handle();
        for _ in 0..MAX_RETRY_ATTEMPT {
            record_connectivity(&handle, "test-op", ConnectivitySignal::Transient("down".into()));
        }
        assert_eq!(handle.state::<AppState>().snapshot().backend_state, ConnectionState::Unavailable);
        record_connectivity(&handle, "test-op", ConnectivitySignal::Success);
        let snapshot = handle.state::<AppState>().snapshot();
        assert_eq!(snapshot.backend_state, ConnectionState::Connected);
        assert_eq!(snapshot.backend_last_error, None);
    }

    // Regression guard for the actual reported bug: before this reliability
    // pass, ONLY the gsi-state heartbeat (try_send_pending, gated on a fresh
    // GSI packet) ever called into this state, so a run of failures right as
    // a match ended left `backend_state` stuck on Unavailable for the rest
    // of the stream - nothing else ever attempted a new send to recover it.
    // A success from any OTHER instrumented background path (the command
    // poll, the overlay/queue/account polls, the sync-outbox drain - see
    // their call sites in this file and in local_runtime::sync) must be
    // able to recover it just as well.
    #[test]
    fn a_success_from_a_different_operation_than_the_one_that_failed_still_recovers_backend_state() {
        let handle = mock_handle();
        for _ in 0..MAX_RETRY_ATTEMPT {
            record_connectivity(&handle, "gsi-state", ConnectivitySignal::Transient("match ended mid-blip".into()));
        }
        assert_eq!(handle.state::<AppState>().snapshot().backend_state, ConnectionState::Unavailable);
        record_connectivity(&handle, "commands-poll", ConnectivitySignal::Success);
        assert_eq!(handle.state::<AppState>().snapshot().backend_state, ConnectionState::Connected);
    }
}
