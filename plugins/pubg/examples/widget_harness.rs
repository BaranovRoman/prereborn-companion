//! Test-only driver for ui/e2e/widget.e2e.mjs: a real PUBG worker serving the
//! built OBS page, fed with backend pages over stdin (one JSON per line).
//!   stdout: {"url": ..., "sessionStartedAt": ...}, then {"ok": true, ...} per line
//!   stdin:  {"settings": {...}}  → settings.save
//!           {"matches": [...]}   → one backend reply with these matches
use companion_plugin_protocol::backend::Response;
use serde_json::{json, Value};
use std::io::BufRead;

fn main() -> Result<(), String> {
    let renderer = std::fs::read(std::env::args().nth(1).ok_or("usage: widget_harness <dist/widget/index.html>")?).map_err(|e| e.to_string())?;
    let data = tempfile::tempdir().map_err(|e| e.to_string())?;
    let (mut worker, address, started) = companion_pubg_plugin::worker::harness(data.path().to_path_buf(), renderer)?;
    println!("{}", json!({"url": format!("http://{address}/pubg/widget"), "sessionStartedAt": started}));
    for line in std::io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(settings) = input.get("settings") {
            worker.command("settings.save", json!({"settings": settings}))?;
        } else if let Some(matches) = input.get("matches") {
            worker.command("refresh", json!({}))?;
            let request = worker.backend_request()?.ok_or("no_backend_request")?;
            let body = json!({"status": "ok", "player": {"name": "ProPlayer", "platform": "steam"}, "matches": matches, "complete": true, "fetchedAt": chrono::Utc::now()});
            worker.backend_response(&request, Response { operation_key: request.operation_key.clone(), status: Some(200), body: Some(body), error: None })?;
        }
        println!("{}", json!({"ok": true, "status": worker.status()}));
    }
    worker.stop();
    Ok(())
}
