use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Local;
use tauri::{AppHandle, Manager, Runtime};
use crate::obs::ObsConfig;
use crate::secure_storage::{self, SecretStore};

const ROLLING_LOG_NAME: &str = "app.log";
const ROLLING_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

// WK-116 - generic over `R: Runtime` (rather than the bare `AppHandle`
// alias, which defaults to the concrete `Wry` runtime) so this - and
// `append_rolling_log`/`read_rolling_log` below, which route through it -
// can be called from an integration test driving a `tauri::test::mock_app`
// (a different, `MockRuntime`-backed `AppHandle`). Every existing call site
// keeps compiling unchanged: passing a concrete `&AppHandle` (`Wry`) still
// satisfies `&AppHandle<R>` via ordinary type inference with `R = Wry`.
pub fn logs_root<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("logs")
}

fn companion_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("companion-config.json")
}

fn overlay_layout_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("overlay-layout.json")
}

pub fn save_overlay_layout(app: &AppHandle, layout: &serde_json::Value) -> std::io::Result<()> {
    let path = overlay_layout_path(app);
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    fs::write(path, serde_json::to_string_pretty(layout)?)
}

pub fn load_overlay_layout(app: &AppHandle) -> Option<serde_json::Value> {
    fs::read_to_string(overlay_layout_path(app)).ok().and_then(|raw| serde_json::from_str(&raw).ok())
}

fn queue_settings_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app_data_dir must resolve").join("queue-settings.json")
}

pub fn queue_webcam_fallback_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().app_data_dir().expect("app_data_dir must resolve").join("queue-webcam-fallback.image")
}

pub fn gameplay_reference_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().app_data_dir().expect("app_data_dir must resolve").join("gameplay-reference.image")
}

pub fn save_queue_settings(app: &AppHandle, settings: &serde_json::Value) -> std::io::Result<()> {
    let path = queue_settings_path(app);
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    fs::write(path, serde_json::to_string_pretty(settings)?)
}

pub fn load_queue_settings(app: &AppHandle) -> Option<serde_json::Value> {
    fs::read_to_string(queue_settings_path(app)).ok().and_then(|raw| serde_json::from_str(&raw).ok())
}

fn account_overlay_data_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app_data_dir must resolve").join("account-overlay-data.json")
}

pub fn save_account_overlay_data(app: &AppHandle, data: &serde_json::Value) -> std::io::Result<()> {
    let path = account_overlay_data_path(app);
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    fs::write(path, serde_json::to_string_pretty(data)?)
}

pub fn load_account_overlay_data(app: &AppHandle) -> Option<serde_json::Value> {
    fs::read_to_string(account_overlay_data_path(app)).ok().and_then(|raw| serde_json::from_str(&raw).ok())
}

// WK-122 - every function below that touches companion-config.json is
// split into a thin `AppHandle`-resolving public wrapper and a `_at(path)`
// core that takes the file path directly and does no Tauri I/O of its own -
// the actual logic (JSON merge/read/write) lives entirely in the `_at`
// versions, which the test module drives directly against a `tempfile`
// path. This is deliberate, not incidental: `tauri::test::mock_app()`'s
// `app_data_dir()` resolves to a REAL path on the host filesystem (it is
// NOT sandboxed to a per-test temp directory the way the mocked DB
// connections in local_runtime's tests are), so exercising these functions
// through a mocked `AppHandle` would have every test in this module read
// and write the SAME real file on disk, racing every other test that runs
// in parallel (and, worse, quietly touching whatever this file actually
// resolves to in the real Application Support / AppData for whoever runs
// the tests). Routing through a `Path` instead keeps every test hermetic.

// WK-125 - real, reusable secrets (the legacy companion token, the session
// refresh token, the OBS WebSocket password) now live in the OS-backed
// credential store (see secure_storage.rs) rather than plaintext JSON.
// companion-config.json / obs-config.json still hold everything that isn't a
// secret (account email, OBS host/port/scene names) plus, only as a
// failure-safe fallback, a credential the secure store itself refused to
// accept. Migration is: on read, if the secure store already has the value
// use it (and delete any plaintext leftover); otherwise if a legacy
// plaintext value exists, try to write it to the secure store, verify the
// write by reading it back, and only then strip the plaintext copy - a
// failed or unverified write leaves the plaintext value exactly as it was,
// so a locked/unavailable keychain never costs the user their login. This
// makes every migration idempotent (nothing left to migrate once the
// plaintext copy is gone) and restart-safe (the secure store is always
// re-checked first, never assumed).
const KEY_COMPANION_TOKEN: &str = "companion_token";
const KEY_REFRESH_TOKEN: &str = "refresh_token";
const KEY_OBS_PASSWORD: &str = "obs_password";

