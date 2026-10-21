// WK-179 - Twitch chat overlay prototype. WoW Forever (1.60.1) gives addons
// no allowed inbound channel for live data (no sockets/HTTP/file reads, and
// SavedVariables load only at login or /reload) - see
// docs/research/wk-179-wow-chat-feasibility.md. Instead of an in-game addon
// this is an ordinary always-on-top, transparent, borderless window that sits
// over a game in borderless-windowed mode. It never touches the game process:
// no input injection, no memory access, no client files.
//
// The window only renders; chat data reaches it as events from the main
// window's existing useTwitchChatSession poll, so opening the overlay does
// not add a second backend/Twitch connection.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "chat-overlay";
const MODE_EVENT: &str = "chat-overlay://mode";

#[derive(Default)]
pub struct ChatOverlayState {
    click_through: Mutex<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOverlayStatus {
    open: bool,
    click_through: bool,
}

fn status(app: &AppHandle) -> ChatOverlayStatus {
    let open = app
        .get_webview_window(LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let click_through = *app.state::<ChatOverlayState>().click_through.lock().unwrap();
    ChatOverlayStatus { open, click_through }
}

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    // Size/position are persisted per label by tauri-plugin-window-state
    // (registered in lib.rs), so a moved/resized overlay comes back where
    // the streamer left it. focused(false): opening must not pull focus
    // away from the game.
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=chat-overlay".into()))
        .title("PreReborn — чат поверх игры")
        .inner_size(380.0, 520.0)
        .min_inner_size(220.0, 160.0)
        .decorations(false);
    // Windows is the target (games run there). macOS transparency needs
    // Tauri's macos-private-api feature, which isn't worth enabling for a dev
    // machine - there the overlay just has an opaque background.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    builder
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| format!("Не удалось создать окно оверлея: {error}"))
}

fn apply_click_through(app: &AppHandle, window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| format!("Не удалось переключить пропуск кликов: {error}"))?;
    *app.state::<ChatOverlayState>().click_through.lock().unwrap() = enabled;
    let _ = app.emit_to(LABEL, MODE_EVENT, enabled);
    Ok(())
}

#[tauri::command]
pub fn chat_overlay_open(app: AppHandle) -> Result<ChatOverlayStatus, String> {
    let window = window(&app)?;
    let enabled = *app.state::<ChatOverlayState>().click_through.lock().unwrap();
    apply_click_through(&app, &window, enabled)?;
    window.show().map_err(|error| format!("Не удалось показать оверлей: {error}"))?;
    Ok(status(&app))
}

// Hide, not destroy: CloseRequested is already turned into hide() in lib.rs,
// and window-state saves the geometry of live windows on exit.
#[tauri::command]
pub fn chat_overlay_close(app: AppHandle) -> Result<ChatOverlayStatus, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.hide().map_err(|error| format!("Не удалось скрыть оверлей: {error}"))?;
    }
    Ok(status(&app))
}

#[tauri::command]
pub fn chat_overlay_set_click_through(app: AppHandle, enabled: bool) -> Result<ChatOverlayStatus, String> {
    match app.get_webview_window(LABEL) {
        Some(window) => apply_click_through(&app, &window, enabled)?,
        None => *app.state::<ChatOverlayState>().click_through.lock().unwrap() = enabled,
    }
    Ok(status(&app))
}

#[tauri::command]
pub fn chat_overlay_status(app: AppHandle) -> ChatOverlayStatus {
    status(&app)
}
