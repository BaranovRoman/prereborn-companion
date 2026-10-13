//! Trusted local process prototype. Own mutex/process/pipes, no AppState or TTS locks.
use companion_plugin_protocol::{read_frame, write_frame, Message, CORE_API};
use serde::Serialize;
use serde_json::{json, Value};
use std::{io::{BufReader, Read}, path::Path, process::{Command, Stdio},
    sync::{mpsc::{self, Receiver, RecvTimeoutError}, Arc, Mutex}, time::{Duration, Instant}};

#[cfg(not(windows))]
use std::process::Child;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
use windows::Child;

const TIMEOUT: Duration = Duration::from_secs(2);

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
pub(crate) struct ProcessBinding {
    pub(crate) generation:String,
    pub(crate) package:companion_dota_domain::match_execution::PackageBinding,
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
    pub(crate) fn diagnostic_process_id(&self)->Option<u32>{self.child.as_ref().map(Child::id)}
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
        match self.receive(Instant::now() + TIMEOUT)? {
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
    pub(crate) fn start_verified(&mut self,pin:&super::plugin_manager::VerifiedMatchGrant<'_>)->Result<ProcessBinding,String> {
        self.start_verified_generation(pin,uuid::Uuid::new_v4().to_string())
    }
    pub(crate) fn start_verified_generation(&mut self,pin:&super::plugin_manager::VerifiedMatchGrant<'_>,generation:String)->Result<ProcessBinding,String> {
        if uuid::Uuid::parse_str(&generation).is_err(){return Err("invalid_process_generation".into());}
        let grant=pin.grant();
        #[cfg(windows)] {self.spawn_generation=Some(generation.clone());}
        self.start_expected(grant.executable(),&["--live".into()],&grant.binding().id,Some(&grant.binding().version))?;
        let binding=ProcessBinding{generation,package:grant.binding().clone()};
        self.process=Some(binding.clone());Ok(binding)
    }
    pub(crate) fn stopped_confirmed(&mut self)->Result<(),String> {
        if let Some(child)=self.child.as_mut() {
            match child.try_wait(){Ok(Some(_))=>self.reap(),Ok(None)=>return Err("process_not_fenced".into()),Err(_)=>return Err("process_fence_unproven".into())}
        }
        Ok(())
    }
    pub(crate) fn command_live(&mut self,pin:&super::plugin_manager::VerifiedMatchGrant<'_>,binding:&ProcessBinding,name:String,args:Value,mut executor:impl FnMut(Value)->Result<Value,String>)->Result<Value,String> {
        if self.identity.as_deref()!=Some("dota2")||self.process.as_ref()!=Some(binding)||&binding.package!=pin.grant().binding()
            ||!pin.grant().permits(companion_dota_domain::match_execution::MATCH_EXECUTION_CAPABILITY)
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
    #[cfg(test)]
    pub(crate) fn command_diagnostic(&mut self,name:String,args:Value,capabilities:&[&str],mut executor:impl FnMut(Value)->Result<Value,String>)->Result<Value,String> {
        if self.identity.as_deref()!=Some("dota2") || !capabilities.contains(&companion_dota_domain::match_execution::DIAGNOSTIC_CAPABILITY)
            || !matches!(name.as_str(),"dota.diagnostic_frame"|"dota.diagnostic_recover") {return Err("capability_denied".into());}
        self.command_with_handlers(name,args,&mut |_|Err("capability_denied".into()),Some(&mut executor))
    }
    fn command_with_handlers(&mut self,name:String,args:Value,reader:&mut dyn FnMut(Value)->Result<Value,String>,mut executor:Option<&mut dyn FnMut(Value)->Result<Value,String>>)->Result<Value,String> {
        self.poll();
        if self.snapshot.phase != Phase::Running { return Err("not_running".into()); }
        let limit = if executor.is_some() {32768} else if self.identity.as_deref() == Some("dota2") && matches!(name.as_str(), "dota.replay" | "dota.watchdog_shadow") { companion_plugin_protocol::MAX_FRAME - 256 } else { 512 };
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn dota_replay_uses_existing_runtime_and_never_mutates_stream_state() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/target/debug")
            .join(if cfg!(windows) { "companion-dota-plugin.exe" } else { "companion-dota-plugin" });
        assert!(path.is_file(), "Build the independent Dota plugin first");
        let app = crate::state::AppState::new(); let before = serde_json::to_value(app.snapshot()).unwrap();
        let mut runtime = Runtime::default(); runtime.start_expected(&path, &[], "dota2", Some("0.1.0")).unwrap();
        let items: serde_json::Map<String, Value> = (0..16).map(|i| (format!("slot{i}"), json!({"name":"item_tango","charges":3}))).collect();
        let input = json!({"sequence":1,"observedAtMs":100,"snapshot":{"hero":{"id":105},"items":items}});
        assert!(serde_json::to_vec(&input).unwrap().len() > 512);
        let result = runtime.command("dota.replay".into(), input.clone()).unwrap();
        assert_eq!(result["mode"], "replay_only"); assert_eq!(result["sideEffects"], false);
        assert!(runtime.command("dota.replay".into(), input).unwrap_err().contains("replay_sequence_not_increasing"));
        assert_eq!(runtime.snapshot().phase, Phase::Running);
        assert_eq!(runtime.command("obs.switch".into(), json!({})).unwrap_err(), "unsupported_replay_command: Live APIs are not connected");
        runtime.stop().unwrap();
        assert_eq!(serde_json::to_value(app.snapshot()).unwrap(), before);
    }
    #[test] fn dota_read_api_round_trip_is_gated_and_sanitized() {
        use companion_dota_domain::core_read::*;
        let path=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/target/debug").join(if cfg!(windows){"companion-dota-plugin.exe"}else{"companion-dota-plugin"});
        let app=crate::state::AppState::new(); let history=crate::local_runtime::LocalRuntimeState::new();
        {let mut inner=app.0.lock().unwrap();inner.core.companion_token=Some("SECRET".into());inner.dota.obs_config.password="SECRET".into();inner.dota.obs_connected=true;}
        let mut runtime=Runtime::default();runtime.start_expected(&path,&[],"dota2",Some("0.1.0")).unwrap();
        let denied=runtime.command("dota.core_read".into(),json!({"query":"obs"})).unwrap();assert_eq!(denied["code"],"capability_denied");
        for query in [ReadRequest::Obs,ReadRequest::Scenes,ReadRequest::Stream,ReadRequest::Sounds,ReadRequest::Backend,ReadRequest::History{limit:1}] {
            let result=runtime.command_with_reader("dota.core_read".into(),serde_json::to_value(query).unwrap(),|q|Ok(serde_json::to_value(crate::core::plugin_read::read(&app,&history,DOTA_READ_GRANTS,serde_json::from_value(q).unwrap())).unwrap())).unwrap();
            assert!(!result.to_string().contains("SECRET"));assert!(result.to_string().len()<8192);
        }
        assert!(runtime.command("dota.core_read".into(),json!({"query":"history","limit":21})).unwrap_err().contains("invalid_read_request"));runtime.stop().unwrap();
        runtime.start(&binary(),&[]).unwrap();
        assert!(runtime.command_with_reader("dota.core_read".into(),json!({"query":"obs"}),|_|panic!("Hello gained access")).is_err());runtime.stop().unwrap();
    }
    fn binary() -> std::path::PathBuf {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../plugins/target/debug")
            .join(if cfg!(windows) { "companion-hello-plugin.exe" } else { "companion-hello-plugin" });
        assert!(path.exists(), "Build plugins workspace before host tests: {}", path.display());
        path
    }
    #[test]
    fn lifecycle_commands_events_errors_stop_and_restart() {
        let host = PluginHost::new();
        let mut runtime = host.0.lock().unwrap();
        assert_eq!(runtime.start(&binary(), &[]).unwrap().phase, Phase::Running);
        assert_eq!(runtime.start(&binary(), &[]).unwrap_err(), "already_running");
        assert!(runtime.command("unknown".into(), Value::Null).unwrap_err().contains("unknown_command"));
        assert_eq!(runtime.command("greet".into(), json!({"text":"test"})).unwrap()["text"], "Hello, test!");
        let state = runtime.snapshot();
        assert_eq!(state.state["greetings"], 1);
        assert_eq!(state.events[0]["name"], "greeted");
        assert_eq!(runtime.stop().unwrap().phase, Phase::Stopped);
        assert_eq!(runtime.stop().unwrap().phase, Phase::Stopped);
        assert_eq!(runtime.start(&binary(), &[]).unwrap().phase, Phase::Running);
        assert!(runtime.command("crash".into(), Value::Null).is_err());
        assert_eq!(runtime.snapshot().phase, Phase::Failed);
        assert_eq!(runtime.start(&binary(), &[]).unwrap().phase, Phase::Running);
        runtime.stop().unwrap();
    }
    #[test]
    fn failed_launch_and_handshake_are_reaped_and_restartable() {
        let mut runtime = Runtime::default();
        assert!(runtime.start(Path::new("/nonexistent-companion-plugin"), &[]).unwrap_err().starts_with("spawn_failed"));
        assert_eq!(runtime.start_expected(&binary(), &[], "wrong-id", None).unwrap_err(), "incompatible_plugin");
        assert_eq!(runtime.start_expected(&binary(), &[], "hello", Some("9.9.9")).unwrap_err(), "incompatible_plugin");
        assert!(runtime.child.is_none());
        for (mode, error) in [("incompatible", "incompatible_plugin"), ("protocol", "incompatible_protocol"),
            ("malformed", "invalid_frame"), ("exit", "unexpected_eof"), ("hang", "timeout")] {
            assert_eq!(runtime.start(&binary(), &[mode.into()]).unwrap_err(), error);
            assert_eq!(runtime.snapshot().phase, Phase::Failed);
            assert!(runtime.child.is_none());
        }
        runtime.start(&binary(), &[]).unwrap();
        assert_eq!(runtime.command("hang".into(), Value::Null).unwrap_err(), "timeout");
        assert!(runtime.child.is_none());
        runtime.start(&binary(), &[]).unwrap();
        runtime.stop().unwrap();
    }
    #[test]
    fn process_failure_does_not_touch_core_or_dota_and_supervisor_observes_exit() {
        let app = crate::state::AppState::new();
        app.0.lock().unwrap().core.twitch_chat = Some(json!({"connected":true}));
        let before = serde_json::to_value(app.snapshot()).unwrap();
        let host = PluginHost::new();
        host.0.lock().unwrap().start(&binary(), &[]).unwrap();
        host.0.lock().unwrap().child.as_mut().unwrap().kill().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(host.0.lock().unwrap().snapshot.phase, Phase::Failed);
        assert_eq!(serde_json::to_value(app.snapshot()).unwrap(), before);
        assert_eq!(app.0.lock().unwrap().core.twitch_chat, Some(json!({"connected":true})));
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
        assert!(runtime.child.is_none());
        assert_eq!(runtime.snapshot().phase, Phase::Failed);
    }
}

#[cfg(all(test,unix))]
mod diagnostic_security_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    const CAP:&str=companion_dota_domain::match_execution::DIAGNOSTIC_CAPABILITY;
    fn attacker(dir:&tempfile::TempDir,identity:&str,reverse_id:u64,repeat:bool)->std::path::PathBuf {
        let path=dir.path().join("adversarial-ipc");
        let ready=json!({"protocol":1,"message":{"type":"ready","id":identity,"version":"0.1.0","min_core_api":1,"max_core_api":1}});
        let request=json!({"protocol":1,"message":{"type":"diagnostic_execute","id":reverse_id,"request":{}}});
        let repeat=if repeat{format!("read line\nprintf '%s\\n' '{request}'\n")}else{String::new()};
        std::fs::write(&path,format!("#!/bin/sh\nread line\nprintf '%s\\n' '{ready}'\nread line\nprintf '%s\\n' '{request}'\n{repeat}read line\n")).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();path
    }
    #[test]
    fn reverse_execution_requires_host_capability_identity_command_and_single_correlation() {
        for (identity,name,grant,id,repeat,calls) in [
            ("hello","dota.diagnostic_frame",true,1,false,0),
            ("dota2","dota.diagnostic_frame",false,1,false,0),
            ("dota2","dota.replay",false,1,false,0),
            ("dota2","dota.diagnostic_frame",true,99,false,0),
            ("dota2","dota.diagnostic_frame",true,1,true,1),
        ] {
            let dir=tempfile::tempdir().unwrap();let path=attacker(&dir,identity,id,repeat);let mut runtime=Runtime::default();runtime.start_expected(&path,&[],identity,Some("0.1.0")).unwrap();let mut observed=0;
            let result=if grant {runtime.command_diagnostic(name.into(),json!({}),&[CAP],|_|{observed+=1;Ok(json!({"kind":"denied","code":"fixture_denied"}))})}
                else if name=="dota.replay" {runtime.command(name.into(),json!({}))}
                else {runtime.command_diagnostic(name.into(),json!({}),&[],|_|panic!("missing capability invoked executor"))};
            assert!(result.is_err());assert_eq!(observed,calls);let _=runtime.stop();runtime.stop().unwrap();assert!(runtime.child.is_none());
        }
    }
    #[test]
    fn hello_cannot_negotiate_execution_rights_or_send_reverse_request() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("invalid-handshake");
        for message in [json!({"type":"diagnostic_execute","id":1,"request":{}}),json!({"type":"ready","id":"dota2","version":"0.1.0","min_core_api":1,"max_core_api":1,"capabilities":[CAP]})] {
            std::fs::write(&path,format!("#!/bin/sh\nread line\nprintf '%s\\n' '{}'\nread line\n",json!({"protocol":1,"message":message}))).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();let mut runtime=Runtime::default();assert!(runtime.start_expected(&path,&[],"dota2",Some("0.1.0")).is_err());assert!(runtime.child.is_none());
        }
    }
}