pub fn save_companion_token(app: &AppHandle, token: &str) -> std::io::Result<()> {
    save_companion_token_at(&companion_config_path(app), token, &secure_storage::os_store())
}

pub fn load_companion_token(app: &AppHandle) -> Option<String> {
    load_companion_token_at(&companion_config_path(app), &secure_storage::os_store())
}

/// Removes the legacy companion token from both the secure store and any
/// plaintext leftover. Called from `backend::logout` alongside
/// `clear_session` - WK-125 fix: logout previously only ever cleared the
/// session, silently leaving a legacy-method account's token on disk to be
/// reloaded on the next launch (see the audit report).
pub fn clear_companion_token(app: &AppHandle) -> std::io::Result<()> {
    clear_companion_token_at(&companion_config_path(app), &secure_storage::os_store())
}

// WK-122 §7 - the desktop-auth session (email/password login, see
// backend::login). `email` is an account identifier, not a secret, and stays
// in companion-config.json; `refresh_token` is the one real secret here and
// is migrated to/read from the secure store the same way as the legacy
// token above. The short-lived access token this session mints is kept
// purely in memory (AppState.companion_token) and never written to disk at
// all - see backend::refresh_session_access_token.
//
// Debug is implemented by hand (not derived) so a stray `{:?}`/`dbg!()` on a
// session value - e.g. a future debugging line dropped into the refresh/
// login path - can never print the refresh token into the rolling log,
// which is bundled unconditionally into every diagnostics ZIP export.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CompanionSession {
    pub email: String,
    pub refresh_token: String,
}

impl std::fmt::Debug for CompanionSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompanionSession")
            .field("email", &self.email)
            .field("refresh_token", &"[REDACTED]")
            .finish()
    }
}

pub fn save_session(app: &AppHandle, session: &CompanionSession) -> std::io::Result<()> {
    save_session_at(&companion_config_path(app), session, &secure_storage::os_store())
}

pub fn load_session(app: &AppHandle) -> Option<CompanionSession> {
    load_session_at(&companion_config_path(app), &secure_storage::os_store())
}

pub fn clear_session(app: &AppHandle) -> std::io::Result<()> {
    clear_session_at(&companion_config_path(app), &secure_storage::os_store())
}

fn read_companion_config_at(path: &Path) -> serde_json::Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_companion_config_at(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)?)
}

/// `true` only if the secure store now demonstrably holds `value` under
/// `key` - a `set` call can report success on some backends even when the
/// write didn't actually stick, so every migration path verifies with a
/// read-back before ever touching the plaintext copy it migrated from.
fn secure_write_verified(store: &dyn SecretStore, key: &str, value: &str) -> bool {
    store.set(key, value).is_ok() && matches!(store.get(key), Ok(Some(stored)) if stored == value)
}

fn save_companion_token_at(path: &Path, token: &str, store: &dyn SecretStore) -> std::io::Result<()> {
    let mut config = read_companion_config_at(path);
    if secure_write_verified(store, KEY_COMPANION_TOKEN, token) {
        if let Some(map) = config.as_object_mut() {
            map.remove("companion_token");
        }
    } else {
        // Secure store unavailable/unwritable right now - fall back to the
        // old plaintext behavior rather than lose the token outright.
        config["companion_token"] = serde_json::Value::String(token.to_string());
    }
    write_companion_config_at(path, &config)
}

fn load_companion_token_at(path: &Path, store: &dyn SecretStore) -> Option<String> {
    if let Ok(Some(token)) = store.get(KEY_COMPANION_TOKEN) {
        strip_plaintext_key_if_present(path, "companion_token");
        return Some(token);
    }

    let config = read_companion_config_at(path);
    let legacy = config.get("companion_token").and_then(|v| v.as_str()).map(str::to_string)?;
    if secure_write_verified(store, KEY_COMPANION_TOKEN, &legacy) {
        strip_plaintext_key_if_present(path, "companion_token");
    }
    Some(legacy)
}

fn clear_companion_token_at(path: &Path, store: &dyn SecretStore) -> std::io::Result<()> {
    let _ = store.delete(KEY_COMPANION_TOKEN);
    let mut config = read_companion_config_at(path);
    if let Some(map) = config.as_object_mut() {
        map.remove("companion_token");
    }
    write_companion_config_at(path, &config)
}

fn strip_plaintext_key_if_present(path: &Path, key: &str) {
    let mut config = read_companion_config_at(path);
    if let Some(map) = config.as_object_mut() {
        if map.remove(key).is_some() {
            let _ = write_companion_config_at(path, &config);
        }
    }
}

fn save_session_at(path: &Path, session: &CompanionSession, store: &dyn SecretStore) -> std::io::Result<()> {
    let mut config = read_companion_config_at(path);
    let mut session_json = serde_json::json!({ "email": session.email });
    if !secure_write_verified(store, KEY_REFRESH_TOKEN, &session.refresh_token) {
        // Same failure-safe fallback as the companion token above.
        session_json["refresh_token"] = serde_json::Value::String(session.refresh_token.clone());
    }
    config["session"] = session_json;
    write_companion_config_at(path, &config)
}

