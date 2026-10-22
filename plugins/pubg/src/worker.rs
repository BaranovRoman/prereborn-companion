//! Commands of the installed PUBG executable. Paths and grants come from the
//! verified host launch, never from an iframe command or a backend response.
use crate::{diagnostics, history::{History, Match}, overlay, settings::Settings};
use chrono::{DateTime, Utc};
use companion_plugin_protocol::{backend::{Request, Response}, PackageBinding};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf, time::{Duration, Instant}};

const CAPABILITIES: [&str; 4] = ["ui", "data.private", "backend.access", "overlay.publish"];
pub const FETCH_LIMIT: u32 = 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    data_root: PathBuf,
    generation: String,
    package: PackageBinding,
    capabilities: Vec<String>,
}
impl Launch {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.len() > 8192 { return Err("launch_too_large".into()); }
        let mut launch: Self = serde_json::from_str(text).map_err(|_| "invalid_launch")?;
        if !launch.data_root.is_absolute() || launch.data_root.symlink_metadata().map_err(|_| "data_root_unavailable")?.file_type().is_symlink() {
            return Err("invalid_data_root".into());
        }
        launch.data_root = launch.data_root.canonicalize().map_err(|_| "data_root_unavailable")?;
        if !launch.data_root.is_dir() { return Err("invalid_data_root".into()); }
        if uuid::Uuid::parse_str(&launch.generation).is_err() { return Err("invalid_process_generation".into()); }
        if launch.package.id != crate::PLUGIN_ID || launch.package.version != env!("CARGO_PKG_VERSION")
            || [&launch.package.executable_hash, &launch.package.manifest_hash].iter().any(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err("package_identity_mismatch".into());
        }
        if launch.capabilities.len() > CAPABILITIES.len() || launch.capabilities.iter().any(|c| !CAPABILITIES.contains(&c.as_str())) {
            return Err("capability_denied".into());
        }
        let mut file = std::fs::File::open(std::env::current_exe().map_err(|_| "executable_unavailable")?).map_err(|_| "executable_unavailable")?;
        let mut hash = Sha256::new();
        let mut block = [0; 65536];
        loop {
            let n = file.read(&mut block).map_err(|_| "executable_unavailable")?;
            if n == 0 { break; }
            hash.update(&block[..n]);
        }
        if format!("{:x}", hash.finalize()) != launch.package.executable_hash.to_ascii_lowercase() { return Err("executable_hash_mismatch".into()); }
        Ok(launch)
    }
}

pub struct Worker {
    launch: Launch,
    loaded: bool,
    settings: Settings,
    history: History,
    active: bool,
    /// The session begins when this process is activated (autostart activates
    /// it with Companion), in UTC, compared with each match's finish time.
    session_started_at: Option<DateTime<Utc>>,
    overlay: Option<overlay::Server>,
    widget_error: Option<String>,
    published: Option<(u64, Instant)>,
    pending: Option<Request>,
    sequence: u64,
    next_fetch_at: Option<Instant>,
    failures: u32,
    api_status: Option<String>,
    last_error: Option<String>,
    last_fetch_at: Option<DateTime<Utc>>,
    /// Bumped on every visible change; the UI re-reads matches when it moves.
    revision: u64,
    /// Latency diagnostics: when the pending request was planned, the match
    /// ids last published to the widget, and new ones not yet read by a page.
    pending_since: Option<Instant>,
    published_ids: Vec<String>,
    awaiting_serve: Option<Vec<String>>,
}

impl Worker {
    pub fn new(launch: Launch) -> Self {
        Self {
            launch, loaded: false, settings: Settings::default(), history: History::default(), active: false,
            session_started_at: None, overlay: None, widget_error: None, published: None, pending: None, sequence: 0,
            next_fetch_at: None, failures: 0, api_status: None, last_error: None, last_fetch_at: None, revision: 0,
            pending_since: None, published_ids: Vec::new(), awaiting_serve: None,
        }
    }
    fn permits(&self, capability: &str) -> bool { self.launch.capabilities.iter().any(|c| c == capability) }
    /// Damaged files never stop the worker: the error is shown and defaults
    /// are used until the user saves again.
    fn load(&mut self) {
        if self.loaded { return; }
        self.loaded = true;
        match Settings::load(&self.launch.data_root) { Ok(s) => self.settings = s, Err(e) => self.last_error = Some(e) }
        match History::load(&self.launch.data_root) { Ok(h) => self.history = h, Err(e) => self.last_error = Some(e) }
        if self.history.bind(self.settings.owner()) { self.persist_history(); }
    }
    fn persist_history(&mut self) {
        if let Err(error) = self.history.save(&self.launch.data_root) { self.last_error = Some(error); }
    }
    fn session(&self) -> Vec<&Match> { self.history.session(self.session_started_at) }
    fn diag(&self, event: &str, fields: Value) { diagnostics::record(&self.launch.data_root, event, fields); }

