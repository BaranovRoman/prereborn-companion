use std::{io::BufReader, process::{Child, ChildStdin, Command, Stdio}, sync::mpsc, time::Duration};
use companion_plugin_protocol::{read_frame,write_frame,Message,CORE_API};
use serde_json::json;
struct Process { child: Child, input: ChildStdin, messages: mpsc::Receiver<Result<Option<Message>,String>> }
impl Process {
    fn new(args:&[&str])->Self {
        let mut child=Command::new(env!("CARGO_BIN_EXE_companion-dota-plugin")).args(args).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let input=child.stdin.take().unwrap(); let stdout=child.stdout.take().unwrap(); let(tx,messages)=mpsc::channel();
        std::thread::spawn(move||{let mut reader=BufReader::new(stdout); loop {let frame=read_frame(&mut reader); let end=!matches!(frame,Ok(Some(_))); if tx.send(frame).is_err()||end {break;}}});
        Self {child,input,messages}
    }
    fn send(&mut self,message:Message){write_frame(&mut self.input,message).unwrap();}
    fn receive(&self)->Message{self.messages.recv_timeout(Duration::from_secs(2)).unwrap().unwrap().unwrap()}
    fn exited(&mut self)->std::process::ExitStatus {
        let until=std::time::Instant::now()+Duration::from_secs(2);
        loop {if let Some(status)=self.child.try_wait().unwrap(){return status;}
            assert!(std::time::Instant::now()<until,"worker did not exit");std::thread::sleep(Duration::from_millis(10));}
    }
}
impl Drop for Process {fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}