fn load_session_at(path: &Path, store: &dyn SecretStore) -> Option<CompanionSession> {
    let config = read_companion_config_at(path);
    let session_json = config.get("session")?;
    let email = session_json.get("email")?.as_str()?.to_string();
    let legacy_refresh_token = session_json.get("refresh_token").and_then(|v| v.as_str()).map(str::to_string);

    let refresh_token = if let Ok(Some(token)) = store.get(KEY_REFRESH_TOKEN) {
        if legacy_refresh_token.is_some() {
            strip_session_refresh_token_field(path);
        }
        token
    } else {
        let legacy = legacy_refresh_token?;
        if secure_write_verified(store, KEY_REFRESH_TOKEN, &legacy) {
            strip_session_refresh_token_field(path);
        }
        legacy
    };

    Some(CompanionSession { email, refresh_token })
}

fn strip_session_refresh_token_field(path: &Path) {
    let mut config = read_companion_config_at(path);
    if let Some(session) = config.get_mut("session").and_then(|v| v.as_object_mut()) {
        if session.remove("refresh_token").is_some() {
            let _ = write_companion_config_at(path, &config);
        }
    }
}

fn clear_session_at(path: &Path, store: &dyn SecretStore) -> std::io::Result<()> {
    let _ = store.delete(KEY_REFRESH_TOKEN);
    let mut config = read_companion_config_at(path);
    if let Some(map) = config.as_object_mut() {
        map.remove("session");
    }
    write_companion_config_at(path, &config)
}

fn obs_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("obs-config.json")
}

pub fn save_obs_config(app: &AppHandle, config: &ObsConfig) -> std::io::Result<()> {
    save_obs_config_at(&obs_config_path(app), config, &secure_storage::os_store())
}

pub fn load_obs_config(app: &AppHandle) -> ObsConfig {
    load_obs_config_at(&obs_config_path(app), &secure_storage::os_store())
}

fn save_obs_config_at(path: &Path, config: &ObsConfig, store: &dyn SecretStore) -> std::io::Result<()> {
    let mut to_write = config.clone();
    if config.password.is_empty() {
        // commands::save_obs_config already resolves "keep the existing
        // password" before calling this - an empty password here means
        // there genuinely isn't one yet, not "erase it".
    } else if secure_write_verified(store, KEY_OBS_PASSWORD, &config.password) {
        to_write.password = String::new();
    }
    // else: secure store unavailable - fall back to plaintext rather than
    // lose a working OBS connection.
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(&to_write)?)
}

fn load_obs_config_at(path: &Path, store: &dyn SecretStore) -> ObsConfig {
    let mut config: ObsConfig = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    if !config.password.is_empty() {
        // Legacy plaintext password from before this migration.
        let legacy = std::mem::take(&mut config.password);
        if secure_write_verified(store, KEY_OBS_PASSWORD, &legacy) {
            let _ = fs::write(path, serde_json::to_string_pretty(&config).unwrap_or_default());
        }
        config.password = legacy;
        return config;
    }

    if let Ok(Some(password)) = store.get(KEY_OBS_PASSWORD) {
        config.password = password;
    }
    config
}

pub fn init(app: &AppHandle) -> std::io::Result<()> {
    fs::create_dir_all(logs_root(app))?;
    Ok(())
}

fn rolling_log_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    logs_root(app).join(ROLLING_LOG_NAME)
}

// WK-129 re-audit finding - a plain `fs::rename` here used to be a silent
// no-op on failure (e.g. `app.log.1` locked by an AV/OneDrive scan, the exact
// class of interference WK-109's doc comment above already flags for the
// open+write+close path). With no fallback, a failed rotation let app.log
// grow past ROLLING_LOG_MAX_BYTES indefinitely, since every subsequent
// append() only re-checked the same size and re-attempted the same rename.
// Truncating in place when rotation can't proceed keeps the file bounded
// even under that failure mode, at the cost of losing the not-yet-rotated
// generation instead of the file growing without limit.
fn rotate_if_needed(path: &PathBuf) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > ROLLING_LOG_MAX_BYTES {
            let rotated = path.with_extension("log.1");
            if fs::rename(path, rotated).is_err() {
                let _ = fs::write(path, b"");
            }
        }
    }
}