    pub fn status(&self) -> Value {
        json!({
            "prepared": true, "active": self.active, "context": Value::Null,
            "configured": self.settings.configured(), "player": self.settings.player, "platform": self.settings.platform,
            "sessionStartedAt": self.session_started_at, "apiStatus": self.api_status, "lastError": self.last_error,
            "lastFetchAt": self.last_fetch_at, "fetching": self.pending.is_some(),
            "matches": self.history.matches.len(), "sessionMatches": self.session().len(), "revision": self.revision,
            "widget": {
                "enabled": self.settings.widget.enabled, "url": overlay::URL, "error": self.widget_error,
                "running": self.overlay.as_ref().is_some_and(|s| !s.closed()), "clients": self.overlay.as_ref().map_or(0, overlay::Server::clients),
            },
        })
    }

    pub fn command(&mut self, name: &str, args: Value) -> Result<Value, String> {
        self.load();
        match name {
            "host.status" | "host.prepare" => { empty(&args)?; Ok(self.status()) },
            "host.activate" => { empty(&args)?; self.activate() },
            "host.stop" => { empty(&args)?; self.stop(); Ok(self.status()) },
            // Host observations (OBS, chat) are not used by this plugin.
            "host.poll" => {
                if !(args.is_null() || args.is_object()) { return Err("invalid_poll_context".into()); }
                self.publish_widget(false);
                self.note_widget_served();
                Ok(json!({"status": self.status(), "soundIntents": []}))
            },
            _ if name.starts_with("host.") => Err("unsupported_worker_command".into()),
            _ if !self.permits("ui") => Err("capability_denied".into()),
            "status" => { empty(&args)?; Ok(self.status()) },
            "settings.get" => { empty(&args)?; Ok(json!({"settings": self.settings, "widgetUrl": overlay::URL})) },
            "settings.save" => self.save_settings(args),
            "matches" => { empty(&args)?; Ok(self.matches()) },
            "refresh" => {
                empty(&args)?;
                if self.active && self.settings.configured() && self.pending.is_none() { self.next_fetch_at = Some(Instant::now()); }
                Ok(self.status())
            },
            _ => Err("unsupported_ui_command".into()),
        }
    }

    fn activate(&mut self) -> Result<Value, String> {
        if self.active { return Err("already_active".into()); }
        let overlay = self.permits("overlay.publish").then(|| overlay::Server::bind(&self.launch.package));
        self.start_session(overlay)
    }
    fn start_session(&mut self, overlay: Option<Result<overlay::Server, String>>) -> Result<Value, String> {
        // A busy port must not cost the user their match history.
        match overlay {
            Some(Ok(server)) => { self.overlay = Some(server); self.widget_error = None; },
            Some(Err(error)) => self.widget_error = Some(error),
            None => {},
        }
        self.active = true;
        self.session_started_at = Some(Utc::now());
        self.next_fetch_at = Some(Instant::now());
        self.failures = 0;
        self.revision += 1;
        self.publish_widget(true);
        Ok(self.status())
    }

    pub fn stop(&mut self) {
        if let Some(server) = self.overlay.take() { server.stop(); }
        self.active = false;
        // The host drains its in-flight HTTP call itself; a late reply for
        // this request is discarded by scope.
        self.pending = None;
        self.next_fetch_at = None;
        self.published = None;
    }

    fn save_settings(&mut self, args: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Save { settings: Settings }
        let mut next = serde_json::from_value::<Save>(args).map_err(|_| "invalid_settings")?.settings;
        next.player = next.player.trim().to_string();
        next.save(&self.launch.data_root)?;
        let identity_changed = next.owner() != self.settings.owner();
        self.settings = next;
        if self.history.bind(self.settings.owner()) { self.persist_history(); }
        if identity_changed {
            self.api_status = None;
            self.failures = 0;
            // A reply for the previous nickname is ignored when it arrives.
            if self.active && self.settings.configured() { self.next_fetch_at = Some(Instant::now()); }
        }
        self.last_error = None;
        self.revision += 1;
        self.publish_widget(true);
        Ok(json!({"settings": self.settings, "status": self.status()}))
    }

