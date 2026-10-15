// Compatibility export: a single process/IPC/supervisor implementation.
pub use companion_plugin_protocol::runtime::*;
#[cfg(windows)] pub use companion_plugin_protocol::windows;
#[cfg(test)] use std::{path::Path,time::Duration};
#[cfg(test)] use serde_json::{json,Value};
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
        assert!(runtime.diagnostic_process_id().is_none());
        for (mode, error) in [("incompatible", "incompatible_plugin"), ("protocol", "incompatible_protocol"),
            ("malformed", "invalid_frame"), ("exit", "unexpected_eof"), ("hang", "timeout")] {
            assert_eq!(runtime.start(&binary(), &[mode.into()]).unwrap_err(), error);
            assert_eq!(runtime.snapshot().phase, Phase::Failed);
            assert!(runtime.diagnostic_process_id().is_none());
        }
        runtime.start(&binary(), &[]).unwrap();
        assert_eq!(runtime.command("hang".into(), Value::Null).unwrap_err(), "timeout");
        assert!(runtime.diagnostic_process_id().is_none());
        runtime.start(&binary(), &[]).unwrap();
        runtime.stop().unwrap();
    }
    #[test]
    fn process_failure_does_not_touch_core_or_dota() {
        let app = crate::state::AppState::new();
        app.0.lock().unwrap().core.twitch_chat = Some(json!({"connected":true}));
        let before = serde_json::to_value(app.snapshot()).unwrap();
        let host = PluginHost::new();
        host.0.lock().unwrap().start(&binary(), &[]).unwrap();
        assert!(host.0.lock().unwrap().command("crash".into(),Value::Null).is_err());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(host.0.lock().unwrap().snapshot().phase, Phase::Failed);
        assert_eq!(serde_json::to_value(app.snapshot()).unwrap(), before);
        assert_eq!(app.0.lock().unwrap().core.twitch_chat, Some(json!({"connected":true})));
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
            assert!(result.is_err());assert_eq!(observed,calls);let _=runtime.stop();runtime.stop().unwrap();assert!(runtime.diagnostic_process_id().is_none());
        }
    }
    #[test]
    fn hello_cannot_negotiate_execution_rights_or_send_reverse_request() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("invalid-handshake");
        for message in [json!({"type":"diagnostic_execute","id":1,"request":{}}),json!({"type":"ready","id":"dota2","version":"0.1.0","min_core_api":1,"max_core_api":1,"capabilities":[CAP]})] {
            std::fs::write(&path,format!("#!/bin/sh\nread line\nprintf '%s\\n' '{}'\nread line\n",json!({"protocol":1,"message":message}))).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();let mut runtime=Runtime::default();assert!(runtime.start_expected(&path,&[],"dota2",Some("0.1.0")).is_err());assert!(runtime.diagnostic_process_id().is_none());
        }
    }
}
