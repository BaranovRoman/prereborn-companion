use super::*;
use crate::local_runtime::{transaction_authorization as auth,transaction_tests};
use companion_dota_domain::ownership::Phase;
struct Fixture {history:LocalRuntimeState,manager:PluginManager,gate:LiveDota,session:String,backup:std::path::PathBuf,_root:tempfile::TempDir}
impl Fixture {
 fn new()->Self {Self::with_binary(None)}
 fn with_binary(supplied:Option<&std::path::Path>)->Self {
  let root=tempfile::tempdir().unwrap();let manifest_dir=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let default_binary=manifest_dir.join("../../../plugins/target/debug").join(if cfg!(windows){"companion-dota-plugin.exe"}else{"companion-dota-plugin"});
  let binary=supplied.unwrap_or(default_binary.as_path());
  assert!(binary.exists(),"Build the changed plugin crate before these targeted tests");
  assert!(std::process::Command::new("node").arg(manifest_dir.join("src/core/dota_live/tests/sign-fixture.cjs")).args([root.path().as_os_str(),binary.as_os_str(),std::ffi::OsStr::new(std::env::consts::OS),std::ffi::OsStr::new(std::env::consts::ARCH)]).status().unwrap().success());
  let key=std::fs::read_to_string(root.path().join("fixture.pub")).unwrap();let release=serde_json::from_slice(&std::fs::read(root.path().join("release.json")).unwrap()).unwrap();
  let manager=crate::core::plugin_manager::fixture_installed(root.path().join("plugins"),&key,&release,&std::fs::read(root.path().join("fixture.zip")).unwrap());
  let path=root.path().join("history.sqlite3");let (session,_)=transaction_tests::seed(&path);
  let history=LocalRuntimeState::new();*history.lock()=Some(rusqlite::Connection::open(path).unwrap());
  let backup=root.path().join("backup.sqlite3");history.migrate_transactions(&backup).unwrap();
  history.with_transaction_adapter(|_,c|auth::confirm_fenced(c,Lease{owner:Owner::BuiltIn,epoch:1})).unwrap();
  Self{history,manager,gate:LiveDota::default(),session,backup,_root:root}
 }
 fn start(&self)->LiveProcess {handover_external(&self.manager,&self.history,&self.gate,&self.session,&self.backup,&[MATCH_EXECUTION_CAPABILITY,"dota.obs.scene","dota.sound.play","dota.overlay.update"],||Ok(())).unwrap()}
 fn frame(&self,n:u64,state:&str)->Frame {
  Frame{context:ReplayContext::default(),sequence:n,at:chrono::DateTime::from_timestamp(1700000000+n as i64,0).unwrap(),snapshot:crate::core::dota_observer::project(&serde_json::json!({"player":{"activity":"playing","team_name":"radiant","kills":4},"hero":{"id":105},"map":{"game_state":state,"matchid":"42","win_team":"radiant"},"items":{"slot8":{"name":"item_tango","charges":3}}})).unwrap()}
 }
}
#[test]
fn installed_process_roundtrip_parity_poststate_and_fenced_fallback() {
 let f=Fixture::new();let p=f.start();assert!(f.gate.builtin().is_none());
 let mut legacy=rusqlite::Connection::open(&f.backup).unwrap();let seed=transaction_tests::ids(&legacy);
 let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let post="DOTA_GAMERULES_STATE_POST_GAME";
 let mut effects=0;
 for (index,state) in [game,"menu",game,post,post].into_iter().enumerate(){
  let frame=f.frame(index as u64+1,state);
  crate::local_runtime::host_execution::tests::legacy_apply(&mut legacy,&f.session,&frame.snapshot,index as i64+1);
  p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|_,_|{effects+=1;EffectStatus::Completed}).unwrap();
  let guard=f.history.lock();assert_eq!(transaction_tests::normalized(&legacy,&seed),transaction_tests::normalized(guard.as_ref().unwrap(),&seed),"transition {index}");
 }
 let (count,bytes):(u64,u64)=f.history.lock().as_ref().unwrap().query_row("SELECT count(*),sum(length(CAST(receipt AS BLOB))) FROM pc_tx_receipts WHERE operation_key LIKE 'match:%'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
 eprintln!("synthetic match receipts: {count} rows, {bytes} bytes, average {} bytes",bytes/count);
 assert!(effects>0);let old=p.grant.lease;let builtin=p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert!(builtin.epoch>old.epoch);assert!(f.gate.builtin().is_some());
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(6,game),ReplayContext::default(),|_,_|panic!("stale effect")).is_err());
 assert_eq!(f.manager.action("dota2","start").unwrap_err(),"dota_live_activation_deferred");
}
#[test]
fn unknown_transport_result_never_repeats_or_allows_unproven_fallback() {
 let f=Fixture::new();let p=f.start();let mut sent=0;
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_|{sent+=1;EffectStatus::Unknown}).is_err());
 assert_eq!(sent,1);f.gate.failed(p.grant.lease,"unknown");assert!(p.fallback(&f.history,&f.gate,||Ok(())).is_err());
 assert_eq!(f.gate.status().mode,Mode::Draining);assert!(f.gate.builtin().is_none());
 assert!(matches!(auth::phase(f.history.lock().as_ref().unwrap()).unwrap(),Phase::Draining{..}));
}
#[test]
fn missing_migration_backup_capabilities_and_developer_gate_refuse_activation() {
 let f=Fixture::new();let c=rusqlite::Connection::open(&f.backup).unwrap();
 assert!(developer_activation_preflight(&c,&f.backup).is_err());
 let guard=f.history.lock();let c=guard.as_ref().unwrap();
 assert!(developer_activation_preflight(c,&f._root.path().join("missing")).is_err());
 assert_eq!(developer_activation_preflight(c,&f.backup).unwrap_err(),"frontend_audio_and_legacy_writers_not_fenced");drop(guard);
 assert!(handover_external(&f.manager,&f.history,&f.gate,&f.session,&f.backup,&[],||Ok(())).is_err());assert!(f.gate.builtin().is_some());
}
#[test]
fn process_generation_restart_and_normal_replay_cannot_execute() {
 let f=Fixture::new();let p=f.start();let old_binding=p.binding.clone();
 f.manager.with_verified_match_grant(&p.grant,|pin|{
  let mut r=p.runtime.lock().unwrap();assert!(r.command("dota.live_recover".into(),serde_json::json!({})).is_err());
  let _=r.stop();r.stopped_confirmed()?;let new=r.start_verified(pin)?;assert_ne!(old_binding.generation,new.generation);
  assert!(r.command_live(pin,&old_binding,"dota.live_recover".into(),serde_json::json!({}),|_|panic!()).is_err());r.stop()?;Ok(())
 }).unwrap();
 let mut replay=Runtime::default();replay.start_expected(p.grant.executable(),&["--replay".into()],"dota2",Some("0.1.0")).unwrap();
 assert!(replay.command("dota.live_frame".into(),serde_json::json!({})).is_err());replay.stop().unwrap();
}

