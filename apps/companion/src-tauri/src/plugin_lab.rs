//! Debug-only entry point, not a settings page or installed-plugin registry.
use std::path::{Path, PathBuf};
use serde_json::Value;
use tauri::{Manager, State};
use crate::core::plugin_runtime::{PluginHost, Snapshot};

pub struct LabConfig { executable: PathBuf, ui: PathBuf, dota: bool }
pub fn enabled() -> bool {
    lab_enabled(cfg!(debug_assertions), &std::env::args().collect::<Vec<_>>())
}
fn lab_enabled(debug: bool, args: &[String]) -> bool {
    debug && args.iter().any(|arg| matches!(arg.as_str(), "--plugin-lab" | "--dota-replay-lab"))
}
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dota = std::env::args().any(|a| a == "--dota-replay-lab");
    let executable = PathBuf::from(std::env::var(if dota { "PREREBORN_DOTA_BIN" } else { "PREREBORN_HELLO_BIN" })?).canonicalize()?;
    let ui = PathBuf::from(std::env::var(if dota { "PREREBORN_DOTA_UI" } else { "PREREBORN_HELLO_UI" })?).canonicalize()?;
    if !executable.is_file() || !ui.join("index.html").is_file() { return Err("Build selected plugin binary/UI first".into()); }
    if dota {
        let path=app.path().app_data_dir()?.join("plugins/infrastructure/dota-control.sqlite3");
        app.manage(std::sync::Mutex::new(crate::core::plugin_durable::DurableStore::open(&path)?));
    }
    app.manage(LabConfig { executable, ui, dota });
    app.manage(PluginHost::new());
    let window = app.get_webview_window("main").ok_or("Missing main window")?;
    let mut url = window.url()?;
    url.set_path(if dota { "/dota-replay-lab.html" } else { "/plugin-lab.html" });
    window.set_title("Prereborn Plugin Lab (debug)")?;
    window.navigate(url)?;
    Ok(())
}

fn allowed(dota: bool, name: &str) -> bool {
    if dota { matches!(name, "dota.replay" | "dota.reset" | "dota.core_read") } else { matches!(name, "greet" | "crash") }
}

fn active(app: &tauri::AppHandle) -> Result<(), String> {
    if !enabled() || app.try_state::<LabConfig>().is_none() { return Err("plugin_lab_disabled".into()); }
    Ok(())
}
#[tauri::command]
pub async fn plugin_lab_start(app: tauri::AppHandle) -> Result<Snapshot, String> {
    active(&app)?;
    let config = app.state::<LabConfig>();
    let executable = config.executable.clone();
    let id = if config.dota { "dota2" } else { "hello" };
    let host = app.state::<PluginHost>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let mut runtime = host.0.lock().map_err(|_| "plugin_lock_poisoned")?;
        if id == "dota2" { runtime.start_expected(&executable, &[], id, Some("0.1.0")) } else { runtime.start(&executable, &[]) } })
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugin_lab_stop(app: tauri::AppHandle) -> Result<Snapshot, String> {
    active(&app)?;
    let host = app.state::<PluginHost>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.0.lock().map_err(|_| "plugin_lock_poisoned")?.stop())
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugin_lab_command(app: tauri::AppHandle, name: String, args: Value) -> Result<Value, String> {
    active(&app)?;
    if !allowed(app.state::<LabConfig>().dota, &name) { return Err("command_not_allowed".into()); }
    if name == "dota.replay" {
        serde_json::from_value::<companion_dota_domain::contracts::ReplayInput>(args.clone()).map_err(|_| "invalid_replay_input")?;
    }
    let host = app.state::<PluginHost>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime=host.0.lock().map_err(|_| "plugin_lock_poisoned")?;
        if name=="dota.core_read" {
            runtime.command_with_reader(name,args,|query| {
                let query=serde_json::from_value(query).map_err(|_|"invalid_read_request")?;
                let response=crate::core::plugin_read::read(&app.state::<crate::state::AppState>(),&app.state::<crate::local_runtime::LocalRuntimeState>(),companion_dota_domain::core_read::DOTA_READ_GRANTS,query);
                serde_json::to_value(response).map_err(|_|"invalid_read_response".into())
            })
        } else {runtime.command(name,args)}
    })
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugin_lab_status(app: tauri::AppHandle) -> Result<Snapshot, String> {
    active(&app)?;
    let host = app.state::<PluginHost>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.0.lock().map_err(|_| "plugin_lock_poisoned".to_string()).map(|mut runtime| runtime.snapshot()))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn plugin_lab_ui_result(app: tauri::AppHandle, result: String) -> Result<(), String> {
    active(&app)?;
    // Bounded visible evidence for the real WebView smoke (stdout only, no app-data writes).
    println!("PLUGIN_UI_RESULT {}", result.chars().take(1024).collect::<String>());
    Ok(())
}