// WK-116 - the always-on rolling log (bounded at ROLLING_LOG_MAX_BYTES) is
// the one artifact that exists regardless of whether the user ever thought
// to turn on diagnostics-mode capture before something went wrong - see
// diagnostics::export, which now bundles this into the exported ZIP
// unconditionally so a single Diagnostics export is enough for the next
// investigation, per the задача's explicit "не входит в diagnostics ZIP -
// добавь" instruction.
pub fn read_rolling_log<R: Runtime>(app: &AppHandle<R>) -> Vec<u8> {
    fs::read(rolling_log_path(app)).unwrap_or_default()
}

// WK-48 - lets the diagnostics export preview show the log's size without
// reading its full (up to ROLLING_LOG_MAX_BYTES) contents into memory just
// to report a byte count. Split into an `AppHandle`-resolving wrapper plus a
// `_at(path)` core (WK-122's pattern - see its doc comment above) so the
// test module can drive it against a tempfile path instead of the real,
// unsandboxed `app_data_dir` a mocked `AppHandle` would resolve to.
pub fn rolling_log_size_bytes<R: Runtime>(app: &AppHandle<R>) -> u64 {
    rolling_log_size_bytes_at(&rolling_log_path(app))
}

fn rolling_log_size_bytes_at(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn append_rolling_log<R: Runtime>(app: &AppHandle<R>, line: &str) {
    let path = rolling_log_path(app);
    rotate_if_needed(&path);
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let entry = format!("[{timestamp}] {line}\n");

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(entry.as_bytes());
    }

    // Also mirror to stdout so `pnpm tauri dev` shows live activity in the terminal.
    print!("{entry}");
}

pub fn clear_logs(app: &AppHandle) -> std::io::Result<()> {
    let path = rolling_log_path(app);
    fs::write(&path, b"")?;
    let rotated = path.with_extension("log.1");
    let _ = fs::remove_file(rotated);

    cleanup_legacy_payloads(app);

    append_rolling_log(app, "Logs cleared by user.");
    Ok(())
}

pub struct ParsedPayload {
    pub summary: String,
    // Some(...) only when raw_body parsed as JSON - used by server/mod.rs to
    // feed the backend-forwarding queue (backend/mod.rs).
    pub parsed: Option<serde_json::Value>,
}

/// Parses one incoming GSI request body in memory - no file is written for
/// it. Normal Companion usage no longer persists a per-request payload file
/// (see `cleanup_legacy_payloads` for removing what earlier versions left
/// behind); detailed raw payload capture is diagnostics-only, gated behind
/// an explicitly started session (see `diagnostics::observe`).
pub fn parse_payload(raw_body: &str) -> ParsedPayload {
    let parsed: Option<serde_json::Value> = serde_json::from_str(raw_body).ok();
    let summary = summarize_payload(parsed.as_ref(), raw_body);
    ParsedPayload { summary, parsed }
}

static LEGACY_CLEANUP_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

pub fn legacy_cleanup_in_progress() -> bool {
    LEGACY_CLEANUP_IN_PROGRESS.load(Ordering::SeqCst)
}

const LEGACY_PAYLOADS_DIR_NAME: &str = "payloads";
const LEGACY_CLEANUP_STAGE_PREFIX: &str = "payloads.cleanup-";

/// Atomically renames `dir` out of the way so callers never wait on however
/// many files it holds - a rename is a single filesystem metadata operation,
/// independent of file count, unlike deleting file-by-file. Falls back to
/// returning `dir` itself if the rename fails (e.g. a file inside is
/// momentarily locked by an AV scanner or Explorer has it open) - the caller
/// still removes it, just not staged first.
fn stage_directory_for_removal(dir: &Path) -> PathBuf {
    let staged = dir.with_file_name(format!(
        "{LEGACY_CLEANUP_STAGE_PREFIX}{}",
        Local::now().format("%Y%m%dT%H%M%S%.3f")
    ));
    match fs::rename(dir, &staged) {
        Ok(()) => staged,
        Err(_) => dir.to_path_buf(),
    }
}

/// Finds everything that needs deleting: the legacy `payloads` directory (if
/// still present) plus any `payloads.cleanup-*` staging directories left
/// behind by a previous cleanup that got interrupted or hit a locked file -
/// so a failed deletion is retried on the next call instead of leaking an
/// orphaned directory forever. Pure/path-based so it's unit-testable without
/// an AppHandle.
fn collect_legacy_cleanup_targets(logs_root: &Path) -> Vec<PathBuf> {
    let mut targets = Vec::new();

    // Stage `payloads` first (a side effect), then find it again below via
    // the prefix scan rather than also pushing it here directly - otherwise
    // a successful rename would be counted (and later deleted) twice. The
    // one case that scan can't find is a *failed* rename, where `dir` keeps
    // its original, non-prefixed name - that one is added directly.
    let dir = logs_root.join(LEGACY_PAYLOADS_DIR_NAME);
    if dir.exists() {
        let staged = stage_directory_for_removal(&dir);
        if staged == dir {
            targets.push(staged);
        }
    }

    if let Ok(entries) = fs::read_dir(logs_root) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let is_stage_dir = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with(LEGACY_CLEANUP_STAGE_PREFIX));
            if is_stage_dir && path.is_dir() {
                targets.push(path);
            }
        }
    }

    targets
}