#[test]
fn lost_reply_saved_receipt_and_unknown_recovery_use_real_ipc() {
 let f=Fixture::new();let p=f.start();let frame=f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");
 let prepared=f.history.with_transaction_adapter(|a,c|a.prepare_live_operation(c,&f.session,frame.snapshot.clone(),frame.at,1)).unwrap().unwrap();
 let request=prepared.core_request("match:committed-no-reply","recovery").unwrap();
 let scope=ExecutionScope{session:f.session.clone(),epoch:p.grant.lease.epoch,run:p.binding.generation.clone()};
 let input=execution_frame(&scope,&prepared,&request.operation_key);
 let mut committed=None;
 f.manager.with_verified_match_grant(&p.grant,|pin|{
  let mut runtime=p.runtime.lock().unwrap();
  assert!(runtime.command_live(pin,&p.binding,"dota.live_frame".into(),serde_json::to_value(input).unwrap(),|v|{
   let req:ExecutionRequest=serde_json::from_value(v).unwrap();let ExecutionRequest::Execute{request,..}=req else{panic!()};
   committed=Some(f.history.with_transaction_adapter(|a,c|a.execute_plugin(c,pin,&request))?);
   Err("injected_crash_after_commit_before_reply".into())
  }).is_err());runtime.stopped_confirmed()?;Ok(())
 }).unwrap();
 let saved=committed.unwrap();let before=transaction_tests::dump(f.history.lock().as_ref().unwrap());
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();let restarted=f.start();
 assert_ne!(restarted.binding.generation,p.binding.generation);
 assert_eq!(restarted.recover(&f.manager,&f.history,&request).unwrap().receipt,saved.receipt);
 assert_eq!(restarted.recover(&f.manager,&f.history,&request).unwrap().receipt,saved.receipt);
 assert_eq!(transaction_tests::dump(f.history.lock().as_ref().unwrap()),before);
 let mut unknown=request.clone();unknown.operation_key="match:unknown".into();
 assert_eq!(restarted.recover(&f.manager,&f.history,&unknown).unwrap().status,EffectStatus::Unknown);
 assert_eq!(f.history.execute_plugin_plan(&f.manager,&restarted.grant,&unknown).unwrap().status,EffectStatus::Unknown);
 let startup=LiveDota::default();startup.observe_storage(f.history.lock().as_ref().unwrap());assert!(startup.builtin().is_none());assert_eq!(startup.status().mode,Mode::Draining);
}

