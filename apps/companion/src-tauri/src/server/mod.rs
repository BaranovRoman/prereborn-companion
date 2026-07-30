use tauri::{AppHandle, Emitter, Manager};

use crate::diagnostics;
use crate::state::{AppState, LastEvent, GSI_PORT};
use crate::storage;

/// Binds the GSI listener synchronously (so callers learn immediately if the
/// port is taken) then hands the accept loop off to a background thread.
pub fn start(app: AppHandle) -> Result<(), String> {
    let addr = format!("127.0.0.1:{GSI_PORT}");
    let server = tiny_http::Server::http(&addr).map_err(|e| format!("Could not bind {addr}: {e}"))?;

    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.server_running = true;
    }
    storage::append_rolling_log(&app, &format!("GSI server listening on http://{addr}"));

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_request(&app_for_thread, request);
        }
    });

    Ok(())
}

fn handle_request(app: &AppHandle, mut request: tiny_http::Request) {
    let remote_addr = request
        .remote_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|h| (h.field.to_string(), h.value.as_str().to_string()))
        .collect();

    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);

    // Nothing is filtered here — every payload Dota sends is persisted as-is,
    // whether or not it parses as JSON, per the "capture everything" brief.
    match storage::write_payload_file(app, &remote_addr, &headers, &body) {
        Ok(result) => {
            // Passive diagnostic-mode observer - see diagnostics/mod.rs. A
            // no-op (one mutex lock, one None check) unless a diagnostics
            // session has been explicitly started; never affects the
            // existing behavior below.
            diagnostics::observe(app, result.parsed.as_ref(), body.len());

            let last_event = LastEvent {
                timestamp: chrono::Local::now().to_rfc3339(),
                remote_addr: remote_addr.clone(),
                summary: result.summary.clone(),
                payload_file: result.file_path.to_string_lossy().to_string(),
            };

            {
                let state = app.state::<AppState>();
                let mut inner = state.0.lock().unwrap();
                inner.request_count += 1;
                inner.last_event = Some(last_event.clone());
                // Only valid-JSON payloads feed the backend-forwarding queue -
                // the backend expects a parsed object, so malformed bodies
                // (still captured on disk above) simply aren't forwarded.
                if let Some(parsed) = result.parsed {
                    inner.last_gsi_payload = Some(parsed);
                    inner.dirty = true;
                    inner.payload_version = inner.payload_version.wrapping_add(1);
                }
            }

            storage::append_rolling_log(
                app,
                &format!("GSI request from {remote_addr}: {}", result.summary),
            );
            let _ = app.emit("gsi-event", &last_event);
        }
        Err(e) => {
            storage::append_rolling_log(
                app,
                &format!("Failed to persist GSI payload from {remote_addr}: {e}"),
            );
        }
    }

    let response = tiny_http::Response::from_string("{\"status\":\"ok\"}").with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    );
    let _ = request.respond(response);
}
