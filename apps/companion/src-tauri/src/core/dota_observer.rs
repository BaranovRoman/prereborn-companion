//! Explicit debug-only observer. No listener, storage, grants or effect dispatcher.
//! Ingest only projects bounded fields and try-locks a bounded mailbox; IPC lives on its own thread.
use std::{collections::VecDeque, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant}};
use companion_dota_domain::{contracts::{ReplayContext, ReplayGsi, ReplayInput}, events::{self, PendingConfirmations}, broadcast_state::{self, BroadcastState}, gsi};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Manager, Emitter};
use super::plugin_runtime::{Runtime, Phase};

const CAPACITY: usize = 8;
const RECONNECT_MS: u64 = 5_000;
fn ipc_error(error: &str) -> &'static str {
    if error.contains("write_timeout") { "ipc_write_timeout" }
    else if error.contains("timeout") { "ipc_reply_timeout" }
    else if error.contains("incompatible") { "incompatible_plugin" }
    else if error.contains("spawn_failed") { "launch_failed" }
    else if error.contains("unexpected_eof") || error.contains("process_exited") { "process_crashed" }
    else { "ipc_failed" }
}

pub fn enabled(debug: bool, args: &[String]) -> bool {
    debug && args.iter().any(|arg| arg == "--dota-gsi-observer")
}

/// Whitelist before deserialization. Never clone the original JSON or arbitrary nested objects.
pub fn project(raw: &Value) -> Result<ReplayGsi, &'static str> {
    fn fields(raw: &Value, names: &[&str]) -> Result<Value, &'static str> {
        let mut result = serde_json::Map::new();
        for name in names {
            if let Some(value) = raw.get(*name) {
                if value.is_object() || value.is_array() || value.as_str().is_some_and(|s| s.len() > 128) {
                    return Err("invalid_projection_field");
                }
                result.insert((*name).into(), value.clone());
            }
        }
        Ok(Value::Object(result))
    }
    fn signals(raw: &Value) -> Result<Value, &'static str> {
        let map = raw.as_object().ok_or("invalid_slots")?;
        if map.len() > 32 { return Err("too_many_slots"); }
        let mut result = serde_json::Map::new();
        for (key, value) in map {
            let index = key.strip_prefix("slot").or_else(|| key.strip_prefix("ability"));
            if !index.is_some_and(|i| !i.is_empty() && i.bytes().all(|c| c.is_ascii_digit()) && i.parse::<u8>().is_ok_and(|i| i < 32)) {
                return Err("invalid_slot");
            }
            result.insert(key.clone(), fields(value, &["name", "cooldown", "charges"])?);
        }
        Ok(Value::Object(result))
    }
    let mut result = serde_json::Map::new();
    for (name, allowed) in [
        ("player", &["activity", "team_name", "kills", "deaths", "assists"][..]),
        ("map", &["game_state", "matchid", "customgamename", "win_team"][..]),
        ("hero", &["id"][..]),
    ] {
        if let Some(value) = raw.get(name).filter(|v| !v.is_null()) {
            result.insert(name.into(), fields(value, allowed)?);
        }
    }
    for name in ["items", "abilities"] {
        if let Some(value) = raw.get(name).filter(|v| !v.is_null()) { result.insert(name.into(), signals(value)?); }
    }
    if let Some(raw) = raw.get("couriers").filter(|v| !v.is_null()) {
        let couriers = raw.as_object().ok_or("invalid_couriers")?;
        if couriers.len() > 8 { return Err("too_many_couriers"); }
        let mut result_couriers = serde_json::Map::new();
        for (key, value) in couriers {
            if key.len() > 64 { return Err("invalid_courier"); }
            if let Some(items) = value.get("items") { result_couriers.insert(format!("courier{}", result_couriers.len()), json!({"items": signals(items)?})); }
        }
        result.insert("couriers".into(), Value::Object(result_couriers));
    }
    let projected: ReplayGsi = serde_json::from_value(Value::Object(result)).map_err(|_| "invalid_projection")?;
    if serde_json::to_vec(&projected).map_err(|_| "invalid_projection")?.len() > companion_plugin_protocol::MAX_FRAME - 1024 {
        return Err("projection_too_large");
    }
    Ok(projected)
}

