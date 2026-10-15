//! Explicit debug-only observer. No listener, storage, grants or effect dispatcher.
//! Ingest only projects bounded fields and try-locks a bounded mailbox; IPC lives on its own thread.
use std::{collections::VecDeque, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant}};
use companion_dota_domain::{contracts::{ReplayContext, ReplayInput}, events::{self, PendingConfirmations}, broadcast_state::{self, BroadcastState}, gsi};
use serde::Serialize;
use companion_dota_domain::match_shadow::{self, Analysis, Context as MatchInput};
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

mod projection;
pub use projection::project;

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
        let mut result=result;
        if let Some(context)=&input.match_context {result["matchAnalysis"]=serde_json::to_value(match_shadow::analyze(context,&input.snapshot,input.sequence)).unwrap();}
        result
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct MatchParity {
    state: &'static str, reason: Option<&'static str>, matched:u64, mismatched:u64, inconclusive:u64,
    legacy:Option<Analysis>, external:Option<Analysis>, captured_at:Option<chrono::DateTime<chrono::Utc>>,
    #[serde(skip)] generation:u64,
}
impl Default for MatchParity {fn default()->Self{Self{state:"inconclusive",reason:Some("no_context"),matched:0,mismatched:0,inconclusive:0,legacy:None,external:None,captured_at:None,generation:0}}}
impl MatchParity {
    fn record(&mut self,legacy:Option<Analysis>,actual:Option<Analysis>,reason:Option<&'static str>,watchdog:bool) {
        let comparable=legacy.as_ref().is_some_and(|a|a.conclusive && if watchdog{a.watchdog.is_some()}else{a.detector.is_some()});
        if reason.is_some()||!comparable {
            self.state="inconclusive";self.reason=reason.or(Some("no_context_or_game_state"));self.inconclusive+=1;
        } else {
            let equal=match(&legacy,&actual){(Some(a),Some(b)) if b.conclusive=>if watchdog{a.watchdog==b.watchdog}else{a.detector==b.detector},_=>false};
            if equal{self.state="matched";self.reason=None;self.matched+=1;}else{self.state="mismatched";self.reason=Some("semantic_decision_difference");self.mismatched+=1;}
        }
        self.legacy=legacy;self.external=actual;
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status {
    last_context_at:Option<chrono::DateTime<chrono::Utc>>, reconnects:u64,
    phase: &'static str, received: u64, sent: u64, processed: u64, lost: u64,
    last_sequence: u64, parity_mismatches: u64, resets: u64,
    detector_parity: MatchParity, watchdog_parity: MatchParity,
    last_error: Option<&'static str>, last_analysis: Option<Value>, last_mismatch_fields: Vec<&'static str>,
}
impl Default for Status {
    fn default() -> Self { Self { last_context_at:None,reconnects:0,phase:"stopped", received:0, sent:0, processed:0, lost:0, last_sequence:0, parity_mismatches:0, resets:0, last_error:None, last_analysis:None, last_mismatch_fields:Vec::new(), detector_parity:MatchParity::default(),watchdog_parity:MatchParity::default() } }
}
struct Frame { generation: u64, input: ReplayInput, watchdog_only:bool }
struct Shared {
    queue: Mutex<VecDeque<Frame>>, status: Mutex<Status>, wanted: AtomicBool,
    generation: AtomicU64, sequence: AtomicU64, lost: AtomicU64, sent: AtomicU64,
    last_time: AtomicU64, reconnects:AtomicU64, origin: Instant,
}
#[derive(Clone)]
pub struct Observer(Arc<Shared>);
impl Observer {
    pub fn new(executable: PathBuf) -> Self {
        let shared = Arc::new(Shared { queue:Mutex::new(VecDeque::with_capacity(CAPACITY)), status:Mutex::new(Status::default()),
            wanted:AtomicBool::new(false), generation:AtomicU64::new(1), sequence:AtomicU64::new(0), lost:AtomicU64::new(0), sent:AtomicU64::new(0), last_time:AtomicU64::new(0), reconnects:AtomicU64::new(0), origin:Instant::now() });
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
                let Some(mut frame) = frame else { drop(shared); std::thread::sleep(Duration::from_millis(10)); continue; };
                if frame.generation != shared.generation.load(Ordering::SeqCst) {
                    shared.lost.fetch_add(1, Ordering::SeqCst); continue;
                }
                if frame.input.sequence <= last_sequence || last_at.is_some_and(|t| frame.input.observed_at_ms < t) {
                    shared.lost.fetch_add(1, Ordering::SeqCst); shared.generation.fetch_add(1, Ordering::SeqCst);
                    shared.status.lock().unwrap().last_error = Some("out_of_order_frame"); continue;
                }
                let legacy_match=frame.input.match_context.as_ref().map(|context|match_shadow::analyze(context,&frame.input.snapshot,frame.input.sequence));
                let reset=frame.generation != generation;
                let stale=frame.input.match_context.as_ref().is_some_and(|c|(chrono::Utc::now()-c.captured_at).num_milliseconds().abs()>5000);
                let inconclusive=if reset{Some("history_reset")}else if stale{Some("stale_context")}else if frame.input.match_context.as_ref().is_some_and(|c|c.inconclusive_reason.is_some()){Some("legacy_context_uncertain")}else{None};
                if let Some(context)=&mut frame.input.match_context {if let Some(reason)=inconclusive{context.inconclusive_reason=Some(reason.into());}}
                if reset {
                    if let Err(error) = runtime.command("dota.reset".into(), json!({})) { shared.lost.fetch_add(1, Ordering::SeqCst); let _ = runtime.stop(); active = false; Self::failed(&shared, ipc_error(&error)); continue; }
                    reference = Reference::default(); generation = frame.generation;
                    shared.status.lock().unwrap().resets += 1;
                }
                let expected = if frame.watchdog_only {
                    json!({"matchAnalysis":match_shadow::analyze(frame.input.match_context.as_ref().unwrap(),&frame.input.snapshot,frame.input.sequence)})
                } else {reference.apply(&frame.input)};
                last_sequence = frame.input.sequence; last_at = Some(frame.input.observed_at_ms);
                shared.sent.fetch_add(1, Ordering::SeqCst);
                let (command,args)=if frame.watchdog_only {("dota.watchdog_shadow",serde_json::to_value(frame.input.match_context.as_ref().unwrap()).unwrap())}else{("dota.replay",serde_json::to_value(&frame.input).unwrap())};
                match runtime.command(command.into(), args) {
                    Ok(actual) => {
                        if frame.generation != shared.generation.load(Ordering::SeqCst) || !shared.wanted.load(Ordering::SeqCst) {
                            shared.lost.fetch_add(1, Ordering::SeqCst); continue;
                        }
                        let mut status = shared.status.lock().unwrap();
                        status.processed += 1; status.last_sequence = frame.input.sequence;
                        let actual_match=actual.get("matchAnalysis").filter(|v|serde_json::to_vec(v).is_ok_and(|b|b.len()<=8192))
                            .and_then(|v|serde_json::from_value::<Analysis>(v.clone()).ok()).filter(|a|a.is_bounded());
                        if !frame.watchdog_only {
                            status.detector_parity.record(legacy_match.clone(),actual_match.clone(),inconclusive,false);
                            status.detector_parity.generation=frame.generation;
                            status.detector_parity.captured_at=frame.input.match_context.as_ref().map(|c|c.captured_at);
                        }
                        status.watchdog_parity.record(legacy_match,actual_match,inconclusive,true);
                        status.watchdog_parity.generation=frame.generation;
                        status.watchdog_parity.captured_at=frame.input.match_context.as_ref().map(|c|c.captured_at);
                        status.last_context_at=frame.input.match_context.as_ref().map(|c|c.captured_at);
                        if actual != expected {
                            status.parity_mismatches += 1; status.last_error = Some("parity_mismatch");
                            status.last_mismatch_fields = ["sequence", "broadcastState", "soundSignals", "inMatch", "postGame", "heroId", "matchId", "mode", "sideEffects", "matchAnalysis"]
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
    pub fn active(&self)->bool {self.0.wanted.load(Ordering::SeqCst)}
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
        for parity in [&mut status.detector_parity,&mut status.watchdog_parity] {
            if parity.generation!=self.0.generation.load(Ordering::SeqCst) {
                parity.state="inconclusive";parity.reason=Some("reset_or_reconnect_pending");
            } else if parity.captured_at.is_some_and(|at|(chrono::Utc::now()-at).num_milliseconds().abs()>5000) {
                parity.state="inconclusive";parity.reason=Some("stale_context");
            }
        }
        status.reconnects=self.0.reconnects.load(Ordering::SeqCst);
        status.received = self.0.sequence.load(Ordering::SeqCst); status.sent = self.0.sent.load(Ordering::SeqCst); status.lost = self.0.lost.load(Ordering::SeqCst); status
    }
    #[cfg(test)]
    pub fn submit(&self, raw:&Value,context:ReplayContext) {self.submit_bound(raw,context,None,false);}
    pub fn submit_watchdog(&self,context:MatchInput) {self.submit_bound(&json!({}),ReplayContext::default(),Some(context),true);}
    fn submit_bound(&self, raw: &Value, mut context: ReplayContext, mut match_context:Option<MatchInput>, watchdog_only:bool) {
        if !self.0.wanted.load(Ordering::SeqCst) { return; }
        let sequence = self.0.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let at = self.0.origin.elapsed().as_millis() as u64;
        if !watchdog_only {
            let last = self.0.last_time.swap(at, Ordering::SeqCst);
            if at.saturating_sub(last) > RECONNECT_MS { self.0.generation.fetch_add(1, Ordering::SeqCst);self.0.reconnects.fetch_add(1,Ordering::SeqCst); }
        }
        let snapshot = match project(raw) { Ok(snapshot) => snapshot, Err(code) => {
            self.0.lost.fetch_add(1, Ordering::SeqCst); self.0.generation.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut status)=self.0.status.try_lock(){status.last_error=Some(code);} return;
        } };
        let Ok(mut queue) = self.0.queue.try_lock() else { self.0.lost.fetch_add(1, Ordering::SeqCst); self.0.generation.fetch_add(1, Ordering::SeqCst); return; };
        if queue.len() == CAPACITY {
            self.0.lost.fetch_add(queue.len() as u64, Ordering::SeqCst); queue.clear(); self.0.generation.fetch_add(1, Ordering::SeqCst);
        }
        let generation = self.0.generation.load(Ordering::SeqCst);
        context.observer_session = Some(generation);
        if let Some(captured)=&mut match_context {captured.frame_sequence=sequence;}
        queue.push_back(Frame { generation, watchdog_only, input:ReplayInput { sequence, observed_at_ms:at, snapshot, context, match_context } });
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

pub fn forward_with_context(app: &tauri::AppHandle, raw: &Value, captured:Option<MatchInput>) {
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
    drop(inner); observer.submit_bound(raw, context, captured,false);
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