#[cfg(unix)]
#[test]
fn hung_installed_process_cannot_block_ingest_and_fallback_reaps_it() {
 use std::os::unix::fs::PermissionsExt;
 let root=tempfile::tempdir().unwrap();let executable=root.path().join("hang.py");
 std::fs::write(&executable,r#"#!/usr/bin/python3
import sys,json,time
sys.stdin.readline()
print(json.dumps({'protocol':1,'message':{'type':'ready','id':'dota2','version':'0.1.0','min_core_api':1,'max_core_api':1}}),flush=True)
while sys.stdin.readline(): time.sleep(30)
"#).unwrap();std::fs::set_permissions(&executable,std::fs::Permissions::from_mode(0o700)).unwrap();
 let f=Arc::new(Fixture::with_binary(Some(&executable)));let process=Arc::new(f.start());
 let worker_fixture=f.clone();let worker_process=process.clone();
 let thread=std::thread::spawn(move||worker_process.process(&worker_fixture.manager,&worker_fixture.history,&worker_fixture.gate,worker_fixture.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_|panic!("hang produced an effect")));
 let deadline=Instant::now()+Duration::from_secs(1);
 while f.gate.status().in_flight==0{assert!(Instant::now()<deadline);std::thread::yield_now();}
 let started=Instant::now();for _ in 0..9{f.gate.enqueue(&serde_json::json!({}));}assert!(started.elapsed()<Duration::from_millis(100));
 assert!(thread.join().unwrap().is_err());assert!(process.runtime.lock().unwrap().stopped_confirmed().is_ok());
 let restored=process.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert_eq!(restored.owner,Owner::BuiltIn);assert!(f.gate.builtin().is_some());
}

#[test]
fn typed_effect_rights_are_explicit_and_ledger_exhaustion_does_not_dispatch() {
 let f=Fixture::new();let p=handover_external(&f.manager,&f.history,&f.gate,&f.session,&f.backup,&[MATCH_EXECUTION_CAPABILITY],||Ok(())).unwrap();
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_|panic!("ungranted effect")).unwrap_err().contains("capability_denied"));
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();let p=f.start();
 f.history.lock().as_ref().unwrap().execute("UPDATE pc_tx_limits SET max_operations=2",[]).unwrap();
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(2,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_|panic!("exhausted ledger dispatched")).unwrap_err().contains("safety_quota_exhausted"));
 assert_eq!(crate::local_runtime::host_execution::live_effects::quota(f.history.lock().as_ref().unwrap()).unwrap().remaining_operations,0);
}