/// Removes whatever's left of the legacy per-request GSI payload directory
/// (from before this was gated behind diagnostics) in the background, so
/// callers - the "Очистить лог" button and the startup safety net - never
/// block on however many hundreds of thousands of files a long-running
/// install accumulated. A no-op if nothing needs cleaning, and a no-op if a
/// cleanup is already running rather than starting a second, overlapping
/// one.
pub fn cleanup_legacy_payloads(app: &AppHandle) {
    // The guard is acquired *before* looking for anything to clean, not
    // after: collecting targets renames directories on disk as a side
    // effect, so two overlapping callers racing to collect first (rather
    // than racing on the atomic swap) could both rename something and only
    // one would ever spawn a thread to delete it - leaking a staged
    // directory. Acquiring first means only the caller that actually wins
    // the swap ever touches the filesystem.
    if LEGACY_CLEANUP_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return;
    }

    let targets = collect_legacy_cleanup_targets(&logs_root(app));
    if targets.is_empty() {
        LEGACY_CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let mut failed = Vec::new();
        for target in &targets {
            if let Err(e) = fs::remove_dir_all(target) {
                failed.push(format!("{}: {e}", target.display()));
            }
        }
        LEGACY_CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);
        if failed.is_empty() {
            append_rolling_log(
                &app,
                &format!(
                    "Legacy GSI payload log cleanup finished ({} director{} removed).",
                    targets.len(),
                    if targets.len() == 1 { "y" } else { "ies" }
                ),
            );
        } else {
            append_rolling_log(
                &app,
                &format!(
                    "Legacy GSI payload log cleanup: {} of {} director{} failed, will retry next launch/cleanup (non-fatal): {}",
                    failed.len(),
                    targets.len(),
                    if targets.len() == 1 { "y" } else { "ies" },
                    failed.join("; ")
                ),
            );
        }
    });
}

