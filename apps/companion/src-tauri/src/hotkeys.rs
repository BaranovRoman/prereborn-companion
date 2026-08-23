use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::storage;

// Global "skip current TTS utterance" hotkey. Companion's TTS audio is
// routed into OBS as Desktop Audio and heard by the whole stream, so this
// module - and everything downstream of the event it emits, see
// useTwitchChatSession.ts's skipTts() - must never itself produce sound.
// This module only owns registering/persisting the key combo and telling
// the frontend a press happened; the actual "stop this audio, cancel this
// synthesis, don't clear the queue, don't disable TTS" behavior lives in
// the frontend, which already has the playback/generation state needed to
// do that safely (see useTwitchChatSession.ts).
//
// Deliberately scoped to just this one action rather than a generic hotkey
// registry - a future action (Stop TTS, an OBS scene shortcut, ...) can get
// its own small config field + register/unregister pair the same way this
// one does, without this needing to become a framework up front.

pub const SKIP_TTS_EVENT: &str = "hotkeys://skip-tts";
const DEFAULT_SKIP_SHORTCUT: &str = "CommandOrControl+Alt+F10";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SkipHotkeyConfig {
    pub enabled: bool,
    pub shortcut: String,
}

impl Default for SkipHotkeyConfig {
    fn default() -> Self {
        Self { enabled: true, shortcut: DEFAULT_SKIP_SHORTCUT.to_string() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipHotkeyStatus {
    pub enabled: bool,
    pub shortcut: String,
    /// True once the shortcut is actually live with the OS - can be false
    /// even while `enabled` is true, if registration failed (see
    /// `last_error`) - the UI should surface that distinction rather than
    /// claiming the hotkey works just because the setting says so.
    pub registered: bool,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct HotkeysInner {
    config: SkipHotkeyConfig,
    registered_shortcut: Option<String>,
    last_error: Option<String>,
}

pub struct HotkeysState(pub Mutex<HotkeysInner>);

impl HotkeysState {
    pub fn new() -> Self {
        Self(Mutex::new(HotkeysInner::default()))
    }
}

fn config_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app_data_dir must resolve").join("hotkeys-config.json")
}

fn load_config(app: &AppHandle) -> SkipHotkeyConfig {
    fs::read_to_string(config_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &SkipHotkeyConfig) -> std::io::Result<()> {
    let path = config_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(config)?)
}

/// A disabled hotkey, or one with an empty combo, is never registered with
/// the OS - pure predicate so "disabled hotkeys stay unregistered" is
/// unit-testable without touching a real GlobalHotKeyManager.
fn should_register(config: &SkipHotkeyConfig) -> bool {
    config.enabled && !config.shortcut.trim().is_empty()
}

/// Rejects an empty combo before any OS call is attempted - separated out
/// so the validation itself is unit-testable.
fn validate(enabled: bool, shortcut: &str) -> Result<(), String> {
    if enabled && shortcut.trim().is_empty() {
        return Err("Укажите комбинацию клавиш.".to_string());
    }
    Ok(())
}

/// Pure decision step: given whether the OS-level (un)registration attempt
/// for `attempted` succeeded, computes the config/registered-shortcut state
/// that should end up persisted/held - critically, a failed attempt rolls
/// back to `previous` instead of leaving the app with a half-applied,
/// non-working hotkey. Kept free of any AppHandle/OS call so this rollback
/// behavior is unit-testable without a live GlobalHotKeyManager (same
/// reasoning as silero.rs's `record_failure`).
fn resolve_after_attempt(
    previous: &SkipHotkeyConfig,
    attempted: SkipHotkeyConfig,
    attempt_result: Result<(), String>,
) -> (SkipHotkeyConfig, Option<String>) {
    match attempt_result {
        Ok(()) => (attempted, None),
        Err(error) => (previous.clone(), Some(error)),
    }
}

fn emit_skip(app: &AppHandle) {
    let _ = app.emit(SKIP_TTS_EVENT, ());
}

/// Registers `shortcut` to emit [`SKIP_TTS_EVENT`] on key-down only (a held
/// key otherwise also fires a key-up event on some platforms, which would
/// double-skip). Does not touch any previously-registered shortcut - callers
/// decide when/whether to unregister one first.
fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                emit_skip(app);
            }
        })
        .map_err(|e| format!("Не удалось зарегистрировать комбинацию «{shortcut}»: {e}"))
}

