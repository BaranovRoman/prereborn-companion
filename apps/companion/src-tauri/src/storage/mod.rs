use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use chrono::Local;
use tauri::{AppHandle, Manager};
use crate::obs::ObsConfig;

static REQUEST_SEQ: AtomicU32 = AtomicU32::new(0);

const ROLLING_LOG_NAME: &str = "app.log";
const ROLLING_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn logs_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("logs")
}

pub fn payloads_dir(app: &AppHandle) -> PathBuf {
    logs_root(app).join("payloads")
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
    fs::create_dir_all(payloads_dir(app))?;
    Ok(())
}

fn rolling_log_path(app: &AppHandle) -> PathBuf {
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

pub fn append_rolling_log(app: &AppHandle, line: &str) {
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

    let dir = payloads_dir(app);
    if dir.exists() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let _ = fs::remove_file(entry.path());
        }
    }
    append_rolling_log(app, "Logs cleared by user.");
    Ok(())
}

pub struct PayloadWriteResult {
    pub file_path: PathBuf,
    pub summary: String,
    // Some(...) only when raw_body parsed as JSON - used by server/mod.rs to
    // feed the backend-forwarding queue (backend/mod.rs). Non-JSON bodies are
    // still captured on disk above, just never forwarded to the backend.
    pub parsed: Option<serde_json::Value>,
}

/// Persists one incoming GSI request as its own file: timestamp, remote address,
/// raw headers, raw JSON body, and (when parseable) a pretty-printed copy —
/// nothing is filtered out, per the "capture everything" requirement.
pub fn write_payload_file(
    app: &AppHandle,
    remote_addr: &str,
    headers: &[(String, String)],
    raw_body: &str,
) -> std::io::Result<PayloadWriteResult> {
    let now = Local::now();
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::SeqCst);
    let file_stamp = now.format("%Y-%m-%dT%H-%M-%S%.3f");
    let file_name = format!("{file_stamp}_{seq:06}.json");
    let file_path = payloads_dir(app).join(&file_name);

    let parsed: Option<serde_json::Value> = serde_json::from_str(raw_body).ok();
    let pretty = parsed
        .as_ref()
        .map(|v| serde_json::to_string_pretty(v).unwrap_or_default());

    let record = serde_json::json!({
        "timestamp": now.to_rfc3339(),
        "remote_addr": remote_addr,
        "headers": headers,
        "raw_body": raw_body,
        "pretty_json": pretty,
        "parsed_ok": parsed.is_some(),
    });

    fs::write(&file_path, serde_json::to_string_pretty(&record)?)?;

    let summary = summarize_payload(parsed.as_ref(), raw_body);

    Ok(PayloadWriteResult { file_path, summary, parsed })
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
