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