fn unregister_shortcut(app: &AppHandle, shortcut: &str) {
    let _ = app.global_shortcut().unregister(shortcut);
}

/// Loads the persisted config and, if it's enabled, tries to register it -
/// a startup failure (e.g. the combo is now taken by another app) is
/// reported via `last_error`/`status()` but never fatal to app startup.
pub fn init(app: &AppHandle) {
    let config = load_config(app);
    let mut last_error = None;
    let mut registered_shortcut = None;
    if should_register(&config) {
        match register_shortcut(app, &config.shortcut) {
            Ok(()) => registered_shortcut = Some(config.shortcut.clone()),
            Err(error) => {
                storage::append_rolling_log(
                    app,
                    &format!("Skip-TTS hotkey failed to register at startup: {error}"),
                );
                last_error = Some(error);
            }
        }
    }
    let state = app.state::<HotkeysState>();
    let mut inner = state.0.lock().unwrap();
    inner.config = config;
    inner.registered_shortcut = registered_shortcut;
    inner.last_error = last_error;
}

pub fn status(app: &AppHandle) -> SkipHotkeyStatus {
    let state = app.state::<HotkeysState>();
    let inner = state.0.lock().unwrap();
    SkipHotkeyStatus {
        enabled: inner.config.enabled,
        shortcut: inner.config.shortcut.clone(),
        registered: inner.registered_shortcut.is_some(),
        last_error: inner.last_error.clone(),
    }
}

/// Applies a new skip-hotkey configuration: unregisters whatever's currently
/// live, tries to register the new one, and rolls back to the previous
/// working shortcut if that fails - a bad/already-taken combo never leaves
/// the user with no working hotkey. Only persists to disk once the new
/// combo is confirmed to actually work.
pub fn set_skip_hotkey(app: &AppHandle, enabled: bool, shortcut: String) -> Result<SkipHotkeyStatus, String> {
    let shortcut = shortcut.trim().to_string();
    validate(enabled, &shortcut)?;

    let state = app.state::<HotkeysState>();
    let (previous_registered, previous_config) = {
        let inner = state.0.lock().unwrap();
        (inner.registered_shortcut.clone(), inner.config.clone())
    };

    if let Some(previous) = &previous_registered {
        unregister_shortcut(app, previous);
    }

    let attempted = SkipHotkeyConfig { enabled, shortcut: shortcut.clone() };
    let attempt_result =
        if should_register(&attempted) { register_shortcut(app, &shortcut) } else { Ok(()) };

    let (resolved_config, error) =
        resolve_after_attempt(&previous_config, attempted, attempt_result);

    // What's actually live with the OS after the branch below runs: on
    // success, exactly what should_register(resolved_config) says (Some only
    // if the new config is enabled with a combo); on failure, whatever the
    // rollback below restores (the previous shortcut, or nothing if there
    // was none) - never "fall back to the just-unregistered previous value"
    // on a *successful* disable, which would wrongly claim a shortcut that
    // was just unregistered is still live.
    let registered_shortcut = if error.is_some() {
        if let Some(previous) = &previous_registered {
            let _ = register_shortcut(app, previous);
        }
        previous_registered
    } else if let Err(e) = save_config(app, &resolved_config) {
        let mut inner = state.0.lock().unwrap();
        inner.config = resolved_config;
        inner.registered_shortcut = if should_register(&inner.config) { Some(inner.config.shortcut.clone()) } else { None };
        inner.last_error = Some(format!("Настройка применена, но не сохранена на диск: {e}"));
        drop(inner);
        return Ok(status(app));
    } else if should_register(&resolved_config) {
        Some(resolved_config.shortcut.clone())
    } else {
        None
    };

    let mut inner = state.0.lock().unwrap();
    inner.config = resolved_config.clone();
    inner.registered_shortcut = registered_shortcut;
    inner.last_error = error.clone();
    drop(inner);

    if let Some(error) = error {
        return Err(error);
    }
    storage::append_rolling_log(
        app,
        &format!(
            "Skip-TTS hotkey {}.",
            if resolved_config.enabled { format!("set to {}", resolved_config.shortcut) } else { "disabled".to_string() }
        ),
    );
    Ok(status(app))
}

