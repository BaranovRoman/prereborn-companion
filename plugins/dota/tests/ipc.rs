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
}
impl Drop for Process {fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
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
    p.send(Message::Stop); assert!(matches!(p.receive(),Message::Stopped)); assert!(p.child.wait().unwrap().success());
}
#[test] fn no_live_mode_or_incompatible_core_handshake() {
    let mut live=Process::new(&["--live"]); assert!(!live.child.wait().unwrap().success());
    let mut p=Process::new(&[]); p.send(Message::Hello{core_api:99}); assert!(!p.child.wait().unwrap().success());
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
            let expected=ReplayResult {sequence:frame.sequence,broadcast_state:resolve(BroadcastState::from_gsi(&snapshot),frame.context.session_ended,frame.context.manual_summary_override),sound_signals:sounds.into_iter().map(|e|SoundSignal{kind:e.kind,id:e.id}).collect(),in_match:parsed.as_ref().is_some_and(|s|s.is_in_match()),post_game:parsed.as_ref().is_some_and(|s|s.is_post_game()),hero_id:parsed.as_ref().and_then(|s|s.hero_id),match_id:parsed.and_then(|s|s.match_id),mode:"replay_only",side_effects:false};
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
        p.send(Message::Stop); assert!(matches!(p.receive(),Message::Stopped)); assert!(p.child.wait().unwrap().success());
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
 p.send(Message::Stop);assert!(matches!(p.receive(),Message::Stopped));assert!(p.child.wait().unwrap().success());
}
