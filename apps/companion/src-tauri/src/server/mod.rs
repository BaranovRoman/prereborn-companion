use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::diagnostics;
use crate::obs;
use crate::state::{AppState, LastEvent, GSI_PORT};
use crate::storage;

/// Supervises the local GSI listener for the lifetime of the app. A temporary
/// bind/listener failure is visible in state and retried with capped backoff.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{GSI_PORT}");
        let mut attempt = 0_u32;
        loop {
            match tiny_http::Server::http(&addr) {
                Ok(server) => {
                    attempt = 0;
                    {
                        let state = app.state::<AppState>();
                        let mut inner = state.0.lock().unwrap();
                        inner.server_running = true;
                        inner.gsi_last_error = None;
                    }
                    storage::append_rolling_log(
                        &app,
                        &format!("GSI server listening on http://{addr}"),
                    );
                    let _ = app.emit("gsi-status", app.state::<AppState>().snapshot());
                    for request in server.incoming_requests() {
                        handle_request(&app, request);
                    }
                    let state = app.state::<AppState>();
                    let mut inner = state.0.lock().unwrap();
                    inner.server_running = false;
                    inner.gsi_last_error = Some("GSI listener stopped; reconnecting".into());
                }
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    let message = format!("Could not bind {addr}: {error}");
                    let state = app.state::<AppState>();
                    let mut inner = state.0.lock().unwrap();
                    inner.server_running = false;
                    inner.gsi_last_error = Some(message.clone());
                    drop(inner);
                    storage::append_rolling_log(&app, &format!("{message}; retry scheduled."));
                    let _ = app.emit("gsi-status", app.state::<AppState>().snapshot());
                }
            }
            let delay = retry_delay(attempt);
            std::thread::sleep(delay);
        }
    });
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(2_u64.saturating_pow(attempt.min(4)).min(30))
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
            if let Some(parsed) = result.parsed.as_ref() {
                obs::handle_gsi(app, parsed);
            }

            {
                let state = app.state::<AppState>();
                let mut inner = state.0.lock().unwrap();
                inner.request_count += 1;
                inner.gsi_last_received_at = Some(Instant::now());
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