/// Unregisters the live shortcut without touching persisted config - used on
/// app exit alongside tts::stop/silero::stop.
pub fn stop(app: &AppHandle) {
    let state = app.state::<HotkeysState>();
    let mut inner = state.0.lock().unwrap();
    if let Some(shortcut) = inner.registered_shortcut.take() {
        unregister_shortcut(app, &shortcut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_enabled_with_a_non_empty_shortcut() {
        let config = SkipHotkeyConfig::default();
        assert!(config.enabled);
        assert!(!config.shortcut.trim().is_empty());
    }

    #[test]
    fn default_config_round_trips_through_json() {
        let config: SkipHotkeyConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(config, SkipHotkeyConfig::default());
    }

    // Persistence for the specific keys this ticket is about: a saved
    // bare-F12 (or Ctrl+F12) config must round-trip through the same
    // JSON (de)serialization `load_config`/`save_config` use, unchanged.
    #[test]
    fn a_bare_f12_config_round_trips_through_json() {
        let config = SkipHotkeyConfig { enabled: true, shortcut: "F12".to_string() };
        let json = serde_json::to_string(&config).unwrap();
        let restored: SkipHotkeyConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, config);
    }

    #[test]
    fn a_ctrl_f12_config_round_trips_through_json() {
        let config = SkipHotkeyConfig { enabled: true, shortcut: "Ctrl+F12".to_string() };
        let json = serde_json::to_string(&config).unwrap();
        let restored: SkipHotkeyConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, config);
    }

    #[test]
    fn missing_or_malformed_persisted_config_falls_back_to_default() {
        // Mirrors tts.rs/silero.rs's load_config pattern: any parse failure
        // (corrupt file, wrong shape) must fall back cleanly, never panic.
        let malformed: Option<SkipHotkeyConfig> = serde_json::from_str("not json").ok();
        assert!(malformed.is_none());
    }

    // The real default shortcut string must actually parse as a valid
    // `Shortcut` - this is the one place the plugin's own parser can be
    // exercised without an AppHandle/live GlobalHotKeyManager, since parsing
    // is pure (no OS registration happens here).
    #[test]
    fn default_shortcut_string_parses_as_a_valid_shortcut() {
        use std::str::FromStr;
        tauri_plugin_global_shortcut::Shortcut::from_str(DEFAULT_SKIP_SHORTCUT)
            .expect("DEFAULT_SKIP_SHORTCUT must always be a parseable shortcut");
    }

    #[test]
    fn an_empty_shortcut_string_does_not_parse() {
        use std::str::FromStr;
        assert!(tauri_plugin_global_shortcut::Shortcut::from_str("").is_err());
    }

    // Regression for a real reported bug: a streamer could not assign F12 as
    // the skip-TTS hotkey. Investigation found nothing in this codebase (nor
    // the global-hotkey crate it wraps) that rejects a bare F-key - these
    // pin that down as an executable fact so a future dependency bump can't
    // silently reintroduce a rejection here. F9-F11 included as siblings the
    // task specifically called out as desirable streamer controls; the
    // actual block (if reproduced again) is expected to be OS/webview-level,
    // upstream of this parser - see the PR report for how to tell the two
    // apart (registration failure with an error vs. the recorder UI never
    // receiving the keydown at all).
    #[test]
    fn bare_function_keys_f9_through_f12_all_parse() {
        use std::str::FromStr;
        for key in ["F9", "F10", "F11", "F12"] {
            tauri_plugin_global_shortcut::Shortcut::from_str(key)
                .unwrap_or_else(|e| panic!("bare {key} must parse as a valid shortcut: {e}"));
        }
    }

    #[test]
    fn a_modifier_plus_f12_combo_parses() {
        use std::str::FromStr;
        tauri_plugin_global_shortcut::Shortcut::from_str("Ctrl+F12")
            .expect("Ctrl+F12 must parse as a valid shortcut");
    }

    #[test]
    fn disabled_hotkey_is_never_registered_even_with_a_shortcut_set() {
        let config = SkipHotkeyConfig { enabled: false, shortcut: DEFAULT_SKIP_SHORTCUT.to_string() };
        assert!(!should_register(&config));
    }

    #[test]
    fn enabled_hotkey_with_a_shortcut_should_register() {
        let config = SkipHotkeyConfig { enabled: true, shortcut: DEFAULT_SKIP_SHORTCUT.to_string() };
        assert!(should_register(&config));
    }

    #[test]
    fn enabled_hotkey_with_an_empty_or_blank_shortcut_should_not_register() {
        assert!(!should_register(&SkipHotkeyConfig { enabled: true, shortcut: String::new() }));
        assert!(!should_register(&SkipHotkeyConfig { enabled: true, shortcut: "   ".to_string() }));
    }

    #[test]
    fn validate_rejects_enabling_with_an_empty_combo() {
        assert!(validate(true, "").is_err());
        assert!(validate(true, "   ").is_err());
    }

    #[test]
    fn validate_allows_disabling_with_an_empty_combo() {
        // Disabling clears/ignores the combo - only enabling requires one.
        assert!(validate(false, "").is_ok());
    }

    #[test]
    fn validate_allows_a_non_empty_combo() {
        assert!(validate(true, DEFAULT_SKIP_SHORTCUT).is_ok());
    }

    // Core rollback contract: a failed (un)registration attempt must never
    // leave the app on the new (broken) config - it must fall back to
    // whatever was working before, exactly as commands.rs/set_skip_hotkey
    // relies on via resolve_after_attempt.
    #[test]
    fn a_failed_attempt_rolls_back_to_the_previous_config_and_surfaces_the_error() {
        let previous = SkipHotkeyConfig { enabled: true, shortcut: "Ctrl+Alt+F9".to_string() };
        let attempted = SkipHotkeyConfig { enabled: true, shortcut: "Ctrl+Alt+F10".to_string() };
        let (resolved, error) =
            resolve_after_attempt(&previous, attempted, Err("already taken".to_string()));
        assert_eq!(resolved, previous);
        assert_eq!(error.as_deref(), Some("already taken"));
    }

    #[test]
    fn a_successful_attempt_adopts_the_new_config_with_no_error() {
        let previous = SkipHotkeyConfig { enabled: true, shortcut: "Ctrl+Alt+F9".to_string() };
        let attempted = SkipHotkeyConfig { enabled: true, shortcut: "Ctrl+Alt+F10".to_string() };
        let (resolved, error) = resolve_after_attempt(&previous, attempted.clone(), Ok(()));
        assert_eq!(resolved, attempted);
        assert!(error.is_none());
    }

    #[test]
    fn disabling_never_needs_a_successful_os_attempt_to_be_treated_as_ok() {
        // set_skip_hotkey short-circuits the OS call entirely when the
        // resulting config shouldn't be registered (should_register ==
        // false) - disabling always succeeds regardless of OS state.
        let previous = SkipHotkeyConfig::default();
        let attempted = SkipHotkeyConfig { enabled: false, shortcut: previous.shortcut.clone() };
        assert!(!should_register(&attempted));
        let (resolved, error) = resolve_after_attempt(&previous, attempted.clone(), Ok(()));
        assert_eq!(resolved, attempted);
        assert!(error.is_none());
    }

    // Live OS registration (GlobalHotKeyManager) is intentionally not
    // exercised here - it needs a real event loop/display server, the same
    // reasoning tts.rs/silero.rs use for their #[ignore]'d real-subprocess
    // tests. Manual QA (see the feature report) covers register/unregister
    // against the real OS; everything decidable without one is covered above.
}