pub fn asset(root: &Path, uri_path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let relative = uri_path.trim_start_matches('/');
    if relative.is_empty() || relative.contains('%') || relative.contains('\\') ||
        Path::new(relative).components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("invalid_asset_path".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) || !path.is_file() { return Err("asset_outside_plugin".into()); }
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8", Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8", _ => return Err("unsupported_asset".into()),
    };
    if path.metadata().map_err(|e| e.to_string())?.len() > 1024 * 1024 { return Err("asset_too_large".into()); }
    Ok((std::fs::read(path).map_err(|e| e.to_string())?, mime))
}
pub fn response(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let result = if enabled() {
        app.try_state::<LabConfig>().ok_or("disabled".to_string()).and_then(|config: State<LabConfig>| asset(&config.ui, path))
    } else {
        app.try_state::<crate::core::plugin_manager::PluginManager>()
            .ok_or("disabled".to_string()).and_then(|manager| manager.asset(path))
    };
    match result {
        Ok((bytes, mime)) => tauri::http::Response::builder().header("Content-Type", mime)
            // sandbox="allow-scripts" makes the iframe's origin opaque. Module
            // scripts use CORS even for this local custom scheme; these assets
            // are public UI only, never credentials or arbitrary filesystem data.
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff")
            // 'self' fails against the sandbox's opaque origin in WKWebView.
            // Permit only assets from our bounded local protocol, not inline/eval/HTTP.
            .header("Content-Security-Policy", "default-src 'none'; script-src plugin-ui: http://plugin-ui.localhost; style-src plugin-ui: http://plugin-ui.localhost; img-src plugin-ui: http://plugin-ui.localhost https://cdn.cloudflare.steamstatic.com; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
            .body(bytes).unwrap(),
        Err(_) => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_never_enables_replay_lab() {
        let args = vec!["--dota-replay-lab".to_string()];
        assert!(!lab_enabled(false, &args)); assert!(lab_enabled(true, &args));
        assert!(!lab_enabled(true, &[]));
    }
    #[test]
    fn replay_commands_are_isolated() {
        assert!(allowed(true, "dota.replay")); assert!(allowed(true, "dota.reset"));
        for name in ["crash", "greet", "obs.switch", "sql", "http"] { assert!(!allowed(true, name)); }
        assert!(!allowed(false, "dota.replay"));
        assert!(allowed(true,"dota.core_read")); assert!(!allowed(false,"dota.core_read"));
    }
    #[test]
    fn only_plugin_assets_are_served() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "Hello").unwrap();
        assert_eq!(asset(dir.path(), "/index.html").unwrap().0, b"Hello");
        for path in ["/../secret.html", "/%2e%2e/secret.html", "/a\\b.html", "/missing.html"] { assert!(asset(dir.path(), path).is_err()); }
        #[cfg(unix)] {
            std::os::unix::fs::symlink("/etc/hosts", dir.path().join("escape.html")).unwrap();
            assert!(asset(dir.path(), "/escape.html").is_err());
        }
    }
}