/// Independent invocation of the existing built-in pure functions, not Replay::apply.
#[derive(Default)]
struct Reference { previous: Option<Value>, pending: PendingConfirmations }
impl Reference {
    fn apply(&mut self, input: &ReplayInput) -> Value {
        let current = serde_json::to_value(&input.snapshot).unwrap();
        if self.previous.as_ref().is_some_and(|p| events::hero_identity_changed(p, &current)) {
            self.previous = None; self.pending = PendingConfirmations::default();
        }
        let (sounds, _) = events::detect_events_with_state(self.previous.as_ref(), &current, input.observed_at_ms, &mut self.pending);
        let parsed = gsi::parse(&current);
        let result = json!({"sequence":input.sequence,
            "broadcastState":broadcast_state::resolve(BroadcastState::from_gsi(&current), input.context.session_ended, input.context.manual_summary_override),
            "soundSignals":sounds.into_iter().map(|s| json!({"kind":s.kind,"id":s.id})).collect::<Vec<_>>(),
            "inMatch":parsed.as_ref().is_some_and(|p|p.is_in_match()), "postGame":parsed.as_ref().is_some_and(|p|p.is_post_game()),
            "heroId":parsed.as_ref().and_then(|p|p.hero_id), "matchId":parsed.and_then(|p|p.match_id), "mode":"replay_only","sideEffects":false});
        self.previous = Some(current);
        result
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status {
    phase: &'static str, received: u64, sent: u64, processed: u64, lost: u64,
    last_sequence: u64, parity_mismatches: u64, resets: u64,
    last_error: Option<&'static str>, last_analysis: Option<Value>, last_mismatch_fields: Vec<&'static str>,
}
impl Default for Status {
    fn default() -> Self { Self { phase:"stopped", received:0, sent:0, processed:0, lost:0, last_sequence:0, parity_mismatches:0, resets:0, last_error:None, last_analysis:None, last_mismatch_fields:Vec::new() } }
}
struct Frame { generation: u64, input: ReplayInput }
struct Shared {
    queue: Mutex<VecDeque<Frame>>, status: Mutex<Status>, wanted: AtomicBool,
    generation: AtomicU64, sequence: AtomicU64, lost: AtomicU64, sent: AtomicU64,
    last_time: AtomicU64, origin: Instant,
}
#[derive(Clone)]
pub struct Observer(Arc<Shared>);
impl Observer {
    pub fn new(executable: PathBuf) -> Self {
        let shared = Arc::new(Shared { queue:Mutex::new(VecDeque::with_capacity(CAPACITY)), status:Mutex::new(Status::default()),
            wanted:AtomicBool::new(false), generation:AtomicU64::new(1), sequence:AtomicU64::new(0), lost:AtomicU64::new(0), sent:AtomicU64::new(0), last_time:AtomicU64::new(0), origin:Instant::now() });
        let observer = Self(shared.clone());
        let weak = Arc::downgrade(&shared);
        std::thread::spawn(move || {
            let mut runtime = Runtime::default();
            let mut reference = Reference::default();
            let mut generation = 0;
            let mut last_sequence = 0;
            let mut last_at = None;
            let mut active = false;
            loop {
                let Some(shared) = weak.upgrade() else { break; };
                if !shared.wanted.load(Ordering::SeqCst) {
                    if active || runtime.snapshot().phase == Phase::Failed { let _ = runtime.stop(); }
                    active = false;
                    let mut status = shared.status.lock().unwrap();
                    if status.phase != "failed" { status.phase = "stopped"; }
                    drop(status);
                    drop(shared); std::thread::sleep(Duration::from_millis(10)); continue;
                }
                if active && runtime.snapshot().phase != Phase::Running {
                    let _ = runtime.stop(); active = false;
                    Self::failed(&shared, "process_crashed"); continue;
                }
                if !active {
                    shared.status.lock().unwrap().phase = "starting";
                    if let Err(error) = runtime.start_expected(&executable, &["--replay".into()], "dota2", Some("0.1.0")) {
                        Self::failed(&shared, ipc_error(&error)); continue;
                    }
                    active = true; generation = 0; last_sequence = 0; last_at = None;
                    shared.status.lock().unwrap().phase = "running";
                }
                let frame = shared.queue.lock().unwrap().pop_front();
                let Some(frame) = frame else { drop(shared); std::thread::sleep(Duration::from_millis(10)); continue; };
                if frame.generation != shared.generation.load(Ordering::SeqCst) {
                    shared.lost.fetch_add(1, Ordering::SeqCst); continue;
                }
                if frame.input.sequence <= last_sequence || last_at.is_some_and(|t| frame.input.observed_at_ms < t) {
                    shared.lost.fetch_add(1, Ordering::SeqCst); shared.generation.fetch_add(1, Ordering::SeqCst);
                    shared.status.lock().unwrap().last_error = Some("out_of_order_frame"); continue;
                }
                if frame.generation != generation {
                    if let Err(error) = runtime.command("dota.reset".into(), json!({})) { shared.lost.fetch_add(1, Ordering::SeqCst); let _ = runtime.stop(); active = false; Self::failed(&shared, ipc_error(&error)); continue; }
                    reference = Reference::default(); generation = frame.generation;
                    shared.status.lock().unwrap().resets += 1;
                }
                let expected = reference.apply(&frame.input);
                last_sequence = frame.input.sequence; last_at = Some(frame.input.observed_at_ms);
                shared.sent.fetch_add(1, Ordering::SeqCst);
                match runtime.command("dota.replay".into(), serde_json::to_value(&frame.input).unwrap()) {
                    Ok(actual) => {
                        if frame.generation != shared.generation.load(Ordering::SeqCst) || !shared.wanted.load(Ordering::SeqCst) {
                            shared.lost.fetch_add(1, Ordering::SeqCst); continue;
                        }
                        let mut status = shared.status.lock().unwrap();
                        status.processed += 1; status.last_sequence = frame.input.sequence;
                        if actual != expected {
                            status.parity_mismatches += 1; status.last_error = Some("parity_mismatch");
                            status.last_mismatch_fields = ["sequence", "broadcastState", "soundSignals", "inMatch", "postGame", "heroId", "matchId", "mode", "sideEffects"]
                                .into_iter().filter(|field| actual.get(*field) != expected.get(*field)).collect();
                            if status.last_mismatch_fields.is_empty() { status.last_mismatch_fields.push("result_shape"); }
                        }
                        // Only expected bounded fields are exposed, never arbitrary plugin data.
                        status.last_analysis = if actual == expected { Some(expected) } else { None };
                    }
                    Err(error) => { let _ = runtime.stop(); active = false; shared.lost.fetch_add(1, Ordering::SeqCst); Self::failed(&shared, ipc_error(&error)); }
                }
            }
        });
        observer
    }
    fn failed(shared: &Shared, error: &'static str) {
        shared.wanted.store(false, Ordering::SeqCst);
        shared.generation.fetch_add(1, Ordering::SeqCst);
        let mut queue = shared.queue.lock().unwrap();
        shared.lost.fetch_add(queue.len() as u64, Ordering::SeqCst); queue.clear();
        let mut status = shared.status.lock().unwrap(); status.phase = "failed"; status.last_error = Some(error); status.last_analysis = None;
    }
    pub fn start(&self) -> Result<(), &'static str> {
        let mut status = self.0.status.lock().unwrap();
        self.0.wanted.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).map_err(|_| "already_started")?;
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        status.phase = "starting"; status.last_error = None; status.last_analysis = None; status.last_mismatch_fields.clear();
        Ok(())
    }
    pub fn stop(&self) {
        self.0.wanted.store(false, Ordering::SeqCst); self.0.generation.fetch_add(1, Ordering::SeqCst);
        self.0.status.lock().unwrap().phase = "stopping";
        let mut queue = self.0.queue.lock().unwrap(); self.0.lost.fetch_add(queue.len() as u64, Ordering::SeqCst); queue.clear();
    }
    /// Used only on app exit, never by the GSI handler.
    pub fn shutdown(&self) {
        self.stop();
        let deadline = Instant::now() + Duration::from_secs(7);
        while self.status().phase != "stopped" && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn status(&self) -> Status {
        let mut status = self.0.status.lock().unwrap().clone();
        status.received = self.0.sequence.load(Ordering::SeqCst); status.sent = self.0.sent.load(Ordering::SeqCst); status.lost = self.0.lost.load(Ordering::SeqCst); status
    }
    pub fn submit(&self, raw: &Value, mut context: ReplayContext) {
        if !self.0.wanted.load(Ordering::SeqCst) { return; }
        let sequence = self.0.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let at = self.0.origin.elapsed().as_millis() as u64;
        let last = self.0.last_time.swap(at, Ordering::SeqCst);
        if at.saturating_sub(last) > RECONNECT_MS { self.0.generation.fetch_add(1, Ordering::SeqCst); }
        let snapshot = match project(raw) { Ok(snapshot) => snapshot, Err(_) => { self.0.lost.fetch_add(1, Ordering::SeqCst); self.0.generation.fetch_add(1, Ordering::SeqCst); return; } };
        let Ok(mut queue) = self.0.queue.try_lock() else { self.0.lost.fetch_add(1, Ordering::SeqCst); self.0.generation.fetch_add(1, Ordering::SeqCst); return; };
        if queue.len() == CAPACITY {
            self.0.lost.fetch_add(queue.len() as u64, Ordering::SeqCst); queue.clear(); self.0.generation.fetch_add(1, Ordering::SeqCst);
        }
        let generation = self.0.generation.load(Ordering::SeqCst);
        context.observer_session = Some(generation);
        queue.push_back(Frame { generation, input:ReplayInput { sequence, observed_at_ms:at, snapshot, context } });
    }
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if !enabled(cfg!(debug_assertions), &std::env::args().collect::<Vec<_>>()) { return Ok(()); }
    if crate::plugin_lab::enabled() { return Err("observer_and_isolated_lab_are_mutually_exclusive".into()); }
    // Invalid debug configuration must not abort the built-in bootstrap.
    let executable = std::env::var("PREREBORN_DOTA_BIN").ok().map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok()).filter(|p| p.is_file()).unwrap_or_default();
    let observer = Observer::new(executable); observer.start()?;
    let weak = Arc::downgrade(&observer.0);
    let events = app.clone();
    std::thread::spawn(move || {
        while let Some(shared) = weak.upgrade() {
            let status = Observer(shared).status();
            // A diagnostic event plus counters-only stderr: never persist raw GSI or plugin strings.
            let _ = events.emit("dota-observer-status", &status);
            eprintln!("DOTA_OBSERVER phase={} received={} sent={} processed={} lost={} sequence={} parity={} error={}",
                status.phase, status.received, status.sent, status.processed, status.lost, status.last_sequence,
                status.parity_mismatches, status.last_error.unwrap_or("none"));
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    app.manage(observer); Ok(())
}

pub fn forward(app: &tauri::AppHandle, raw: &Value) {
    let Some(observer) = app.try_state::<Observer>() else { return; };
    let state = app.state::<crate::state::AppState>();
    let Ok(inner) = state.0.try_lock() else {
        if observer.0.wanted.load(Ordering::SeqCst) {
            observer.0.sequence.fetch_add(1, Ordering::SeqCst);
            observer.0.lost.fetch_add(1, Ordering::SeqCst); observer.0.generation.fetch_add(1, Ordering::SeqCst);
        }
        return;
    };
    let context = ReplayContext { observer_session:None, session_ended:inner.dota.session_ended, manual_summary_override:inner.dota.obs_manual_summary_override };
    drop(inner); observer.submit(raw, context);
}
#[tauri::command]
pub fn dota_observer_status(app: tauri::AppHandle) -> Result<Status, String> {
    app.try_state::<Observer>().map(|o|o.status()).ok_or("observer_disabled".into())
}
#[tauri::command]
pub fn dota_observer_control(app: tauri::AppHandle, start: bool) -> Result<(), String> {
    let observer = app.try_state::<Observer>().ok_or("observer_disabled")?;
    if start { observer.start().map_err(str::to_string) } else { observer.stop(); Ok(()) }
}

#[cfg(test)]
mod tests;