struct Pin{binding:companion_plugin_protocol::PackageBinding,exe:std::path::PathBuf,capabilities:Vec<String>}
impl companion_plugin_protocol::ProcessGrant for Pin{
    fn binding(&self)->&companion_plugin_protocol::PackageBinding{&self.binding}
    fn executable(&self)->&std::path::Path{&self.exe}
    fn permits(&self,cap:&str)->bool{self.capabilities.iter().any(|c|c==cap)}
}
fn launch_bound_worker(root:&std::path::Path,capabilities:&[&str])->(companion_plugin_protocol::runtime::Runtime,Pin,companion_plugin_protocol::runtime::ProcessBinding){
    use sha2::{Digest,Sha256};
    use companion_plugin_protocol::{runtime::Runtime,PackageBinding};
    let mut exe=std::path::PathBuf::from(env!("CARGO_BIN_EXE_companion-dota-plugin"));
    let hash=format!("{:x}",Sha256::digest(std::fs::read(&exe).unwrap()));
    let mut binding=PackageBinding{id:"dota2".into(),version:env!("CARGO_PKG_VERSION").into(),executable_hash:hash,manifest_hash:"b".repeat(64)};
    if capabilities.contains(&"overlay.publish"){
        // Actual installed layout/parser/hash checks with fixture assets only;
        // this is not proof of native OBS rendering or a signed distribution.
        let package=root.join(".package-fixture");std::fs::create_dir_all(package.join("bin")).unwrap();std::fs::create_dir_all(package.join("ui/overlay")).unwrap();
        let name=if cfg!(windows){"bin/worker.exe"}else{"bin/worker"};let copied=package.join(name);std::fs::copy(&exe,&copied).unwrap();exe=copied;
        let ui=b"<!doctype html><title>overlay unit fixture</title>";
        std::fs::write(package.join("ui/index.html"),ui).unwrap();std::fs::write(package.join("ui/overlay/index.html"),ui).unwrap();
        let ui_hash=format!("{:x}",Sha256::digest(ui));
        let manifest:companion_plugin_manager::Manifest=serde_json::from_value(json!({"schema":1,"id":"dota2","name":"Dota 2 fixture","description":"test only","version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"execution":"live","minApi":2,"maxApi":2,"executable":name,"ui":"ui/index.html","permissions":capabilities,"files":{(name):binding.executable_hash,"ui/index.html":ui_hash,"ui/overlay/index.html":ui_hash}})).unwrap();
        let doc=serde_json::to_vec(&manifest).unwrap();std::fs::write(package.join("manifest.json"),&doc).unwrap();binding.manifest_hash=format!("{:x}",Sha256::digest(doc));
    }
    let generation=uuid::Uuid::new_v4().to_string();
    let args=vec!["--worker".into(),json!({"dataRoot":root,"generation":generation,"package":binding,"capabilities":capabilities}).to_string()];
    let pin=Pin{binding,exe,capabilities:capabilities.iter().map(|s|(*s).into()).collect()};
    let mut runtime=Runtime::default();let process=runtime.start_verified_args(&pin,generation,&args).unwrap();(runtime,pin,process)
}
fn launch_installed_worker(root:&std::path::Path,capabilities:&[&str])->companion_plugin_protocol::runtime::Runtime{launch_bound_worker(root,capabilities).0}
#[test]
fn stale_verified_task_is_rejected_before_it_can_send_a_command_to_the_current_process(){
    let root=tempfile::tempdir().unwrap();let (mut runtime,pin,binding)=launch_bound_worker(root.path(),&["ui","data.legacy"]);
    let mut stale=binding.clone();stale.generation=uuid::Uuid::new_v4().to_string();
    assert_eq!(runtime.command_verified(&pin,&stale,"host.prepare".into(),json!({})).unwrap_err(),"process_binding_denied");
    assert!(!root.path().join("local-runtime.sqlite3").exists());assert_eq!(runtime.snapshot().phase,companion_plugin_protocol::runtime::Phase::Running);
    assert_eq!(runtime.command_verified(&pin,&binding,"host.prepare".into(),json!({})).unwrap()["prepared"],true);
    runtime.stop().unwrap();runtime.stopped_confirmed().unwrap();
}
#[test]
fn installed_worker_uses_real_ipc_for_manual_idempotent_preparation_and_keeps_launch_authority_out_of_commands(){
    let root=tempfile::tempdir().unwrap();let mut runtime=launch_installed_worker(root.path(),&["data.legacy"]);
    assert_eq!(runtime.command("host.status".into(),json!({})).unwrap()["prepared"],false);
    assert!(!root.path().join("local-runtime.sqlite3").exists());
    let denied=runtime.command("host.prepare".into(),json!({"dataRoot":"untrusted"})).unwrap_err();assert!(denied.starts_with("unexpected_command_payload"));
    assert_eq!(runtime.command("host.status".into(),json!({})).unwrap()["prepared"],false);
    let prepared=runtime.command("host.prepare".into(),json!({})).unwrap();
    assert_eq!(prepared["prepared"],true);assert_eq!(prepared["active"],false);assert_eq!(prepared["session"],serde_json::Value::Null);
    let backup_path=root.path().join("local-runtime.pre-external.sqlite3");let backup=std::fs::read(&backup_path).unwrap();
    assert_eq!(runtime.command("host.prepare".into(),json!({})).unwrap()["active"],false);
    assert_eq!(std::fs::read(backup_path).unwrap(),backup);
    runtime.stop().unwrap();runtime.stopped_confirmed().unwrap();
}
#[test]
fn ui_only_grant_cannot_prepare_or_acquire_data_rights_through_command_args(){
    let root=tempfile::tempdir().unwrap();let mut runtime=launch_installed_worker(root.path(),&["ui"]);
    assert!(runtime.command("host.prepare".into(),json!({})).unwrap_err().starts_with("capability_denied"));
    assert!(runtime.command("host.prepare".into(),json!({"capabilities":["data.legacy"]})).unwrap_err().starts_with("unexpected_command_payload"));
    assert!(!root.path().join("local-runtime.sqlite3").exists());runtime.stop().unwrap();runtime.stopped_confirmed().unwrap();
}

// Actual Windows job + localhost HTTP + IPC + temporary real SQLite. This is
// not a Dota game, OBS or native WebView playback smoke test.
#[cfg(windows)]
#[test]
fn supervised_worker_accepts_fresh_demo_and_bot_gsi_without_obs_and_reopens_the_same_session(){
    use std::{io::{Read,Write},net::TcpStream,time::Instant};
    fn send(value:&serde_json::Value){
        let body=value.to_string();let mut stream=TcpStream::connect("127.0.0.1:3665").unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        write!(stream,"POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
        let mut response=String::new();stream.read_to_string(&mut response).unwrap();assert!(response.starts_with("HTTP/1.1 200"));
    }
    fn overlay(path:&str)->String{
        let mut stream=TcpStream::connect("127.0.0.1:3666").unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        write!(stream,"GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();let mut response=String::new();stream.read_to_string(&mut response).unwrap();assert!(response.starts_with("HTTP/1.1 200"));response.split_once("\r\n\r\n").unwrap().1.into()
    }
    fn poll(runtime:&mut companion_plugin_protocol::runtime::Runtime,n:u64)->serde_json::Value{
        let until=Instant::now()+Duration::from_secs(3);loop{
            let response=runtime.command("host.poll".into(),json!({})).unwrap();
            if response["status"]["processed"].as_u64().unwrap()>=n{return response;}
            assert!(Instant::now()<until,"GSI was not processed");std::thread::sleep(Duration::from_millis(10));
        }
    }
    let root=tempfile::tempdir().unwrap();std::fs::create_dir(root.path().join("sounds")).unwrap();
    std::fs::write(root.path().join("sounds/jump.wav"),b"RIFFtestWAVE").unwrap();
    std::fs::write(root.path().join("game-sounds-config.json"),json!({"schemaVersion":1,"enabled":true,"masterVolume":63,"bindings":[{"eventId":"techies_suicide","kind":"abilityCast","assetId":"jump"}],"assets":[{"id":"jump","fileName":"jump.wav","originalName":"jump.wav","sizeBytes":12}]}).to_string()).unwrap();
    let caps=["ui","data.legacy","audio.play","overlay.publish"];
    let mut runtime=launch_installed_worker(root.path(),&caps);
    assert!(runtime.command("host.activate".into(),json!({})).unwrap_err().starts_with("not_prepared"));
    runtime.command("host.prepare".into(),json!({})).unwrap();
    let status=runtime.command("host.activate".into(),json!({})).unwrap();assert_eq!(status["awaitingSession"],true);assert_eq!(status["active"],true);
    assert_eq!(status["overlay"]["running"],true);assert!(overlay("/overlay").contains("overlay unit fixture"));
    let empty:serde_json::Value=serde_json::from_str(&overlay("/overlay/state")).unwrap();assert_eq!(empty["session"]["hasSession"],false);
    assert!(runtime.command("host.activate".into(),json!({})).unwrap_err().starts_with("already_active"));
    let mut raw:serde_json::Value=serde_json::from_str(include_str!("../../dota-domain/src/fixtures/techies-inventory.json")).unwrap();
    raw["map"]["matchid"]=json!("0");raw["map"]["customgamename"]=json!("hero_demo");raw["abilities"]["ability2"]["cooldown"]=json!(0);
    send(&raw);let first=poll(&mut runtime,1);assert_eq!(first["status"]["session"],serde_json::Value::Null);assert_eq!(first["soundIntents"],json!([]));
    raw["abilities"]["ability2"]["cooldown"]=json!(25);send(&raw);let demo=poll(&mut runtime,2);
    assert_eq!(demo["status"]["session"],serde_json::Value::Null);assert_eq!(demo["soundIntents"].as_array().unwrap().len(),1);assert_eq!(demo["soundIntents"][0]["assetFile"],"jump.wav");
    send(&raw);assert_eq!(poll(&mut runtime,3)["soundIntents"],json!([]));
    raw["map"]["customgamename"]=json!("");send(&raw);let bots=poll(&mut runtime,4);
    let session=bots["status"]["session"].as_str().unwrap().to_string();assert_eq!(bots["status"]["awaitingSession"],false);
    let state:serde_json::Value=serde_json::from_str(&overlay("/overlay/state")).unwrap();assert_eq!(state["scene"],"gameplay");assert_eq!(state["session"]["hasSession"],true);assert_eq!(state["session"]["currentMatch"]["heroId"],105);
    assert_eq!(bots["status"]["receipt"]["session"]["localId"],session);
    let epoch=bots["status"]["epoch"].as_u64().unwrap();
    runtime.command("host.stop".into(),json!({})).unwrap();runtime.stop().unwrap();runtime.stopped_confirmed().unwrap();
    let mut runtime=launch_installed_worker(root.path(),&caps);assert_eq!(runtime.command("host.status".into(),json!({})).unwrap()["active"],false);
    runtime.command("host.prepare".into(),json!({})).unwrap();let resumed=runtime.command("host.activate".into(),json!({})).unwrap();
    assert_eq!(resumed["session"],session);assert!(resumed["epoch"].as_u64().unwrap()>epoch);
    send(&raw);assert_eq!(poll(&mut runtime,1)["soundIntents"],json!([]));
    runtime.command("host.stop".into(),json!({})).unwrap();runtime.stop().unwrap();runtime.stopped_confirmed().unwrap();
    let c=rusqlite::Connection::open(root.path().join("local-runtime.sqlite3")).unwrap();
    assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
#[test] fn actual_process_analyzes_replay_and_refuses_live_commands() {
    let mut p=Process::new(&[]); p.send(Message::Hello {core_api:CORE_API});
    assert!(matches!(p.receive(),Message::Ready{id,..} if id=="dota2"));
    assert!(matches!(p.receive(),Message::State{data} if data["sideEffects"]==false));
    for(seq,charges) in [(1,3),(2,2)] {
        p.send(Message::Command{id:seq,name:"dota.replay".into(),args:json!({"sequence":seq,"observedAtMs":seq*100,"snapshot":{"hero":{"id":105},"items":{"slot0":{"name":"item_tango","charges":charges}}}})});
        assert!(matches!(p.receive(),Message::Event{name,..} if name=="dota.replay_analysis"));
        assert!(matches!(p.receive(),Message::State{data} if data["mode"]=="replay_only"));
        let Message::Reply{id,result}=p.receive() else {panic!("expected reply")}; assert_eq!(id,seq);
        assert_eq!(result["soundSignals"].as_array().unwrap().len(),if seq==2 {1}else{0});
    }
    p.send(Message::Command{id:8,name:"dota.replay".into(),args:json!({"sequence":3,"observedAtMs":300,"snapshot":{"auth":{"token":"redacted"}}})});
    assert!(matches!(p.receive(),Message::Error{code,..} if code=="invalid_replay_input"));
    p.send(Message::Command{id:3,name:"obs.switch".into(),args:json!({})});
    assert!(matches!(p.receive(),Message::Error{code,..} if code=="unsupported_replay_command"));
    p.send(Message::Command{id:4,name:"dota.replay".into(),args:json!({"sequence":2,"observedAtMs":200,"snapshot":{}})});
    assert!(matches!(p.receive(),Message::Error{code,..} if code=="replay_sequence_not_increasing"));
    p.send(Message::Command{id:5,name:"dota.reset".into(),args:json!({})}); assert!(matches!(p.receive(),Message::Reply{id:5,..}));
    p.send(Message::Stop); assert!(matches!(p.receive(),Message::Stopped)); assert!(p.exited().success());
}
#[test] fn invalid_mode_or_incompatible_core_handshake() {
    let mut invalid=Process::new(&["--unsupported-mode"]); assert!(!invalid.exited().success());
    let mut p=Process::new(&[]); p.send(Message::Hello{core_api:99}); assert!(!p.exited().success());
}

#[test] fn live_mode_handshake_has_no_implicit_capabilities_and_rejects_unbound_frames() {
    let mut p=Process::new(&["--live"]);p.send(Message::Hello{core_api:CORE_API});
    assert!(matches!(p.receive(),Message::Ready{id,version,..} if id=="dota2"&&version==env!("CARGO_PKG_VERSION")));
    assert!(matches!(p.receive(),Message::State{data} if data["mode"]=="external"&&data["sideEffects"]==false&&data["liveCapabilities"]==json!([])));
    p.send(Message::Command{id:1,name:"dota.live_frame".into(),args:json!({})});
    assert!(matches!(p.receive(),Message::Error{code,..} if code=="invalid_execution_frame"));
    p.send(Message::Stop);assert!(matches!(p.receive(),Message::Stopped));assert!(p.exited().success());
}

#[test] fn worker_results_equal_builtin_pure_rules_across_reconnect_and_invalid_order() {
    use companion_dota_domain::{broadcast_state::{BroadcastState,resolve},contracts::{ReplayInput,ReplayResult,SoundSignal},events::{self,PendingConfirmations},gsi};
    let frames:Vec<ReplayInput>=serde_json::from_str(include_str!("fixtures/replay.json")).unwrap();
    // A fresh process models reconnect. Each run establishes a fresh baseline.
    for _ in 0..2 {
        let mut p=Process::new(&["--replay"]); p.send(Message::Hello{core_api:CORE_API}); p.receive(); p.receive();
        let mut previous=None; let mut pending=PendingConfirmations::default();
        for frame in &frames {
            let snapshot=serde_json::to_value(&frame.snapshot).unwrap();
            let effective=match &previous {Some(prev) if !events::hero_identity_changed(prev,&snapshot)=>Some(prev),_=>{pending=PendingConfirmations::default();None}};
            // Direct calls used by built-in adapters, NOT Replay::apply as the oracle.
            let (sounds,_)=events::detect_events_with_state(effective,&snapshot,frame.observed_at_ms,&mut pending);
            let parsed=gsi::parse(&snapshot);
            let expected=ReplayResult {sequence:frame.sequence,broadcast_state:resolve(BroadcastState::from_gsi(&snapshot),frame.context.session_ended,frame.context.manual_summary_override),sound_signals:sounds.into_iter().map(|e|SoundSignal{kind:e.kind,id:e.id}).collect(),in_match:parsed.as_ref().is_some_and(|s|s.is_in_match()),post_game:parsed.as_ref().is_some_and(|s|s.is_post_game()),hero_id:parsed.as_ref().and_then(|s|s.hero_id),match_id:parsed.and_then(|s|s.match_id),mode:"replay_only",side_effects:false,match_analysis:frame.match_context.as_ref().map(|c|companion_dota_domain::match_shadow::analyze(c,&frame.snapshot,frame.sequence))};
            p.send(Message::Command{id:frame.sequence,name:"dota.replay".into(),args:serde_json::to_value(frame).unwrap()});
            let expected=serde_json::to_value(expected).unwrap();
            assert!(matches!(p.receive(),Message::Event{data,..} if data==expected));
            assert!(matches!(p.receive(),Message::State{data} if data==expected));
            let Message::Reply{result,..}=p.receive() else {panic!("reply")}; assert_eq!(result,expected,"sequence {}",frame.sequence);
            previous=Some(snapshot);
        }
        for seq in [7,1] {
            p.send(Message::Command{id:20+seq,name:"dota.replay".into(),args:json!({"sequence":seq,"observedAtMs":800,"snapshot":{}})});
            assert!(matches!(p.receive(),Message::Error{code,..} if code=="replay_sequence_not_increasing"));
        }
        p.send(Message::Command{id:30,name:"dota.replay".into(),args:json!({"sequence":8,"observedAtMs":1,"snapshot":{}})});
        assert!(matches!(p.receive(),Message::Error{code,..} if code=="replay_time_went_backwards"));
        p.send(Message::Command{id:31,name:"dota.reset".into(),args:json!({})}); p.receive();
        p.send(Message::Command{id:32,name:"dota.replay".into(),args:serde_json::to_value(&frames[3]).unwrap()}); p.receive();p.receive();
        assert!(matches!(p.receive(),Message::Reply{result,..} if result["soundSignals"].as_array().unwrap().is_empty()));
        p.send(Message::Stop); assert!(matches!(p.receive(),Message::Stopped)); assert!(p.exited().success());
    }
}

#[test] fn typed_core_read_uses_correlated_reverse_ipc_and_rejects_bad_queries() {
 let mut p=Process::new(&[]);p.send(Message::Hello{core_api:CORE_API});p.receive();p.receive();
 p.send(Message::Command{id:1,name:"dota.core_read".into(),args:json!({"query":"obs"})});
 assert!(matches!(p.receive(),Message::CoreRead{id:1,request} if request==json!({"query":"obs"})));
 p.send(Message::CoreReadReply{id:1,response:json!({"kind":"obs","connected":true})});
 assert!(matches!(p.receive(),Message::Reply{id:1,result} if result==json!({"kind":"obs","connected":true})));
 p.send(Message::Command{id:2,name:"dota.core_read".into(),args:json!({"query":"history","limit":21})});
 assert!(matches!(p.receive(),Message::Error{code,..} if code=="invalid_read_request"));
 p.send(Message::Command{id:3,name:"dota.core_read".into(),args:json!({"query":"http","url":"https://invalid"})});
 assert!(matches!(p.receive(),Message::Error{code,..} if code=="invalid_read_request"));
 p.send(Message::Stop);assert!(matches!(p.receive(),Message::Stopped));assert!(p.exited().success());
}
