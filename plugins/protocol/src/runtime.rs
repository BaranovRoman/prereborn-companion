//! Trusted local process prototype. Own mutex/process/pipes, no AppState or TTS locks.
use crate::{read_frame, write_frame, Message, CORE_API};
use serde::Serialize;
use serde_json::{json, Value};
use std::{io::{BufReader, Read}, path::Path, process::{Command, Stdio},
    sync::{mpsc::{self, Receiver, RecvTimeoutError}, Arc, Mutex}, time::{Duration, Instant}};

#[cfg(not(windows))]
use std::process::Child;
#[cfg(windows)]
pub use crate::windows;
#[cfg(windows)]
use windows::Child;

const TIMEOUT: Duration = Duration::from_secs(2);
// Freshly installed executables can take longer to enter main than a warm
// process (measured 2.84s on macOS). Keep commands at 2s and startup bounded.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase { Stopped, Starting, Running, Failed }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    pub plugin_version: Option<String>,
    pub state: Value,
    pub events: Vec<Value>,
    pub last_error: Option<String>,
}

pub struct Runtime {
    child: Option<Child>,
    input: Option<mpsc::SyncSender<(Message, mpsc::Sender<Result<(), String>>)>>,
    output: Option<Receiver<Result<Message, String>>>,
    next_id: u64,
    snapshot: Snapshot,
    identity: Option<String>,
    process: Option<ProcessBinding>,
    #[cfg(windows)]
    spawn_generation: Option<String>,
}
#[derive(Clone,Debug,PartialEq)]
pub struct ProcessBinding {
    pub generation:String,
    pub package:crate::PackageBinding,
}
impl Default for Runtime {
    fn default() -> Self {
        Self { child: None, input: None, output: None, next_id: 0, identity: None, process:None,
            #[cfg(windows)] spawn_generation:None,
            snapshot: Snapshot { phase: Phase::Stopped, plugin_version: None,
                state: Value::Null, events: Vec::new(), last_error: None } }
    }
}
impl Runtime {
    pub fn diagnostic_process_id(&self)->Option<u32>{self.child.as_ref().map(Child::id)}
    fn reap(&mut self) {
        self.input.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            // Bounded reap. Retain the owned handle when exit cannot be confirmed.
            let deadline=Instant::now()+Duration::from_millis(250);
            loop {match child.try_wait(){Ok(Some(_))=>{self.child.take();break;},Err(_)=>break,Ok(None)=>{
                if Instant::now()>=deadline{break;}std::thread::sleep(Duration::from_millis(5));
            }}}
        }
        self.output.take();
        self.process=None;
    }
    fn fail(&mut self, error: impl Into<String>) -> String {
        let error = error.into();
        self.reap();
        self.snapshot.phase = Phase::Failed;
        self.snapshot.last_error = Some(error.clone());
        error
    }
    fn send(&mut self, message: Message) -> Result<(), String> {
        let (ack, received) = mpsc::channel();
        let result = match self.input.as_ref() {
            Some(input) => input.try_send((message, ack)).map_err(|_| "writer_unavailable".to_string())
                .and_then(|_| received.recv_timeout(TIMEOUT).map_err(|_| "write_timeout".to_string()))
                .and_then(|result| result),
            None => Err("not_running".into()),
        };
        result.map_err(|error| self.fail(format!("write_failed: {error}")))
    }

    fn receive(&mut self, deadline: Instant) -> Result<Message, String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err(self.fail("timeout")); }
        match self.output.as_ref().unwrap().recv_timeout(remaining) {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => Err(self.fail(error)),
            Err(RecvTimeoutError::Timeout) => Err(self.fail("timeout")),
            Err(RecvTimeoutError::Disconnected) => Err(self.fail("unexpected_eof")),
        }
    }
    fn update(&mut self, message: Message) -> Result<(), String> {
        match message {
            Message::State { data } => self.snapshot.state = data,
            Message::Event { name, data } => {
                if self.snapshot.events.len() == 32 { self.snapshot.events.remove(0); }
                self.snapshot.events.push(json!({"name": name, "data": data}));
            }
            Message::Error { id: None, code, message } => return Err(self.fail(format!("{code}: {message}"))),
            _ => return Err(self.fail("unexpected_message")),
        }
        Ok(())
    }
    pub fn start(&mut self, executable: &Path, args: &[String]) -> Result<Snapshot, String> {
        self.start_expected(executable, args, "hello", None)
    }
    pub fn start_expected(&mut self, executable: &Path, args: &[String], expected_id: &str, expected_version: Option<&str>) -> Result<Snapshot, String> {
        self.poll();
        if matches!(self.snapshot.phase, Phase::Running | Phase::Starting) { return Err("already_running".into()); }
        self.reap();
        if self.child.is_some(){return Err("process_fence_unproven".into());}
        self.identity = None;
        self.snapshot = Snapshot { phase: Phase::Starting, plugin_version: None,
            state: Value::Null, events: Vec::new(), last_error: None };
        // No shell, no inherited credentials/env. Executable must be explicitly supplied locally.
        let mut command = Command::new(executable);
        command.args(args).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(not(windows))]
        let spawned = command.spawn();
        #[cfg(windows)]
        let spawned = windows::spawn(&command, &self.spawn_generation.take().unwrap_or_else(||uuid::Uuid::new_v4().to_string()));
        let mut child = spawned.map_err(|e| self.fail(format!("spawn_failed: {e}")))?;
        let mut stdin = child.stdin.take().unwrap();
        let (writes, receiver) = mpsc::sync_channel::<(Message, mpsc::Sender<Result<(), String>>)>(1);
        std::thread::spawn(move || {
            while let Ok((message, ack)) = receiver.recv() {
                let result = write_frame(&mut stdin, message);
                let failed = result.is_err();
                let _ = ack.send(result);
                if failed { break; }
            }
        });
        self.input = Some(writes);
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, rx) = mpsc::sync_channel(64);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = read_frame(&mut reader);
                let fatal = message.is_err();
                let frame = match message { Ok(Some(frame)) => Ok(frame), Ok(None) => break, Err(e) => Err(e) };
                if tx.try_send(frame).is_err() || fatal { break; }
            }
        });
        // Drain continuously to prevent a noisy child blocking on a full stderr pipe.
        // No plugin stderr is forwarded to logs containing stream/account data.
        std::thread::spawn(move || { let mut buffer = [0; 4096]; while matches!(stderr.read(&mut buffer), Ok(n) if n > 0) {} });
        self.child = Some(child);
        self.output = Some(rx);
        self.send(Message::Hello { core_api: CORE_API })?;
        match self.receive(Instant::now() + HANDSHAKE_TIMEOUT)? {
            Message::Ready { id, version, min_core_api, max_core_api }
                if id == expected_id && expected_version.map_or(true, |v| v == version) && min_core_api <= CORE_API && CORE_API <= max_core_api => {
                    self.snapshot.phase = Phase::Running;
                    self.identity = Some(id);
                    self.snapshot.plugin_version = Some(version);
                    Ok(self.snapshot.clone())
                }
            Message::Ready { .. } => Err(self.fail("incompatible_plugin")),
            _ => Err(self.fail("expected_ready")),
        }
    }
    // Called while the verified manager pin is held. No public start can create this binding.
    pub fn start_verified(&mut self,pin:&impl crate::ProcessGrant)->Result<ProcessBinding,String> {
        self.start_verified_generation(pin,uuid::Uuid::new_v4().to_string())
    }
    pub fn start_verified_generation(&mut self,pin:&impl crate::ProcessGrant,generation:String)->Result<ProcessBinding,String> {
        if uuid::Uuid::parse_str(&generation).is_err(){return Err("invalid_process_generation".into());}
        let grant=pin;
        #[cfg(windows)] {self.spawn_generation=Some(generation.clone());}
        self.start_expected(grant.executable(),&["--live".into()],&grant.binding().id,Some(&grant.binding().version))?;
        let binding=ProcessBinding{generation,package:grant.binding().clone()};
        self.process=Some(binding.clone());Ok(binding)
    }
    pub fn stopped_confirmed(&mut self)->Result<(),String> {
        if let Some(child)=self.child.as_mut() {
            match child.try_wait(){Ok(Some(_))=>self.reap(),Ok(None)=>return Err("process_not_fenced".into()),Err(_)=>return Err("process_fence_unproven".into())}
        }
        Ok(())
    }
    pub fn command_live(&mut self,pin:&impl crate::ProcessGrant,binding:&ProcessBinding,name:String,args:Value,mut executor:impl FnMut(Value)->Result<Value,String>)->Result<Value,String> {
        if self.identity.as_deref()!=Some("dota2")||self.process.as_ref()!=Some(binding)||&binding.package!=pin.binding()
            ||!pin.permits("dota.match.execute")
            ||!matches!(name.as_str(),"dota.live_frame"|"dota.live_recover"|"dota.live_effects"){return Err("process_binding_denied".into());}
        self.command_with_handlers(name,args,&mut |_|Err("capability_denied".into()),Some(&mut executor))
    }
    pub fn command(&mut self, name: String, args: Value) -> Result<Value, String> {
        self.command_with_reader(name, args, |_| Err("capability_denied".into()))
    }
    pub fn command_with_reader(&mut self, name: String, args: Value, mut reader: impl FnMut(Value)->Result<Value,String>) -> Result<Value, String> {
        self.command_with_handlers(name,args,&mut reader,None)
    }
    // Fixture-only capability: never exposed through PluginManager or Tauri commands.
    #[doc(hidden)]
    pub fn command_diagnostic(&mut self,name:String,args:Value,capabilities:&[&str],mut executor:impl FnMut(Value)->Result<Value,String>)->Result<Value,String> {
        if self.identity.as_deref()!=Some("dota2") || !capabilities.contains(&"dota.diagnostic.execute")
            || !matches!(name.as_str(),"dota.diagnostic_frame"|"dota.diagnostic_recover") {return Err("capability_denied".into());}
        self.command_with_handlers(name,args,&mut |_|Err("capability_denied".into()),Some(&mut executor))
    }
    fn command_with_handlers(&mut self,name:String,args:Value,reader:&mut dyn FnMut(Value)->Result<Value,String>,mut executor:Option<&mut dyn FnMut(Value)->Result<Value,String>>)->Result<Value,String> {
        self.poll();
        if self.snapshot.phase != Phase::Running { return Err("not_running".into()); }
        let limit = if executor.is_some() {32768} else if self.identity.as_deref() == Some("dota2") && matches!(name.as_str(), "dota.replay" | "dota.watchdog_shadow") { crate::MAX_FRAME - 256 } else { 512 };
        if name.len() > 64 || serde_json::to_vec(&args).map_err(|e| e.to_string())?.len() > limit {
            return Err("command_too_large".into());
        }
        self.next_id = self.next_id.checked_add(1).ok_or("request_id_exhausted")?;
        let id = self.next_id;
        self.send(Message::Command { id, name: name.clone(), args })?;
        let deadline = Instant::now() + TIMEOUT;
        let mut read_seen = false;
        let mut execution_seen = false;
        let mut effect_count=0;
        loop {
            match self.receive(deadline)? {
                Message::MatchExecute{id:request_id,request} => {
                    if self.process.is_none()||executor.is_none()||request_id!=id||execution_seen||!matches!(name.as_str(),"dota.live_frame"|"dota.live_recover") {return Err(self.fail("live_execution_not_allowed"));}
                    execution_seen=true;
                    if serde_json::to_vec(&request).map_err(|_|"invalid_execution")?.len()>20000{return Err(self.fail("live_request_too_large"));}
                    let response=match executor.as_mut().unwrap()(request){Ok(v)=>v,Err(e)=>return Err(self.fail(e))};
                    if serde_json::to_vec(&response).map_err(|_|"invalid_receipt")?.len()>40000{return Err(self.fail("live_receipt_too_large"));}
                    self.send(Message::MatchReceipt{id,response})?;
                },
                Message::GameEffect{id:request_id,request} => {
                    if self.process.is_none()||executor.is_none()||request_id!=id||name!="dota.live_effects"||effect_count>=32 {return Err(self.fail("live_effect_not_allowed"));}
                    effect_count+=1;
                    if serde_json::to_vec(&request).map_err(|_|"invalid_effect")?.len()>2048{return Err(self.fail("effect_too_large"));}
                    let response=match executor.as_mut().unwrap()(request){Ok(v)=>v,Err(e)=>return Err(self.fail(e))};
                    if serde_json::to_vec(&response).map_err(|_|"invalid_ack")?.len()>2048{return Err(self.fail("effect_ack_too_large"));}
                    self.send(Message::GameEffectAck{id,response})?;
                },
                Message::DiagnosticExecute {id:request_id,request} => {
                    if self.identity.as_deref()!=Some("dota2") || executor.is_none() || request_id!=id || execution_seen
                        || !matches!(name.as_str(),"dota.diagnostic_frame"|"dota.diagnostic_recover") {return Err(self.fail("diagnostic_execution_not_allowed"));}
                    execution_seen=true;
                    if serde_json::to_vec(&request).map_err(|e|e.to_string())?.len()>20000 {return Err(self.fail("diagnostic_request_too_large"));}
                    let response=executor.as_mut().unwrap()(request)?;
                    if serde_json::to_vec(&response).map_err(|e|e.to_string())?.len()>40000 {return Err(self.fail("diagnostic_receipt_too_large"));}
                    self.send(Message::DiagnosticReceipt{id:request_id,response})?;
                },
                Message::CoreRead { id: read_id, request } => {
                    if self.identity.as_deref()!=Some("dota2") || name!="dota.core_read" || read_id!=id || read_seen {
                        return Err(self.fail("core_read_not_allowed"));
                    }
                    read_seen=true;
                    let response=reader(request).unwrap_or_else(|_| serde_json::json!({"kind":"error","code":"capability_denied"}));
                    if serde_json::to_vec(&response).map_err(|e|e.to_string())?.len()>8192 {return Err(self.fail("core_read_response_too_large"));}
                    self.send(Message::CoreReadReply {id:read_id,response})?;
                },
                Message::Reply { id: response_id, result } if response_id == id => return Ok(result),
                Message::Error { id: Some(response_id), code, message } if response_id == id => return Err(format!("{code}: {message}")),
                message => self.update(message)?,
            }
        }
    }
    pub fn poll(&mut self) {
        if self.snapshot.phase != Phase::Running { return; }
        // Bounded draining keeps the supervisor responsive under event floods.
        for _ in 0..64 {
            match self.output.as_ref().unwrap().try_recv() {
                Ok(Ok(message)) => if self.update(message).is_err() { return; },
                Ok(Err(error)) => { self.fail(error); return; }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => { self.fail("unexpected_eof"); return; }
            }
        }
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => { self.fail(format!("process_exited: {status}")); }
                Err(error) => { self.fail(format!("wait_failed: {error}")); }
                Ok(None) => {}
            }
        }
    }
    pub fn snapshot(&mut self) -> Snapshot { self.poll(); self.snapshot.clone() }
    pub fn stop(&mut self) -> Result<Snapshot, String> {
        if self.snapshot.phase != Phase::Running {
            self.reap(); self.stopped_confirmed()?; self.snapshot.phase = Phase::Stopped; return Ok(self.snapshot.clone());
        }
        self.send(Message::Stop)?;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match self.receive(deadline)? {
                Message::Stopped => {
                    // Reap even a child that acknowledges but forgets to exit.
                    self.reap(); self.stopped_confirmed()?; self.snapshot.phase = Phase::Stopped;
                    return Ok(self.snapshot.clone());
                }
                message => self.update(message)?,
            }
        }
    }
}
impl Drop for Runtime { fn drop(&mut self) { self.reap(); } }

