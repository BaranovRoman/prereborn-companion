use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, COMPANION_VERSION, DEFAULT_BACKEND_URL};
use crate::storage;
use crate::obs::{self, BroadcastScene};

const SEND_LOOP_INTERVAL: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
// WK-113 - this remote "test scene" command (web dashboard -> Companion) is
// a rare debug/QA convenience, not part of the local-first hot path (see
// docs/research/wk-110-local-first-audit.md §3, class A: "cadence itself
// should not remain a permanent 1s poll"). Widened from 1s to 15s rather
// than building a push-based replacement (out of scope here, and explicitly
// deferrable per the WK-113 ticket) - still responsive enough for a human
// clicking a button and waiting a few seconds, at a fraction of the
// previous request volume.
const COMMAND_POLL_INTERVAL: Duration = Duration::from_secs(15);
// WK-122 §19 - see the field doc on InnerState.overlay_layout. A once-a-
// minute GET is cheap and catches a web-editor change reasonably fast
// without polling aggressively for something that changes rarely.
const OVERLAY_LAYOUT_POLL_INTERVAL: Duration = Duration::from_secs(60);

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
        inner.overlay_layout = storage::load_overlay_layout(&app);
        if inner.overlay_layout.is_some() {
            inner.overlay_layout_version = 1;
        }
    }
    // WK-122 §7 - if a session (email/password login) was ever established,
    // this immediately refreshes it into a fresh `companion_token`,
    // overriding the legacy token loaded just above for accounts that have
    // migrated to the new flow - see `account_status`'s "session wins" order.
    start_session_refresher(app.clone());

    let app_for_loop = app.clone();
    std::thread::spawn(move || {
        let mut last_command_poll = Instant::now() - COMMAND_POLL_INTERVAL;
        // WK-122 §19 - fires on the very first tick (same "already elapsed"
        // trick as last_command_poll), then every OVERLAY_LAYOUT_POLL_INTERVAL
        // - catches a layout change made via the web editor while Companion
        // is running. A save made through Companion's OWN editor
        // (save_overlay_layout) applies to the cache immediately, without
        // waiting for this poll - this is only the "someone else edited it"
        // path.
        let mut last_overlay_layout_poll = Instant::now() - OVERLAY_LAYOUT_POLL_INTERVAL;
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
            if last_overlay_layout_poll.elapsed() >= OVERLAY_LAYOUT_POLL_INTERVAL {
                let _ = tauri::async_runtime::block_on(refresh_overlay_layout(&app_for_loop));
                last_overlay_layout_poll = Instant::now();
            }
            // WK-113 - no more automatic session-state poll here. PostStream
            // is now driven by the local OBS-authoritative lifecycle
            // (local_runtime::lifecycle, WK-112), not by this backend poll -
            // see obs.rs's handle_session_state, now called from
            // lifecycle::apply's FinalizeEnd/StartNewSession branches
            // instead. fetch_stream_session/get_stream_session below remain
            // available on-demand (WK-83's startup prompt, the manual
            // "Ручное управление" fallback card's own refresh button) - see
            // that card's explicit "legacy/manual, not required for the
            // OBS-driven runtime" framing in HomePage.tsx.
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

/// WK-100 - "Завершить стрим" button on Companion's main screen, so the
/// streamer no longer has to open the web cabinet just to end a stream.
/// Reuses the exact same backend `endActiveSession` service function the
/// web cabinet's own End button calls (via the new companion-token-
/// authenticated `/stream/companion/session/end` route, mirroring how
/// `reset_stream_session` above already reuses `resetActiveSession`) - not a
/// parallel end-of-stream implementation. `async` + `spawn_blocking` because
/// this is a direct user click that must not freeze the window.
///
/// On success (and only on success - a failed backend call must never leave
/// Companion believing the stream ended when it didn't), immediately applies
/// `session_ended` locally via `obs::handle_session_state` so the existing
/// OBS Post Stream automation (WK-99) fires right away instead of waiting up
/// to `SESSION_POLL_INTERVAL` for the next background poll to notice.
pub async fn end_stream_session(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || post_end_stream_session(&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))?;
    if result.is_ok() {
        obs::handle_session_state(app, true);
    }
    result
}

fn post_end_stream_session(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .post(format!("{DEFAULT_BACKEND_URL}/stream/companion/session/end"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Не удалось завершить стрим: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ завершения стрима: {error}"))
}

/// WK-121 - "Герои" favorites. Reads/writes the SAME `stream_queue_settings.
/// favoriteHeroIds` row the web cabinet's Favorite Heroes picker already
/// owns, via the new companion-token-authenticated
/// `/stream/companion/favorite-heroes` route (see that controller's doc
/// comment in apps/api) - not a local-only favorites store. `async` +
/// `spawn_blocking` for the same reason every other direct-user-action
/// command in this file is: called from a click (the star toggle), must
/// never block the IPC/UI thread.
pub async fn get_favorite_heroes(app: &AppHandle) -> Result<Vec<u32>, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || fetch_favorite_heroes(&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

#[derive(serde::Deserialize)]
struct FavoriteHeroesResponse {
    #[serde(rename = "favoriteHeroIds")]
    favorite_hero_ids: Vec<u32>,
}

fn fetch_favorite_heroes(token: &str) -> Result<Vec<u32>, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/favorite-heroes"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Избранные герои недоступны: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json::<FavoriteHeroesResponse>()
        .map(|body| body.favorite_hero_ids)
        .map_err(|error| format!("Неверный ответ избранных героев: {error}"))
}

pub async fn save_favorite_heroes(app: &AppHandle, hero_ids: Vec<u32>) -> Result<Vec<u32>, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Сначала добавьте companion token.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || put_favorite_heroes(&token, hero_ids))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

fn put_favorite_heroes(token: &str, hero_ids: Vec<u32>) -> Result<Vec<u32>, String> {
    let body = serde_json::json!({ "favoriteHeroIds": hero_ids });
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .put(format!("{DEFAULT_BACKEND_URL}/stream/companion/favorite-heroes"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|error| format!("Не удалось сохранить избранных героев: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json::<FavoriteHeroesResponse>()
        .map(|body| body.favorite_hero_ids)
        .map_err(|error| format!("Неверный ответ сохранения избранных героев: {error}"))
}

// WK-122 §7 - Companion account session (email/password login), replacing
// the copy/paste opaque Companion Token as the normal user-facing flow.
// Reuses the SAME backend session system the web cabinet already has
// (/stream/auth/login, /refresh, /logout - stream-user-service.ts) rather
// than inventing new auth surface: Companion just becomes a second client
// of that existing session, exactly like a web SPA storing a refresh token
// would. `AppState.companion_token` (read by every function above,
// unchanged) holds whichever bearer value is currently valid - a legacy
// static secret, or this session's short-lived access token - callers never
// need to know which. See `authenticateCompanionSession` (apps/api) for the
// matching backend half.
// Comfortably inside the backend's 1h access-token TTL even accounting for
// one missed/failed tick (a network blip) - the 30-day refresh token itself
// stays valid throughout, so a missed tick just means outgoing requests
// 401 and retry until the next successful refresh, never data loss (see
// local_runtime's own durable sync_outbox, unaffected by this either way).
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
    let has_legacy_token = app.state::<AppState>().0.lock().unwrap().companion_token.is_some();
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
        inner.companion_token = Some(response.access_token);
        // WK-94 - same reasoning as save_companion_token: a fresh login
        // invalidates whatever backend_state a previous failed
        // token/session earned.
        inner.backend_last_error = None;
        inner.backend_attempted = false;
        inner.backend_consecutive_failures = 0;
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

/// "Выйти" in Settings → Аккаунт.
pub async fn logout(app: &AppHandle) -> Result<AccountStatus, String> {
    if let Some(session) = storage::load_session(app) {
        // Best-effort revoke - a failed/offline logout must never trap the
        // user in a "connected" state locally; the refresh token simply
        // expires server-side on its own 30-day TTL if this never reaches it.
        let _ = tauri::async_runtime::spawn_blocking(move || post_logout(&session.refresh_token)).await;
    }
    storage::clear_session(app).map_err(|e| e.to_string())?;
    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.companion_token = None;
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
            inner.companion_token = Some(refreshed.access_token);
            Ok(())
        }
        Err(RefreshError::Revoked) => {
            let _ = storage::clear_session(app);
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.companion_token = None;
            Err("Сессия недействительна — нужно войти заново.".to_string())
        }
        Err(RefreshError::Transient(message)) => Err(message),
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

/// WK-122 §19 - fetches the real saved OverlayLayout from the companion-
/// scoped route (apps/api's `authenticateCompanionSession`-guarded
/// `/companion/overlay-layout`, added alongside this), caching it in
/// `AppState.overlay_layout` and bumping `overlay_layout_version` so
/// `overlay_server.rs`'s SSE stream can tell the local renderer to re-fetch
/// it. Passed through as an opaque `serde_json::Value` - see the field doc
/// on `InnerState.overlay_layout` for why Rust never needs to interpret
/// individual widget fields.
pub async fn refresh_overlay_layout(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Companion не подключён к аккаунту.".to_string())?;
    let layout = tauri::async_runtime::spawn_blocking(move || fetch_overlay_layout(&token))
        .await
        .map_err(|e| format!("Internal error: {e}"))??;
    apply_overlay_layout(app, layout.clone());
    Ok(layout)
}

fn fetch_overlay_layout(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .get(format!("{DEFAULT_BACKEND_URL}/stream/companion/overlay-layout"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("Оформление недоступно: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ оформления: {error}"))
}

/// "Сохранить" in the Оформление editor (DesignPage.tsx) - PUTs the whole
/// edited layout (apps/api's `normalizeOverlayLayout` validates/clamps
/// every field server-side, same as the web editor's save already does) and
/// caches the server's normalized response back, so the local preview
/// reflects exactly what was actually persisted, not the client's
/// pre-validation draft.
pub async fn save_overlay_layout(app: &AppHandle, layout: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .companion_token
        .clone()
        .ok_or_else(|| "Companion не подключён к аккаунту.".to_string())?;
    let saved = tauri::async_runtime::spawn_blocking(move || put_overlay_layout(&token, layout))
        .await
        .map_err(|e| format!("Internal error: {e}"))??;
    apply_overlay_layout(app, saved.clone());
    Ok(saved)
}

fn put_overlay_layout(token: &str, layout: serde_json::Value) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .put(format!("{DEFAULT_BACKEND_URL}/stream/companion/overlay-layout"))
        .bearer_auth(token)
        .json(&layout)
        .send()
        .map_err(|error| format!("Не удалось сохранить оформление: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response
        .json()
        .map_err(|error| format!("Неверный ответ сохранения оформления: {error}"))
}

fn apply_overlay_layout(app: &AppHandle, layout: serde_json::Value) {
    let state = app.state::<AppState>();
    let mut inner = state.0.lock().unwrap();
    if inner.overlay_layout.as_ref() != Some(&layout) {
        inner.overlay_layout = Some(layout.clone());
        inner.overlay_layout_version = inner.overlay_layout_version.saturating_add(1);
        drop(inner);
        if let Err(error) = storage::save_overlay_layout(app, &layout) {
            storage::append_rolling_log(app, &format!("Overlay layout: local cache write failed ({error})"));
        }
    }
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