    fn matches(&self) -> Value {
        let session: Vec<&str> = self.session().iter().map(|m| m.id.as_str()).collect();
        json!({"matches": &self.history.matches[..self.history.matches.len().min(100)], "sessionIds": session,
               "sessionStartedAt": self.session_started_at, "revision": self.revision})
    }

    /// `configured`, `sessionStartedAt` and `apiStatus` only explain an empty
    /// widget when it is opened in a browser; OBS never shows them.
    fn widget_state(&self) -> Value {
        let w = &self.settings.widget;
        let matches: Vec<Value> = self.session().into_iter().take(w.count as usize)
            .map(|m| json!({"id": m.id, "map": m.map, "place": m.place, "kills": m.kills, "damage": m.damage})).collect();
        json!({"enabled": w.enabled, "count": w.count, "scale": w.scale, "backgroundOpacity": w.background_opacity,
               "showHeaders": w.show_headers, "matches": matches, "revision": self.revision,
               "configured": self.settings.configured(), "sessionStartedAt": self.session_started_at, "apiStatus": self.api_status})
    }
    fn publish_widget(&mut self, force: bool) {
        let Some(server) = &self.overlay else { return };
        if server.closed() {
            self.overlay = None;
            self.widget_error = Some("widget_listener_failed".into());
            return;
        }
        let fresh = self.published.is_some_and(|(rev, at)| rev == self.revision && at.elapsed() < Duration::from_secs(5));
        if fresh && !force { return; }
        let state = self.widget_state();
        let ids: Vec<String> = state["matches"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
        let changed = ids != self.published_ids;
        // A read recorded for an earlier state must not count for this one.
        if changed { server.take_served(); }
        match server.publish(&state) {
            Ok(()) => {
                self.published = Some((self.revision, Instant::now()));
                if changed {
                    let added: Vec<String> = ids.iter().filter(|id| !self.published_ids.contains(id)).cloned().collect();
                    self.diag("widget_published", json!({"revision": self.revision, "enabled": state["enabled"], "ids": ids, "newIds": added}));
                    self.awaiting_serve = (!added.is_empty()).then_some(added);
                    self.published_ids = ids;
                }
            },
            Err(error) => self.widget_error = Some(error),
        }
    }
    fn note_widget_served(&mut self) {
        if self.awaiting_serve.is_none() { return; }
        let Some(at) = self.overlay.as_ref().and_then(overlay::Server::take_served) else { return };
        let ids = self.awaiting_serve.take();
        self.diag("widget_served", json!({"servedAt": at, "newIds": ids, "clients": self.overlay.as_ref().map_or(0, overlay::Server::clients)}));
    }

    fn query(&self) -> std::collections::BTreeMap<String, String> {
        [("platform".to_string(), self.settings.platform.clone()), ("player".to_string(), self.settings.player.clone()), ("limit".to_string(), FETCH_LIMIT.to_string())].into()
    }
    /// At most one request in flight; repeating it while the host reports
    /// `backend_request_pending` keeps the same identity (one HTTP call).
    pub fn backend_request(&mut self) -> Result<Option<Request>, String> {
        self.load();
        if let Some(request) = &self.pending { return Ok(Some(request.clone())); }
        if !self.active || !self.permits("backend.access") || !self.settings.configured() { return Ok(None); }
        if self.next_fetch_at.is_none_or(|at| at > Instant::now()) { return Ok(None); }
        self.sequence = self.sequence.checked_add(1).ok_or("backend_sequence_exhausted")?;
        let request = Request { resource: "matches".into(), operation_key: format!("matches:{}:{}", self.launch.generation, self.sequence), query: self.query(), body: None };
        request.validate()?;
        self.pending = Some(request.clone());
        self.pending_since = Some(Instant::now());
        self.diag("request", json!({"seq": self.sequence}));
        Ok(Some(request))
    }
    fn retry_in(&mut self, delay: Duration) { self.next_fetch_at = Some(Instant::now() + delay); }
    fn backoff(&mut self) {
        self.failures = self.failures.saturating_add(1);
        let seconds = (15u64 << self.failures.min(5).saturating_sub(1)).min(300);
        self.retry_in(Duration::from_secs(seconds));
    }
    /// A PUBG/API failure is a status, never an error: an `Err` here would make
    /// the host stop the plugin. Only a reply for another request is rejected.
    pub fn backend_response(&mut self, request: &Request, response: Response) -> Result<(), String> {
        if self.pending.as_ref() != Some(request) || response.operation_key != request.operation_key { return Err("backend_response_scope_mismatch".into()); }
        if response.error.as_deref() == Some("backend_request_pending") {
            if response.status.is_some() || response.body.is_some() { return Err("invalid_backend_pending_response".into()); }
            return Ok(());
        }
        self.pending = None;
        let latency_ms = self.pending_since.take().map(|at| at.elapsed().as_millis() as u64);
        if request.query != self.query() || !self.active {
            // Settings changed while the call was in flight.
            if self.active { self.retry_in(Duration::ZERO); }
            self.diag("response", json!({"seq": self.sequence, "latencyMs": latency_ms, "discarded": true}));
            return Ok(());
        }
        self.last_fetch_at = Some(Utc::now());
        let before = (self.api_status.clone(), self.history.matches.len());
        let known: std::collections::HashSet<String> = self.history.matches.iter().map(|m| m.id.clone()).collect();
        let http_status = response.status;
        let transport_error = response.error.clone();
        let ok = response.error.is_none() && response.status.is_some_and(|s| (200..300).contains(&s));
        let body = response.body.filter(|b| ok && b.is_object() && companion_plugin_protocol::backend::public_response(b));
        match body.as_ref().and_then(|b| b.get("status")).and_then(Value::as_str) {
            Some("ok") => {
                let incoming: Option<Vec<Match>> = body.as_ref().and_then(|b| b.get("matches")).cloned().and_then(|m| serde_json::from_value(m).ok());
                match incoming {
                    Some(matches) if matches.len() <= FETCH_LIMIT as usize => {
                        if self.history.merge(matches) > 0 { self.persist_history(); self.revision += 1; }
                        self.api_status = Some("ok".into());
                        self.failures = 0;
                        let complete = body.as_ref().and_then(|b| b.get("complete")).and_then(Value::as_bool) != Some(false);
                        self.retry_in(Duration::from_secs(if complete { 60 } else { 5 }));
                    },
                    _ => { self.api_status = Some("invalid_response".into()); self.backoff(); },
                }
            },
            Some("rate_limited") => { self.api_status = Some("rate_limited".into()); self.retry_in(Duration::from_secs(90)); },
            Some(status @ ("not_configured" | "player_not_found")) => { self.api_status = Some(status.into()); self.retry_in(Duration::from_secs(300)); },
            Some("unavailable") => { self.api_status = Some("unavailable".into()); self.backoff(); },
            _ => {
                let code = match (&response.error, response.status) {
                    _ if ok => "invalid_response".to_string(),
                    (_, Some(426)) => "companion_outdated".to_string(),
                    (Some(error), _) => error.clone(),
                    (None, Some(status)) => format!("backend_http_{status}"),
                    _ => "invalid_response".into(),
                };
                let not_signed_in = code == "account_not_connected";
                self.api_status = Some(code);
                if not_signed_in { self.retry_in(Duration::from_secs(30)); } else { self.backoff(); }
            },
        }
        if before != (self.api_status.clone(), self.history.matches.len()) { self.revision += 1; }
        self.note_response(latency_ms, http_status, transport_error, body.as_ref(), &known);
        self.publish_widget(true);
        Ok(())
    }

    /// One `response` line, and a `match_added` line per new match with how
    /// long after its finish it arrived and the backend's own timestamps.
    fn note_response(&self, latency_ms: Option<u64>, http_status: Option<u16>, error: Option<String>, body: Option<&Value>, known: &std::collections::HashSet<String>) {
        let added: Vec<&Match> = self.history.matches.iter().filter(|m| !known.contains(&m.id)).collect();
        let timing = body.and_then(|b| b.get("timing"));
        self.diag("response", json!({
            "seq": self.sequence, "latencyMs": latency_ms, "httpStatus": http_status, "error": error, "apiStatus": self.api_status,
            "complete": body.and_then(|b| b.get("complete")), "matches": body.and_then(|b| b.get("matches")).and_then(Value::as_array).map(Vec::len),
            "newIds": added.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            "playerFetchedAt": timing.and_then(|t| t.get("playerFetchedAt")),
        }));
        let now = Utc::now();
        for m in added {
            let backend = timing.and_then(|t| t.get("matches")).and_then(Value::as_array).into_iter().flatten()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(m.id.as_str()));
            let field = |name: &str| backend.and_then(|t| t.get(name)).cloned().unwrap_or(Value::Null);
            self.diag("match_added", json!({
                "id": m.id, "map": m.map, "createdAt": m.created_at, "finishedAt": m.finished_at(),
                "sinceFinishSec": (now - m.finished_at()).num_seconds(),
                "inSession": self.session_started_at.is_some_and(|start| m.finished_at() >= start),
                "listedAfter": field("listedAfter"), "listedAt": field("listedAt"), "detailsAt": field("detailsAt"),
            }));
        }
    }
}

