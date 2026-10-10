//! Debug-only entry point, not a settings page or installed-plugin registry.
use std::path::{Path, PathBuf};
use serde_json::Value;
use tauri::{Manager, State};
use crate::core::plugin_runtime::{PluginHost, Snapshot};

pub struct LabConfig { executable: PathBuf, ui: PathBuf }
pub fn enabled() -> bool {
    cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--plugin-lab")
}
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let executable = PathBuf::from(std::env::var("PREREBORN_HELLO_BIN")?).canonicalize()?;
    let ui = PathBuf::from(std::env::var("PREREBORN_HELLO_UI")?).canonicalize()?;
    if !executable.is_file() || !ui.join("index.html").is_file() { return Err("Build Hello binary/UI first".into()); }
    app.manage(LabConfig { executable, ui });
    app.manage(PluginHost::new());
    let window = app.get_webview_window("main").ok_or("Missing main window")?;
    let mut url = window.url()?;
    url.set_path("/plugin-lab.html");
    window.set_title("Prereborn Plugin Lab (debug)")?;
    window.navigate(url)?;
    Ok(())
}

fn active(app: &tauri::AppHandle) -> Result<(), String> {
    if !enabled() || app.try_state::<LabConfig>().is_none() { return Err("plugin_lab_disabled".into()); }
    Ok(())
}
#[tauri::command]
pub async fn plugin_lab_start(app: tauri::AppHandle) -> Result<Snapshot, String> {
    active(&app)?;
    let executable = app.state::<LabConfig>().executable.clone();
    let host = app.state::<PluginHost>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.0.lock().map_err(|_| "plugin_lock_poisoned")?.start(&executable, &[]))
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
    if !matches!(name.as_str(), "greet" | "crash") { return Err("command_not_allowed".into()); }
    let host = app.state::<PluginHost>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.0.lock().map_err(|_| "plugin_lock_poisoned")?.command(name, args))
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
            .header("Content-Security-Policy", "default-src 'none'; script-src plugin-ui: http://plugin-ui.localhost; style-src plugin-ui: http://plugin-ui.localhost; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
            .body(bytes).unwrap(),
        Err(_) => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
