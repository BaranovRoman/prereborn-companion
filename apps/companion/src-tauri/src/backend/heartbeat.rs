//! WK-186 - usage-stats heartbeat (docs/analytics/companion-usage-stats.md).
//!
//! One background thread for the app's whole lifetime, started once from
//! `backend::init` - same shape as the session refresher, so a re-login or a
//! reconnect never spawns a second loop. While an account credential is
//! present it sends one empty, authenticated POST right away and then every
//! `HEARTBEAT_INTERVAL`. A failed send is simply dropped: there is no queue
//! and no retry storm, the next attempt is the next scheduled one. The body
//! is empty - the server records only the account id from the token.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};
use crate::state::{AppState, DEFAULT_BACKEND_URL};
use crate::storage;

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15 * 60);
/// How often the loop wakes to notice a login/logout between heartbeats.
const POLL_INTERVAL: Duration = Duration::from_secs(30);
/// A fresh login sends right away, but never more often than this, so a
/// login/logout loop can't turn into a request loop.
const MIN_GAP_ON_LOGIN: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

static STARTED: AtomicBool = AtomicBool::new(false);
static STOP: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

#[derive(Default)]
pub(crate) struct Schedule {
    last_attempt: Option<Instant>,
    had_token: bool,
}

impl Schedule {
    /// Whether a heartbeat should be sent now. Every `true` must be followed
    /// by `mark_attempt`, whatever the outcome of the send.
    pub(crate) fn is_due(&mut self, now: Instant, has_token: bool) -> bool {
        let logged_in = has_token && !self.had_token;
        self.had_token = has_token;
        if !has_token {
            return false;
        }
        match self.last_attempt {
            None => true,
            Some(last) => {
                let elapsed = now.saturating_duration_since(last);
                elapsed >= HEARTBEAT_INTERVAL || (logged_in && elapsed >= MIN_GAP_ON_LOGIN)
            }
        }
    }

    pub(crate) fn mark_attempt(&mut self, now: Instant) {
        self.last_attempt = Some(now);
    }
}

pub(crate) fn send(backend_url: &str, token: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?
        .post(format!("{backend_url}/stream/companion/heartbeat"))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_LENGTH, 0)
        .send()
        .map_err(|error| format!("request failed: {error}"))?;
    // 404 = an API that predates WK-186; nothing to do but try again later.
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status()))
    }
}

fn current_token<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = app.state::<AppState>();
    let inner = state.0.lock().ok()?;
    inner.core.companion_token.clone()
}

/// Sleeps up to `timeout`; returns true as soon as `stop` was requested.
fn wait_for_stop(timeout: Duration) -> bool {
    let (lock, signal) = &STOP;
    let Ok(stopped) = lock.lock() else { return true };
    match signal.wait_timeout_while(stopped, timeout, |stopped| !*stopped) {
        Ok((stopped, _)) => *stopped,
        Err(_) => true,
    }
}

pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut schedule = Schedule::default();
        let mut failing = false;
        loop {
            let token = current_token(&app);
            let now = Instant::now();
            if schedule.is_due(now, token.is_some()) {
                schedule.mark_attempt(now);
                if let Some(token) = token {
                    match send(DEFAULT_BACKEND_URL, &token) {
                        Ok(()) if failing => {
                            failing = false;
                            storage::append_rolling_log(&app, "Usage heartbeat: recovered.");
                        }
                        Ok(()) => {}
                        // Logged once per failure streak, not every attempt.
                        Err(error) if !failing => {
                            failing = true;
                            storage::append_rolling_log(&app, &format!("Usage heartbeat: failed ({error}); next try in 15 min."));
                        }
                        Err(_) => {}
                    }
                }
            }
            if wait_for_stop(POLL_INTERVAL) {
                break;
            }
        }
    });
}

/// Called on app exit: wakes the loop and makes it return.
pub fn stop() {
    let (lock, signal) = &STOP;
    if let Ok(mut stopped) = lock.lock() {
        *stopped = true;
        signal.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn nothing_is_due_without_an_account() {
        let mut schedule = Schedule::default();
        assert!(!schedule.is_due(Instant::now(), false));
    }

    #[test]
    fn first_heartbeat_is_sent_as_soon_as_a_token_exists_then_every_interval() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        assert!(!schedule.is_due(start, false));
        assert!(schedule.is_due(start, true));
        schedule.mark_attempt(start);
        assert!(!schedule.is_due(start + POLL_INTERVAL, true));
        assert!(!schedule.is_due(start + HEARTBEAT_INTERVAL - Duration::from_secs(1), true));
        assert!(schedule.is_due(start + HEARTBEAT_INTERVAL, true));
    }

    #[test]
    fn a_failed_send_waits_for_the_next_interval_instead_of_retrying() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        assert!(schedule.is_due(start, true));
        schedule.mark_attempt(start); // the send failed - no special path
        for tick in 1..30 {
            assert!(!schedule.is_due(start + POLL_INTERVAL * tick, true));
        }
    }

    #[test]
    fn relogin_sends_promptly_but_never_more_than_once_per_min_gap() {
        let start = Instant::now();
        let mut schedule = Schedule::default();
        assert!(schedule.is_due(start, true));
        schedule.mark_attempt(start);
        // Logout + immediate login: too soon.
        assert!(!schedule.is_due(start + Duration::from_secs(10), false));
        assert!(!schedule.is_due(start + Duration::from_secs(20), true));
        // Logout + login after the gap: sent right away.
        assert!(!schedule.is_due(start + Duration::from_secs(100), false));
        assert!(schedule.is_due(start + Duration::from_secs(130), true));
    }

    #[test]
    fn stop_wakes_the_loop_immediately() {
        stop();
        let began = Instant::now();
        assert!(wait_for_stop(Duration::from_secs(60)));
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn unreachable_backend_fails_fast_without_panicking() {
        // Bind then drop to get a local port nothing listens on.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let began = Instant::now();
        let result = send(&format!("http://127.0.0.1:{port}/api"), "token");
        assert!(result.is_err());
        assert!(began.elapsed() <= REQUEST_TIMEOUT + Duration::from_secs(1));
    }

    #[test]
    fn sends_only_an_authenticated_empty_post() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 { break; }
                raw.extend_from_slice(&buf[..n]);
            }
            stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").unwrap();
            String::from_utf8(raw).unwrap()
        });

        send(&format!("http://127.0.0.1:{port}/api"), "secret-token").unwrap();
        let request = server.join().unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(request.starts_with("POST /api/stream/companion/heartbeat HTTP/1.1\r\n"));
        assert!(lower.contains("authorization: bearer secret-token\r\n"));
        assert!(lower.contains("content-length: 0\r\n"));
        assert!(request.ends_with("\r\n\r\n"), "no body expected: {request:?}");
    }

    #[test]
    fn non_success_status_is_an_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert_eq!(send(&format!("http://127.0.0.1:{port}/api"), "t"), Err("HTTP 404 Not Found".into()));
        server.join().unwrap();
    }
}