/// Test-only entry for the OBS page's browser test: a worker with every grant
/// and its widget served on an ephemeral loopback port from `renderer`.
#[cfg(feature = "harness")]
pub fn harness(data_root: PathBuf, renderer: Vec<u8>) -> Result<(Worker, std::net::SocketAddr, DateTime<Utc>), String> {
    let launch = Launch {
        data_root, generation: uuid::Uuid::new_v4().to_string(),
        package: PackageBinding { id: crate::PLUGIN_ID.into(), version: env!("CARGO_PKG_VERSION").into(), executable_hash: "0".repeat(64), manifest_hash: "0".repeat(64) },
        capabilities: CAPABILITIES.iter().map(|c| c.to_string()).collect(),
    };
    let server = overlay::Server::start("127.0.0.1:0", std::sync::Arc::new(renderer))?;
    let address = server.address().ok_or("widget_bind_failed")?;
    let mut worker = Worker::new(launch);
    worker.load();
    worker.start_session(Some(Ok(server)))?;
    let started = worker.session_started_at.ok_or("session_not_started")?;
    Ok((worker, address, started))
}

fn empty(args: &Value) -> Result<(), String> {
    if args.is_null() || args == &json!({}) { Ok(()) } else { Err("unexpected_command_payload".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn worker(root: &std::path::Path, caps: &[&str]) -> Worker {
        Worker::new(Launch {
            data_root: root.into(), generation: uuid::Uuid::new_v4().to_string(),
            package: PackageBinding { id: "pubg".into(), version: env!("CARGO_PKG_VERSION").into(), executable_hash: "a".repeat(64), manifest_hash: "b".repeat(64) },
            capabilities: caps.iter().map(|c| c.to_string()).collect(),
        })
    }
    // overlay.publish is left out here: activation would bind port 3667.
    const CAPS: [&str; 3] = ["ui", "data.private", "backend.access"];
    fn settings(player: &str) -> Value { json!({"settings": {"player": player, "platform": "steam", "widget": {"enabled": true, "count": 3, "scale": 100, "backgroundOpacity": 50, "showHeaders": true}}}) }
    fn page(matches: Value, complete: bool) -> Value { json!({"status": "ok", "player": {"name": "ProPlayer", "platform": "steam"}, "matches": matches, "complete": complete, "fetchedAt": Utc::now()}) }
    fn entry(n: u32, at: DateTime<Utc>) -> Value {
        json!({"id": format!("00000000-0000-4000-8000-{n:012}"), "createdAt": at, "durationSec": 1700, "map": "Erangel", "gameMode": "squad-fpp", "place": n, "kills": n, "damage": 100 * n})
    }
    fn ok(request: &Request, body: Value) -> Response { Response { operation_key: request.operation_key.clone(), status: Some(200), body: Some(body), error: None } }

    #[test]
    fn idle_until_activated_and_configured_and_status_satisfies_the_host_batch() {
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &CAPS);
        let status = w.command("host.status", json!({})).unwrap();
        assert_eq!(status["active"], false);
        assert_eq!(status["prepared"], true);
        assert!(w.backend_request().unwrap().is_none());
        w.command("host.activate", json!({})).unwrap();
        assert!(w.backend_request().unwrap().is_none(), "no nickname yet");
        let batch = w.command("host.poll", json!({"streamObservation": null, "chat": null})).unwrap();
        assert_eq!(batch["status"]["active"], true);
        assert_eq!(batch["status"]["context"], Value::Null);
        assert_eq!(batch["soundIntents"], json!([]));
        assert_eq!(batch.as_object().unwrap().len(), 2);
        assert_eq!(w.command("host.activate", json!({})).unwrap_err(), "already_active");
    }

    #[test]
    fn one_request_in_flight_no_duplicates_and_session_uses_match_finish() {
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &CAPS);
        w.command("settings.save", settings("ProPlayer")).unwrap();
        w.command("host.activate", json!({})).unwrap();
        let start = w.session_started_at.unwrap();
        let request = w.backend_request().unwrap().unwrap();
        assert_eq!(request.resource, "matches");
        assert_eq!(request.query.get("player").unwrap(), "ProPlayer");
        // Pending replies keep the same request, never a second call.
        for _ in 0..3 {
            w.backend_response(&request, Response::failed(&request, "backend_request_pending")).unwrap();
            assert_eq!(w.backend_request().unwrap().unwrap(), request);
        }
        // Started 40 min before the session and lasted 1700 s: finished before it.
        let earlier = entry(1, start - chrono::Duration::minutes(40));
        let later = entry(2, start + chrono::Duration::minutes(5));
        w.backend_response(&request, ok(&request, page(json!([later, earlier]), true))).unwrap();
        assert!(w.backend_request().unwrap().is_none(), "next refresh is scheduled, not immediate");
        w.next_fetch_at = Some(Instant::now());
        let again = w.backend_request().unwrap().unwrap();
        assert_ne!(again.operation_key, request.operation_key);
        w.backend_response(&again, ok(&again, page(json!([entry(2, start + chrono::Duration::minutes(5)), entry(1, start - chrono::Duration::minutes(40))]), true))).unwrap();
        let listed = w.command("matches", json!({})).unwrap();
        assert_eq!(listed["matches"].as_array().unwrap().len(), 2);
        assert_eq!(listed["sessionIds"], json!(["00000000-0000-4000-8000-000000000002"]));
        assert_eq!(w.widget_state()["matches"].as_array().unwrap().len(), 1);
        assert_eq!(History::load(root.path()).unwrap().matches.len(), 2, "persisted");
    }

    #[test]
    fn a_new_companion_run_is_a_new_session_and_history_survives() {
        let root = tempfile::tempdir().unwrap();
        let mut first = worker(root.path(), &CAPS);
        first.command("settings.save", settings("ProPlayer")).unwrap();
        first.command("host.activate", json!({})).unwrap();
        first.session_started_at = Some(Utc::now() - chrono::Duration::hours(2));
        let request = first.backend_request().unwrap().unwrap();
        // Finished about half an hour ago, inside the first run.
        first.backend_response(&request, ok(&request, page(json!([entry(1, Utc::now() - chrono::Duration::hours(1))]), true))).unwrap();
        assert_eq!(first.session().len(), 1);
        first.stop();
        std::thread::sleep(Duration::from_millis(5));
        let mut second = worker(root.path(), &CAPS);
        second.command("host.activate", json!({})).unwrap();
        assert_eq!(second.history.matches.len(), 1, "history kept");
        assert_eq!(second.session().len(), 0, "previous run's match is not in this session");
        assert_eq!(second.widget_state()["matches"], json!([]));
    }

    /// Worker → loopback overlay → `/pubg/widget/state`: what the OBS page
    /// polls, without restarting the worker or reopening the page.
    #[test]
    fn a_finished_match_reaches_the_served_widget_state_while_running() {
        use std::{io::{Read, Write}, net::TcpStream};
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &["ui", "data.private", "backend.access", "overlay.publish"]);
        w.command("settings.save", settings("ProPlayer")).unwrap();
        let server = overlay::Server::start("127.0.0.1:0", std::sync::Arc::new(b"renderer".to_vec())).unwrap();
        let address = server.address().unwrap();
        w.start_session(Some(Ok(server))).unwrap();
        let state = || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            write!(stream, "GET /pubg/widget/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new(); stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
            serde_json::from_str::<Value>(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
        };
        let empty = state();
        assert_eq!((empty["enabled"].as_bool(), empty["configured"].as_bool()), (Some(true), Some(true)));
        assert_eq!(empty["matches"], json!([]));
        assert!(empty["sessionStartedAt"].is_string());
        // Already running when the plugin started; its result arrives later.
        let start = w.session_started_at.unwrap();
        let request = w.backend_request().unwrap().unwrap();
        let mut body = page(json!([entry(7, start - chrono::Duration::minutes(10)), entry(1, start - chrono::Duration::hours(2))]), true);
        body["timing"] = json!({"playerFetchedAt": "2026-10-22T10:01:30Z", "matches": [
            {"id": "00000000-0000-4000-8000-000000000007", "listedAfter": "2026-10-22T10:00:30Z", "listedAt": "2026-10-22T10:01:30Z", "detailsAt": "2026-10-22T10:01:31Z"}]});
        w.backend_response(&request, ok(&request, body)).unwrap();
        let shown = state();
        assert_eq!(shown["matches"], json!([{"id": "00000000-0000-4000-8000-000000000007", "map": "Erangel", "place": 7, "kills": 7, "damage": 700}]));
        // The latency log follows the match from the request to the page read.
        w.command("host.poll", json!({})).unwrap();
        let log: Vec<Value> = std::fs::read_to_string(root.path().join(diagnostics::FILE)).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let events: Vec<&str> = log.iter().map(|e| e["event"].as_str().unwrap()).collect();
        assert_eq!(&events[events.len() - 6..], ["request", "response", "match_added", "match_added", "widget_published", "widget_served"], "{events:?}");
        let added = log.iter().find(|e| e["event"] == "match_added" && e["id"] == "00000000-0000-4000-8000-000000000007").unwrap();
        assert_eq!((added["inSession"].as_bool(), added["listedAfter"].as_str(), added["listedAt"].as_str()), (Some(true), Some("2026-10-22T10:00:30Z"), Some("2026-10-22T10:01:30Z")));
        assert!(added["sinceFinishSec"].as_i64().unwrap() < 0, "this fixture match ends after now");
        let response = log.iter().rev().find(|e| e["event"] == "response").unwrap();
        assert_eq!((response["httpStatus"].as_u64(), response["apiStatus"].as_str(), response["newIds"].as_array().map(Vec::len)), (Some(200), Some("ok"), Some(2)));
        assert!(response["latencyMs"].is_u64());
        let published = log.iter().rev().find(|e| e["event"] == "widget_published").unwrap();
        assert_eq!(published["newIds"], json!(["00000000-0000-4000-8000-000000000007"]));
        // The next finished match is added to the same served projection.
        w.command("refresh", json!({})).unwrap();
        let next = w.backend_request().unwrap().unwrap();
        w.backend_response(&next, ok(&next, page(json!([entry(8, start + chrono::Duration::minutes(30)), entry(7, start - chrono::Duration::minutes(10))]), true))).unwrap();
        assert_eq!(state()["matches"].as_array().unwrap().iter().map(|m| m["kills"].as_u64().unwrap()).collect::<Vec<_>>(), vec![8, 7]);
        // Turning the widget off is published at once, matches stay.
        w.command("settings.save", json!({"settings": {"player": "ProPlayer", "platform": "steam", "widget": {"enabled": false, "count": 3, "scale": 100, "backgroundOpacity": 50, "showHeaders": true}}})).unwrap();
        assert_eq!(state()["enabled"], false);
        w.stop();
    }

    #[test]
    fn diagnostics_never_break_the_worker_and_hold_no_identity() {
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &CAPS);
        w.command("settings.save", settings("ProPlayer")).unwrap();
        w.command("host.activate", json!({})).unwrap();
        let request = w.backend_request().unwrap().unwrap();
        w.backend_response(&request, ok(&request, page(json!([entry(1, Utc::now())]), true))).unwrap();
        let text = std::fs::read_to_string(root.path().join(diagnostics::FILE)).unwrap();
        for leak in ["ProPlayer", "proplayer", "http://", "https://", "token", root.path().to_str().unwrap()] { assert!(!text.contains(leak), "{leak} in {text}"); }
        // An unwritable log (here a directory in its place) changes nothing.
        std::fs::remove_file(root.path().join(diagnostics::FILE)).unwrap();
        std::fs::create_dir(root.path().join(diagnostics::FILE)).unwrap();
        w.next_fetch_at = Some(Instant::now());
        let next = w.backend_request().unwrap().unwrap();
        w.backend_response(&next, ok(&next, page(json!([entry(2, Utc::now()), entry(1, Utc::now())]), true))).unwrap();
        assert_eq!(w.history.matches.len(), 2);
        assert_eq!(w.status()["apiStatus"], "ok");
        assert!(w.command("host.poll", json!({})).is_ok());
    }

    #[test]
    fn api_failures_are_statuses_with_backoff_never_errors() {
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &CAPS);
        w.command("settings.save", settings("ProPlayer")).unwrap();
        w.command("host.activate", json!({})).unwrap();
        let cases = [
            (Response { operation_key: String::new(), status: None, body: None, error: Some("account_not_connected".into()) }, "account_not_connected"),
            (Response { operation_key: String::new(), status: Some(200), body: Some(json!({"status": "not_configured"})), error: None }, "not_configured"),
            (Response { operation_key: String::new(), status: Some(200), body: Some(json!({"status": "rate_limited"})), error: None }, "rate_limited"),
            (Response { operation_key: String::new(), status: Some(502), body: None, error: Some("backend_http_rejected".into()) }, "backend_http_rejected"),
            (Response { operation_key: String::new(), status: Some(200), body: Some(page(json!([{"id": "../x"}]), true)), error: None }, "invalid_response"),
            (Response { operation_key: String::new(), status: Some(200), body: Some(json!({"status": "ok", "matches": [], "apiKey": "leak"})), error: None }, "invalid_response"),
        ];
        for (mut response, expected) in cases {
            w.next_fetch_at = Some(Instant::now());
            let request = w.backend_request().unwrap().unwrap();
            response.operation_key = request.operation_key.clone();
            w.backend_response(&request, response).unwrap();
            assert_eq!(w.status()["apiStatus"], expected);
            assert!(w.next_fetch_at.unwrap() > Instant::now(), "{expected} waits before retrying");
            assert!(w.command("host.poll", json!({})).is_ok());
        }
        let other = Request { resource: "matches".into(), operation_key: "matches:other:1".into(), query: Default::default(), body: None };
        assert_eq!(w.backend_response(&other, Response::failed(&other, "x")).unwrap_err(), "backend_response_scope_mismatch");
    }

    #[test]
    fn changing_the_player_resets_history_and_ignores_the_old_reply() {
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &CAPS);
        w.command("settings.save", settings("ProPlayer")).unwrap();
        w.command("host.activate", json!({})).unwrap();
        let request = w.backend_request().unwrap().unwrap();
        w.backend_response(&request, ok(&request, page(json!([entry(1, Utc::now())]), true))).unwrap();
        w.next_fetch_at = Some(Instant::now());
        let in_flight = w.backend_request().unwrap().unwrap();
        w.command("settings.save", settings("Another")).unwrap();
        assert!(w.history.matches.is_empty());
        w.backend_response(&in_flight, ok(&in_flight, page(json!([entry(2, Utc::now())]), true))).unwrap();
        assert!(w.history.matches.is_empty(), "a reply for the old nickname is dropped");
        let next = w.backend_request().unwrap().unwrap();
        assert_eq!(next.query.get("player").unwrap(), "Another");
    }

    #[test]
    fn ui_commands_are_bounded_and_cannot_reach_host_operations() {
        let root = tempfile::tempdir().unwrap();
        let mut w = worker(root.path(), &["data.private"]);
        assert_eq!(w.command("status", json!({})).unwrap_err(), "capability_denied");
        let mut w = worker(root.path(), &CAPS);
        for (name, args) in [("settings.save", json!({"settings": {"player": "../x", "platform": "steam", "widget": {"enabled": true, "count": 3, "scale": 100, "backgroundOpacity": 50, "showHeaders": true}}})),
                             ("settings.save", json!({"settings": {}, "path": "x"})), ("matches", json!({"offset": 1})), ("host.resource", json!({})), ("anything", json!({}))] {
            assert!(w.command(name, args).is_err(), "{name}");
        }
        assert!(!root.path().join(crate::settings::FILE).exists());
        let saved = w.command("settings.save", settings("ProPlayer")).unwrap();
        assert_eq!(saved["settings"]["widget"]["count"], 3);
        assert_eq!(w.command("settings.get", json!({})).unwrap()["widgetUrl"], overlay::URL);
    }

    #[test]
    fn saved_nickname_survives_a_worker_restart_while_stopped_or_running() {
        let root = tempfile::tempdir().unwrap();
        // Stopped plugin: the UI-only worker still persists the settings.
        let mut stopped = worker(root.path(), &CAPS);
        let reply = stopped.command("settings.save", settings("New_Player")).unwrap();
        assert_eq!(reply["settings"]["player"], "New_Player");
        assert_eq!(reply["status"]["configured"], true);
        drop(stopped);
        let mut restarted = worker(root.path(), &CAPS);
        assert_eq!(restarted.command("settings.get", json!({})).unwrap()["settings"]["player"], "New_Player");
        // Running plugin: a save starts loading matches for the new nickname at once.
        restarted.command("host.activate", json!({})).unwrap();
        let first = restarted.backend_request().unwrap().unwrap();
        restarted.backend_response(&first, ok(&first, page(json!([]), true))).unwrap();
        restarted.command("settings.save", json!({"settings": {"player": "Second", "platform": "psn", "widget": {"enabled": false, "count": 5, "scale": 100, "backgroundOpacity": 70, "showHeaders": true}}})).unwrap();
        let next = restarted.backend_request().unwrap().expect("immediate fetch after save");
        assert_eq!((next.query["player"].as_str(), next.query["platform"].as_str()), ("Second", "psn"));
        let again = worker(root.path(), &CAPS).command("settings.get", json!({})).unwrap();
        assert_eq!((again["settings"]["player"].as_str(), again["settings"]["platform"].as_str()), (Some("Second"), Some("psn")));
    }

    #[test]
    fn a_damaged_settings_file_is_reported_not_fatal() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(crate::settings::FILE), b"not json").unwrap();
        let mut w = worker(root.path(), &CAPS);
        let status = w.command("host.status", json!({})).unwrap();
        assert_eq!(status["lastError"], "plugin_data_invalid");
        assert_eq!(status["configured"], false);
        w.command("settings.save", settings("ProPlayer")).unwrap();
        assert_eq!(w.status()["lastError"], Value::Null);
    }
}