#[derive(Clone)]
pub struct PluginHost(pub Arc<Mutex<Runtime>>);
impl PluginHost {
    pub fn new() -> Self {
        let runtime = Arc::new(Mutex::new(Runtime::default()));
        let weak = Arc::downgrade(&runtime);
        std::thread::spawn(move || loop {
            let Some(runtime) = weak.upgrade() else { break; };
            if let Ok(mut runtime) = runtime.lock() { runtime.poll(); }
            drop(runtime);
            std::thread::sleep(Duration::from_millis(50));
        });
        Self(runtime)
    }
}


#[cfg(all(test, unix))]
mod writer_deadline_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn child_not_reading_stdin_cannot_hold_writer_forever() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blocked-reader");
        std::fs::write(&path, "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":1,\"message\":{\"type\":\"ready\",\"id\":\"dota2\",\"version\":\"0.1.0\",\"min_core_api\":1,\"max_core_api\":1}}'\nexec /bin/sleep 30\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut runtime = Runtime::default();
        runtime.start_expected(&path, &[], "dota2", Some("0.1.0")).unwrap();
        let started = Instant::now();
        let mut error = None;
        for id in 0..16 {
            if let Err(e) = runtime.send(Message::Command { id, name:"dota.replay".into(), args:json!({"fixture":"x".repeat(60_000)}) }) { error = Some(e); break; }
        }
        assert!(error.unwrap().contains("write_timeout"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(runtime.diagnostic_process_id().is_none());
        assert_eq!(runtime.snapshot().phase, Phase::Failed);
    }
}