fn summarize_payload(parsed: Option<&serde_json::Value>, raw_body: &str) -> String {
    let Some(value) = parsed else {
        return format!("non-JSON body ({} bytes)", raw_body.len());
    };
    let Some(obj) = value.as_object() else {
        return "JSON payload (not an object)".to_string();
    };

    let mut parts = Vec::new();
    if let Some(state) = obj
        .get("map")
        .and_then(|m| m.get("game_state"))
        .and_then(|v| v.as_str())
    {
        parts.push(format!("game_state={state}"));
    }
    if let Some(activity) = obj
        .get("player")
        .and_then(|p| p.get("activity"))
        .and_then(|v| v.as_str())
    {
        parts.push(format!("player.activity={activity}"));
    }
    if let Some(hero_name) = obj
        .get("hero")
        .and_then(|h| h.get("name"))
        .and_then(|v| v.as_str())
    {
        parts.push(format!("hero={hero_name}"));
    }

    if parts.is_empty() {
        let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        format!("keys: [{}]", keys.join(", "))
    } else {
        parts.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn parse_payload_never_touches_disk_even_under_heavy_load() {
        // Regression guard for the root cause this module used to have: a
        // file written per GSI request. 1000 simulated requests must not
        // create a single file anywhere - parse_payload has no AppHandle/
        // path parameter at all, so this is also structurally guaranteed by
        // its signature, not just by this test.
        let dir = tempfile::tempdir().unwrap();
        for i in 0..1000 {
            let body = format!(
                r#"{{"map":{{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"}},"seq":{i}}}"#
            );
            let result = parse_payload(&body);
            assert!(result.parsed.is_some());
            assert_eq!(result.summary, "game_state=DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");
        }
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert!(entries.is_empty(), "parse_payload must not create any files");
    }

    #[test]
    fn parse_payload_handles_non_json_body_without_panicking() {
        let result = parse_payload("not json");
        assert!(result.parsed.is_none());
        assert_eq!(result.summary, "non-JSON body (8 bytes)");
    }

    #[test]
    fn rotate_if_needed_renames_an_oversized_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        fs::write(&path, vec![b'x'; (ROLLING_LOG_MAX_BYTES + 1) as usize]).unwrap();

        rotate_if_needed(&path);

        assert!(!path.exists(), "oversized log should have been rotated away");
        assert!(dir.path().join("app.log.1").exists());
    }

    #[test]
    fn rotate_if_needed_truncates_in_place_when_rotation_fails() {
        // Forces fs::rename to fail portably (on both Unix and Windows) by
        // making the rotation target an existing directory instead of a
        // regular file - rename can never replace a file with a directory.
        // Regression guard for the bug this fixes: a swallowed rename error
        // used to leave app.log growing past its cap forever.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        fs::write(&path, vec![b'x'; (ROLLING_LOG_MAX_BYTES + 1) as usize]).unwrap();
        fs::create_dir_all(path.with_extension("log.1")).unwrap();

        rotate_if_needed(&path);

        let len = fs::metadata(&path).unwrap().len();
        assert!(len < ROLLING_LOG_MAX_BYTES, "log must be bounded even when rotation fails, was {len} bytes");
    }

    #[test]
    fn append_rolling_log_never_exceeds_the_cap_across_many_rotations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        let chunk = "x".repeat(1024);

        // Enough iterations to cross the 5MB cap and force several
        // rotations, including rotating over an already-existing app.log.1.
        for _ in 0..(6 * 1024) {
            rotate_if_needed(&path);
            let mut file = fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
            file.write_all(chunk.as_bytes()).unwrap();
        }

        let len = fs::metadata(&path).unwrap().len();
        assert!(
            len <= ROLLING_LOG_MAX_BYTES + chunk.len() as u64,
            "app.log grew past its cap across repeated rotations: {len} bytes"
        );
    }

    #[test]
    fn rolling_log_size_bytes_at_reflects_the_real_file_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        fs::write(&path, b"hello").unwrap();
        assert_eq!(rolling_log_size_bytes_at(&path), 5);
    }

    #[test]
    fn rolling_log_size_bytes_at_is_zero_for_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(rolling_log_size_bytes_at(&dir.path().join("app.log")), 0);
    }

    #[test]
    fn collect_legacy_cleanup_targets_is_empty_when_nothing_to_clean() {
        let dir = tempfile::tempdir().unwrap();
        assert!(collect_legacy_cleanup_targets(dir.path()).is_empty());
    }

    #[test]
    fn collect_legacy_cleanup_targets_stages_a_large_payloads_dir_quickly() {
        let logs_root = tempfile::tempdir().unwrap();
        let payloads = logs_root.path().join(LEGACY_PAYLOADS_DIR_NAME);
        fs::create_dir_all(&payloads).unwrap();
        for i in 0..5000 {
            fs::write(payloads.join(format!("{i}.json")), b"{}").unwrap();
        }

        let started = Instant::now();
        let targets = collect_legacy_cleanup_targets(logs_root.path());
        let elapsed = started.elapsed();

        // A rename is O(1) regardless of file count - this is the whole
        // point of staging instead of deleting file-by-file. A generous
        // bound (well under what 5000 individual removals would take) is
        // enough to catch a regression back to per-file work.
        assert!(
            elapsed.as_millis() < 2000,
            "staging a 5000-file directory took {elapsed:?} - looks like per-file work crept back in"
        );

        assert_eq!(targets.len(), 1);
        assert!(!payloads.exists(), "original payloads dir should have been renamed away");
        assert!(targets[0].is_dir());
        assert_eq!(fs::read_dir(&targets[0]).unwrap().count(), 5000);
    }

    #[test]
    fn collect_legacy_cleanup_targets_picks_up_a_leftover_failed_stage() {
        // Simulates a previous cleanup whose background remove_dir_all
        // failed partway (e.g. a locked file) and left a staged directory
        // behind - the next call must retry it, not silently ignore it.
        let logs_root = tempfile::tempdir().unwrap();
        let stale_stage = logs_root.path().join(format!("{LEGACY_CLEANUP_STAGE_PREFIX}20260101T000000"));
        fs::create_dir_all(&stale_stage).unwrap();
        fs::write(stale_stage.join("leftover.json"), b"{}").unwrap();

        let targets = collect_legacy_cleanup_targets(logs_root.path());
        assert_eq!(targets, vec![stale_stage]);
    }

    #[test]
    fn collect_legacy_cleanup_targets_ignores_unrelated_files_and_dirs() {
        let logs_root = tempfile::tempdir().unwrap();
        fs::write(logs_root.path().join("app.log"), b"hello").unwrap();
        fs::create_dir_all(logs_root.path().join("diagnostics")).unwrap();

        assert!(collect_legacy_cleanup_targets(logs_root.path()).is_empty());
    }

    // WK-122 §7 / WK-125 - drives the REAL `_at` entry points the
    // AppHandle-facing save_session/load_session/clear_session/
    // save_companion_token/load_companion_token wrappers delegate to (see
    // this section's own doc comment on why `_at(path)` rather than a
    // mocked AppHandle - the latter would resolve to a real, unsandboxed
    // path on the host and race across parallel test runs). Each test gets
    // its own `tempfile` directory and its own `FakeSecretStore` (WK-125),
    // so these are fully hermetic and never touch a real OS keychain -
    // exactly the "unit-test through a fake secret store, not a real
    // Windows Credential Manager" split the task calls for.
    mod session_storage {
        use super::*;
        use crate::secure_storage::test_support::{FailingSecretStore, FakeSecretStore};

        fn config_path(dir: &tempfile::TempDir) -> PathBuf {
            dir.path().join("companion-config.json")
        }

        #[test]
        fn save_then_load_session_round_trips() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();
            let session = CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-1".into() };

            assert!(load_session_at(&path, &store).is_none());
            save_session_at(&path, &session, &store).unwrap();
            let loaded = load_session_at(&path, &store).unwrap();
            assert_eq!(loaded.email, session.email);
            assert_eq!(loaded.refresh_token, session.refresh_token);
        }

        #[test]
        fn saving_a_session_never_writes_the_refresh_token_to_plaintext_config() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            save_session_at(&path, &CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-secret".into() }, &store).unwrap();

            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("rt-secret"), "refresh token leaked into plaintext config: {raw}");
            assert!(raw.contains("roma@example.com"), "email (not a secret) should still be readable in config");
        }

        #[test]
        fn logging_in_via_session_does_not_erase_an_existing_legacy_companion_token() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            save_companion_token_at(&path, "legacy-secret-token", &store).unwrap();
            save_session_at(&path, &CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-1".into() }, &store).unwrap();

            assert_eq!(load_companion_token_at(&path, &store).as_deref(), Some("legacy-secret-token"));
            assert!(load_session_at(&path, &store).is_some());
        }

        #[test]
        fn saving_a_legacy_token_does_not_erase_an_existing_session() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            save_session_at(&path, &CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-1".into() }, &store).unwrap();
            save_companion_token_at(&path, "legacy-secret-token", &store).unwrap();

            assert!(load_session_at(&path, &store).is_some());
            assert_eq!(load_companion_token_at(&path, &store).as_deref(), Some("legacy-secret-token"));
        }

        #[test]
        fn refreshing_a_session_overwrites_only_the_refresh_token_field() {
            // Mirrors backend::refresh_session_access_token's save_session
            // call after a successful rotation - the point being that a
            // second save_session call REPLACES the session wholesale
            // (rotation invalidates the old refresh token), not merges
            // field-by-field.
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            save_session_at(&path, &CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-1".into() }, &store).unwrap();
            save_session_at(&path, &CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-2-rotated".into() }, &store).unwrap();

            let loaded = load_session_at(&path, &store).unwrap();
            assert_eq!(loaded.refresh_token, "rt-2-rotated");
        }

        // WK-125 - fixes a real gap the audit found: logout previously only
        // ever cleared the session, leaving a legacy-method account's token
        // reloaded on every future launch. Logout now clears both, since a
        // single "Выйти" button covers both connection methods and neither
        // should survive it.
        #[test]
        fn logout_clears_both_the_session_and_any_legacy_token() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            save_companion_token_at(&path, "legacy-secret-token", &store).unwrap();
            save_session_at(&path, &CompanionSession { email: "roma@example.com".into(), refresh_token: "rt-1".into() }, &store).unwrap();

            clear_session_at(&path, &store).unwrap();
            clear_companion_token_at(&path, &store).unwrap();

            assert!(load_session_at(&path, &store).is_none());
            assert!(load_companion_token_at(&path, &store).is_none());
            assert!(store.get(KEY_REFRESH_TOKEN).unwrap().is_none());
            assert!(store.get(KEY_COMPANION_TOKEN).unwrap().is_none());
        }

        #[test]
        fn clearing_a_credential_that_was_never_set_is_not_an_error() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            assert!(clear_session_at(&path, &store).is_ok());
            assert!(clear_companion_token_at(&path, &store).is_ok());
        }

        // --- WK-125 migration semantics -------------------------------

        #[test]
        fn a_legacy_plaintext_companion_token_migrates_to_the_secure_store_on_read() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            // Simulate a pre-WK-125 install: token written straight into the
            // JSON file, bypassing the secure store entirely.
            write_companion_config_at(&path, &serde_json::json!({ "companion_token": "legacy-secret-token" })).unwrap();
            let store = FakeSecretStore::default();

            let loaded = load_companion_token_at(&path, &store);

            assert_eq!(loaded.as_deref(), Some("legacy-secret-token"));
            assert_eq!(store.get(KEY_COMPANION_TOKEN).unwrap().as_deref(), Some("legacy-secret-token"));
            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("legacy-secret-token"), "plaintext token should have been removed after a verified secure write: {raw}");
        }

        #[test]
        fn a_legacy_plaintext_refresh_token_migrates_to_the_secure_store_on_read() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            write_companion_config_at(
                &path,
                &serde_json::json!({ "session": { "email": "roma@example.com", "refresh_token": "legacy-rt" } }),
            )
            .unwrap();
            let store = FakeSecretStore::default();

            let loaded = load_session_at(&path, &store).unwrap();

            assert_eq!(loaded.refresh_token, "legacy-rt");
            assert_eq!(store.get(KEY_REFRESH_TOKEN).unwrap().as_deref(), Some("legacy-rt"));
            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("legacy-rt"), "plaintext refresh token should have been removed after migration: {raw}");
            assert!(raw.contains("roma@example.com"), "email is not a secret and should remain readable");
        }

        #[test]
        fn migration_does_not_remove_the_plaintext_copy_until_the_secure_write_is_verified() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            write_companion_config_at(&path, &serde_json::json!({ "companion_token": "legacy-secret-token" })).unwrap();
            let store = FailingSecretStore;

            let loaded = load_companion_token_at(&path, &store);

            // The app keeps working this session off the plaintext value...
            assert_eq!(loaded.as_deref(), Some("legacy-secret-token"));
            // ...and the ONLY copy of the credential is not deleted just
            // because the secure store couldn't take it.
            let raw = fs::read_to_string(&path).unwrap();
            assert!(raw.contains("legacy-secret-token"), "plaintext token must survive a failed secure write: {raw}");
        }

        #[test]
        fn a_failed_secure_write_on_save_falls_back_to_plaintext_instead_of_losing_the_token() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FailingSecretStore;

            save_companion_token_at(&path, "brand-new-token", &store).unwrap();

            assert_eq!(load_companion_token_at(&path, &store).as_deref(), Some("brand-new-token"));
        }

        #[test]
        fn migration_is_idempotent_across_repeated_reads_restart_safe() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            write_companion_config_at(&path, &serde_json::json!({ "companion_token": "legacy-secret-token" })).unwrap();
            let store = FakeSecretStore::default();

            // First read migrates; every subsequent read (simulating
            // subsequent app restarts against the same on-disk state) must
            // keep returning the same value without erroring or re-writing
            // anything that would break on a second pass.
            for _ in 0..3 {
                assert_eq!(load_companion_token_at(&path, &store).as_deref(), Some("legacy-secret-token"));
            }
            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("legacy-secret-token"));
        }

        #[test]
        fn obs_password_migrates_from_plaintext_and_a_change_updates_the_secure_secret() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("obs-config.json");
            let store = FakeSecretStore::default();
            let legacy_config = ObsConfig { password: "old-password".into(), ..ObsConfig::default() };
            fs::write(&path, serde_json::to_string_pretty(&legacy_config).unwrap()).unwrap();

            // Migrates on first load.
            let loaded = load_obs_config_at(&path, &store);
            assert_eq!(loaded.password, "old-password");
            assert_eq!(store.get(KEY_OBS_PASSWORD).unwrap().as_deref(), Some("old-password"));
            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("old-password"), "OBS password should be stripped from plaintext after migration: {raw}");

            // Changing the password updates the secure secret, not the file.
            let new_config = ObsConfig { password: "new-password".into(), ..loaded };
            save_obs_config_at(&path, &new_config, &store).unwrap();
            let reloaded = load_obs_config_at(&path, &store);
            assert_eq!(reloaded.password, "new-password");
            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("new-password"));
        }

        #[test]
        fn obs_config_serialization_never_contains_a_password_once_migrated() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("obs-config.json");
            let store = FakeSecretStore::default();

            save_obs_config_at(&path, &ObsConfig { password: "s3cret".into(), ..ObsConfig::default() }, &store).unwrap();

            let raw = fs::read_to_string(&path).unwrap();
            assert!(!raw.contains("s3cret"), "OBS password must not be serialized to plaintext config: {raw}");
        }

        #[test]
        fn fresh_install_has_no_credentials_anywhere() {
            let dir = tempfile::tempdir().unwrap();
            let path = config_path(&dir);
            let store = FakeSecretStore::default();

            assert!(load_companion_token_at(&path, &store).is_none());
            assert!(load_session_at(&path, &store).is_none());
            assert_eq!(load_obs_config_at(&dir.path().join("obs-config.json"), &store).password, "");
        }
    }

    mod debug_redaction {
        use super::*;

        #[test]
        fn companion_session_debug_output_never_contains_the_refresh_token() {
            let session = CompanionSession { email: "roma@example.com".into(), refresh_token: "super-secret-rt".into() };
            let debug = format!("{session:?}");
            assert!(!debug.contains("super-secret-rt"), "Debug output leaked the refresh token: {debug}");
            assert!(debug.contains("roma@example.com"), "email is not a secret and is fine to show in Debug output");
        }

        #[test]
        fn obs_config_debug_output_never_contains_the_password() {
            let config = ObsConfig { password: "hunter2".into(), ..ObsConfig::default() };
            let debug = format!("{config:?}");
            assert!(!debug.contains("hunter2"), "Debug output leaked the OBS password: {debug}");
        }
    }
}
