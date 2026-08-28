use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Local;
use tauri::{AppHandle, Manager, Runtime};
use crate::obs::ObsConfig;

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

// Companion token - лежит локально в открытом виде (как любой API-ключ CLI-
// инструмента, например ~/.aws/credentials) - это единственный секрет,
// который companion предъявляет backend'у, храниться он обязан где-то на
// диске, иначе токен пришлось бы вставлять заново при каждом запуске.
// Никогда не пишется в rolling log/файлы payload'ов (см. commands.rs).
pub fn save_companion_token(app: &AppHandle, token: &str) -> std::io::Result<()> {
    let path = companion_config_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let contents = serde_json::json!({ "companion_token": token });
    fs::write(path, serde_json::to_string_pretty(&contents)?)
}

pub fn load_companion_token(app: &AppHandle) -> Option<String> {
    let path = companion_config_path(app);
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("companion_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn obs_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("obs-config.json")
}

pub fn save_obs_config(app: &AppHandle, config: &ObsConfig) -> std::io::Result<()> {
    let path = obs_config_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(config)?)
}

pub fn load_obs_config(app: &AppHandle) -> ObsConfig {
    fs::read_to_string(obs_config_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn init(app: &AppHandle) -> std::io::Result<()> {
    fs::create_dir_all(logs_root(app))?;
    Ok(())
}

fn rolling_log_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    logs_root(app).join(ROLLING_LOG_NAME)
}

fn rotate_if_needed(path: &PathBuf) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > ROLLING_LOG_MAX_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::rename(path, rotated);
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
}
