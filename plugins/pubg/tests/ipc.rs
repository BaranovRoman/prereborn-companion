//! The real executable over stdio, framed exactly like the Companion host:
//! verified launch, handshake, commands, one reverse backend read per poll.
use companion_plugin_protocol::{read_frame, write_frame, Message, CORE_API};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::BufReader, process::{Child, ChildStdin, ChildStdout, Command, Stdio}};

const BIN: &str = env!("CARGO_BIN_EXE_companion-pubg-plugin");

fn launch(root: &std::path::Path, caps: &[&str], executable_hash: Option<String>) -> String {
    let hash = executable_hash.unwrap_or_else(|| format!("{:x}", Sha256::digest(std::fs::read(BIN).unwrap())));
    json!({"dataRoot": root, "generation": uuid::Uuid::new_v4().to_string(),
           "package": {"id": "pubg", "version": env!("CARGO_PKG_VERSION"), "executableHash": hash, "manifestHash": "b".repeat(64)},
           "capabilities": caps}).to_string()
}
struct Plugin { child: Child, input: ChildStdin, output: BufReader<ChildStdout>, next: u64 }
impl Plugin {
    fn start(launch: String) -> Self {
        let mut child = Command::new(BIN).args(["--worker", &launch]).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        write_frame(&mut input, Message::Hello { core_api: CORE_API }).unwrap();
        assert!(matches!(read_frame(&mut output).unwrap(), Some(Message::Ready { ref id, .. }) if id == "pubg"));
        Self { child, input, output, next: 0 }
    }
    /// Sends a command; `backend` answers a reverse read if one arrives.
    fn command(&mut self, name: &str, args: Value, backend: Option<&dyn Fn(&Value) -> Value>) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        write_frame(&mut self.input, Message::Command { id, name: name.into(), args }).unwrap();
        loop {
            match read_frame(&mut self.output).unwrap().expect("frame") {
                Message::CoreRead { id: read, request } => {
                    assert_eq!(read, id);
                    let respond = backend.expect("unexpected backend read");
                    write_frame(&mut self.input, Message::CoreReadReply { id, response: respond(&request) }).unwrap();
                },
                Message::State { data } => assert!(data.get("active").is_some()),
                Message::Reply { id: reply, result } => { assert_eq!(reply, id); return Ok(result); },
                Message::Error { id: Some(reply), code, .. } => { assert_eq!(reply, id); return Err(code); },
                other => panic!("unexpected {other:?}"),
            }
        }
    }
    fn stop(mut self) {
        write_frame(&mut self.input, Message::Stop).unwrap();
        assert!(matches!(read_frame(&mut self.output).unwrap(), Some(Message::Stopped)));
        assert!(self.child.wait().unwrap().success());
    }
}

#[test]
fn a_forged_launch_never_starts() {
    let root = tempfile::tempdir().unwrap();
    for bad in [launch(root.path(), &["ui"], Some("a".repeat(64))), launch(root.path(), &["ui", "obs.scene"], None), launch(&root.path().join("missing"), &["ui"], None)] {
        let status = Command::new(BIN).args(["--worker", &bad]).env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
        assert!(!status.success());
    }
    assert!(!Command::new(BIN).arg("--replay").env_clear().stdin(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
}

#[test]
fn settings_activation_and_a_backend_round_trip_over_real_ipc() {
    let root = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::start(launch(root.path(), &["ui", "data.private", "backend.access"], None));
    assert_eq!(plugin.command("host.status", json!({}), None).unwrap()["active"], false);
    assert_eq!(plugin.command("host.prepare", json!({}), None).unwrap()["prepared"], true);
    plugin.command("settings.save", json!({"settings": {"player": "ProPlayer", "platform": "steam", "widget": {"enabled": true, "count": 5, "scale": 100, "backgroundOpacity": 70, "showHeaders": true}}}), None).unwrap();
    plugin.command("host.activate", json!({}), None).unwrap();
    let now = chrono::Utc::now();
    let backend = |request: &Value| {
        assert_eq!(request["resource"], "matches");
        assert_eq!(request["query"]["player"], "ProPlayer");
        json!({"operationKey": request["operationKey"], "status": 200, "error": null, "body": {"status": "ok", "complete": true, "player": {"name": "ProPlayer", "platform": "steam"},
            "matches": [{"id": "00000000-0000-4000-8000-000000000001", "createdAt": now + chrono::Duration::seconds(5), "durationSec": 1700, "map": "Miramar", "gameMode": "squad-fpp", "place": 3, "kills": 5, "damage": 640}]}})
    };
    let batch = plugin.command("host.poll", json!({"streamObservation": null, "sceneObservation": null, "sceneReceipt": null, "chat": null}), Some(&backend)).unwrap();
    assert_eq!(batch["status"]["sessionMatches"], 1);
    assert_eq!(batch["soundIntents"], json!([]));
    // Next poll: no new read until the refresh interval passes.
    plugin.command("host.poll", json!({}), None).unwrap();
    let matches = plugin.command("matches", json!({}), None).unwrap();
    assert_eq!(matches["matches"][0]["map"], "Miramar");
    assert_eq!(plugin.command("host.resource", json!({}), None).unwrap_err(), "unsupported_worker_command");
    plugin.command("host.stop", json!({}), None).unwrap();
    plugin.stop();
    assert!(root.path().join("history.json").is_file());
}
