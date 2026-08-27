use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::diagnostics;
use crate::game_sounds;
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

/// Handles one GSI request's body once it's already been read off the wire -
/// separated from `handle_request` so it's testable without a real
/// `tiny_http::Request` (which has no public constructor). Nothing is
/// filtered here - every payload Dota sends is processed, whether or not it
/// parses as JSON - but unlike before, none of it is written to disk on this
/// path; that only happens inside an explicitly started diagnostics session
/// (see `diagnostics::observe`).
fn process_gsi_body(app: &AppHandle, remote_addr: &str, body: &str) -> LastEvent {
    let result = storage::parse_payload(body);

    // Passive diagnostic-mode observer - see diagnostics/mod.rs. A no-op
    // (one mutex lock, one None check) unless a diagnostics session has been
    // explicitly started; never affects the behavior below.
    diagnostics::observe(app, result.parsed.as_ref(), body.len());

    let last_event = LastEvent {
        timestamp: chrono::Local::now().to_rfc3339(),
        remote_addr: remote_addr.to_string(),
        summary: result.summary.clone(),
    };
    if let Some(parsed) = result.parsed.as_ref() {
        obs::handle_gsi(app, parsed);
        game_sounds::handle_gsi(app, parsed);
    }

    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.request_count += 1;
        inner.gsi_last_received_at = Some(Instant::now());
        inner.last_event = Some(last_event.clone());
        // Only valid-JSON payloads feed the backend-forwarding queue - the
        // backend expects a parsed object, so malformed bodies simply
        // aren't forwarded.
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

    last_event
}

// WK-109 forensic finding - Valve's `throttle` GSI setting counts from the
// moment Dota's client receives OUR 2XX response, not from when it sent the
// request (see the GSI cfg semantics documented at gsi/config.rs). Before
// this fix, `process_gsi_body` (JSON parse, obs/game_sounds detection, a
// mutex lock, and 1-3 synchronous rolling-log file open+write+close calls)
// ran ENTIRELY before `request.respond()` - so any slowness in our own
// processing (a slow disk, antivirus/OneDrive intercepting the log file's
// open/write/close, or just accumulated small overheads) added directly on
// top of the configured `throttle "0.1"`, inflating Dota's actual next-send
// delay far past what the cfg requests. Production evidence: a suspiciously
// uniform ~1.14-1.17s gap between consecutive "GSI request from ..." log
// lines despite buffer/throttle both configured to 0.1 - too tight and too
// regular to be explained by player action cadence. Responding to Dota
// FIRST, before any of our own processing, removes Companion's own
// processing time from Dota's throttle-gated next-send delay entirely -
// whatever our processing costs, it can no longer be added on top of
// what Dota itself decides to wait.
fn handle_request(app: &AppHandle, mut request: tiny_http::Request) {
    let remote_addr = request
        .remote_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);

    let response = tiny_http::Response::from_string("{\"status\":\"ok\"}").with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    );
    let _ = request.respond(response);

    process_gsi_body(app, &remote_addr, &body);
}
