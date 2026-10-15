use super::*;
use crate::local_runtime::{transaction_authorization as auth,transaction_tests};
use companion_dota_domain::ownership::Phase;
struct Fixture {history:LocalRuntimeState,manager:PluginManager,gate:LiveDota,session:String,backup:std::path::PathBuf,_root:tempfile::TempDir}
impl Fixture {
 fn new()->Self {Self::with_binary(None)}
 fn with_binary(supplied:Option<&std::path::Path>)->Self {
  Self::configured(supplied,false)
 }
 fn cold()->Self{Self::configured(None,true)}
 fn configured(supplied:Option<&std::path::Path>,cold:bool)->Self {
  let root=tempfile::tempdir().unwrap();let manifest_dir=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let default_binary=manifest_dir.join("../../../plugins/target/debug").join(if cfg!(windows){"companion-dota-plugin.exe"}else{"companion-dota-plugin"});
  let binary=supplied.unwrap_or(default_binary.as_path());
  assert!(binary.exists(),"Build the changed plugin crate before these targeted tests");
  assert!(std::process::Command::new("node").arg(manifest_dir.join("src/core/dota_live/tests/sign-fixture.cjs")).args([root.path().as_os_str(),binary.as_os_str(),std::ffi::OsStr::new(std::env::consts::OS),std::ffi::OsStr::new(std::env::consts::ARCH)]).status().unwrap().success());
  let key=std::fs::read_to_string(root.path().join("fixture.pub")).unwrap();let release=serde_json::from_slice(&std::fs::read(root.path().join("release.json")).unwrap()).unwrap();
  let manager=crate::core::plugin_manager::fixture_installed(root.path().join("plugins"),&key,&release,&std::fs::read(root.path().join("fixture.zip")).unwrap());
  let path=root.path().join("history.sqlite3");let session=transaction_tests::seed(&path).0;if cold{let c=rusqlite::Connection::open(&path).unwrap();c.execute_batch("DELETE FROM sync_outbox; DELETE FROM local_matches; DELETE FROM local_sessions;").unwrap();}
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
fn cold_switch_realistic_inventory_reaches_binding_worker_and_blast_off_intent() {
 let f=Fixture::cold();let mut p=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY,"dota.sound.play","dota.obs.scene","dota.overlay.update"],||Ok(())).unwrap();
 let mut raw:Value=serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../../plugins/dota-domain/src/fixtures/techies-inventory.json"))).unwrap();
 let mut sounds=Vec::new();let mut session=None;
 for n in 0..3 {
  if n>0{raw["abilities"]["ability2"]["cooldown"]=serde_json::json!(25);}
  f.gate.enqueue(&raw);assert_eq!(f.gate.status().mode,Mode::External);
  let frame=f.gate.next().expect("valid inventory must reach the production mailbox");
  p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&frame.snapshot),frame.at).unwrap();
  if let Some(id)=&session{assert_eq!(p.grant.session.as_ref(),Some(id));}else{session=p.grant.session.clone();assert!(session.is_some());}
  assert!(auth::session_bound(f.history.lock().as_ref().unwrap()).unwrap());
  p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|effect,_,_|{
   if let Effect::Sound{event_id,..}=effect{sounds.push(event_id.clone());}EffectStatus::Completed
  }).unwrap();
 }
 assert_eq!(sounds,vec!["techies_suicide"]);
 {let c=f.history.lock();let c=c.as_ref().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),1);}
 assert_eq!(f.gate.status().projection_rejected,0);p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert!(f.gate.builtin().is_some());
}
#[test]
fn cold_switch_process_waits_without_session_or_effects_and_falls_back() {
 let f=Fixture::cold();let mut p=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY,"dota.sound.play","dota.obs.scene","dota.overlay.update"],||Ok(())).unwrap();
 assert!(p.grant.session.is_none());assert!(f.gate.builtin().is_none());
 p.lifecycle(&f.manager,&f.history,&f.gate,None,None,chrono::Utc::now()).unwrap();
 let mut demo=f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");demo.snapshot.map.as_mut().unwrap().custom_game_name=Some("hero_demo".into());
 p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&demo.snapshot),demo.at).unwrap();assert!(p.grant.session.is_none());
 assert_eq!(p.process(&f.manager,&f.history,&f.gate,demo,ReplayContext::default(),|_,_,_|panic!("unbound effect")).unwrap_err(),"session_unbound");
 let next=p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert!(next.epoch>p.grant.lease.epoch);assert!(f.gate.builtin().is_some());
 let c=f.history.lock();let c=c.as_ref().unwrap();for table in ["local_sessions","local_matches","pc_tx_ledger","pc_tx_receipts"]{assert_eq!(c.query_row(&format!("SELECT count(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0);}
}
#[test]
fn cold_switch_first_gsi_receipt_survives_lost_reply_and_real_worker_continues() {
 let f=Fixture::cold();let mut p=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY,"dota.sound.play","dota.obs.scene","dota.overlay.update"],||Ok(())).unwrap();
 let frame=f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");
 let saved=f.manager.with_verified_match_grant(&p.grant,|pin|f.history.with_transaction_adapter(|a,c|a.external_lifecycle(c,pin,None,Some(&frame.snapshot),frame.at,false))).unwrap().session.unwrap();
 {let reopened=rusqlite::Connection::open(f._root.path().join("history.sqlite3")).unwrap();
  assert!(auth::session_bound(&reopened).unwrap());
  assert_eq!(reopened.query_row("SELECT count(*) FROM pc_tx_receipts WHERE operation_key LIKE 'lifecycle:%' AND receipt LIKE '%' || ?1 || '%'",[&saved],|r|r.get::<_,i64>(0)).unwrap(),1);
  let startup=LiveDota::default();startup.observe_storage(&reopened);assert_eq!(startup.status().mode,Mode::Draining);assert!(startup.builtin().is_none());
 }
 // Commit succeeded but the caller did not receive/bind its result. A new read returns the same UUID.
 assert!(p.grant.session.is_none());p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&frame.snapshot),frame.at).unwrap();assert_eq!(p.grant.session.as_deref(),Some(saved.as_str()));
 p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 let again=f.frame(2,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&again.snapshot),again.at).unwrap();
 {let c=f.history.lock();let c=c.as_ref().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),1);assert_eq!(c.query_row("SELECT session_local_id FROM local_matches LIMIT 1",[],|r|r.get::<_,String>(0)).unwrap(),saved);}
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
 assert!(p.process(&f.manager,&f.history,&f.gate,again,ReplayContext::default(),|_,_,_|panic!("stale effect")).is_err());
}
#[test]
fn cold_switch_fallback_resolves_committed_session_even_when_binding_reply_was_lost() {
 let f=Fixture::cold();let p=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY],||Ok(())).unwrap();
 let frame=f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");
 let saved=f.manager.with_verified_match_grant(&p.grant,|pin|f.history.with_transaction_adapter(|a,c|a.external_lifecycle(c,pin,None,Some(&frame.snapshot),frame.at,false))).unwrap().session.unwrap();
 assert!(p.grant.session.is_none());let next=p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert!(next.epoch>p.grant.lease.epoch);
 assert_eq!(f.history.preparation_session().unwrap().as_deref(),Some(saved.as_str()));
 let c=f.history.lock();let c=c.as_ref().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),1);assert!(auth::session_bound(c).unwrap());
}
#[test]
fn cold_switch_bootstrap_quota_failure_rolls_back_the_entire_write_set() {
 let f=Fixture::cold();let mut p=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY],||Ok(())).unwrap();
 f.history.lock().as_ref().unwrap().execute("UPDATE pc_tx_limits SET max_receipt_bytes=1",[]).unwrap();
 let frame=f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");assert_eq!(p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&frame.snapshot),frame.at).unwrap_err(),"safety_quota_exhausted");
 {let c=f.history.lock();let c=c.as_ref().unwrap();assert!(!auth::session_bound(c).unwrap());for table in ["local_sessions","pc_tx_ledger","pc_tx_receipts"]{assert_eq!(c.query_row(&format!("SELECT count(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0);}c.execute("UPDATE pc_tx_limits SET max_receipt_bytes=1048576",[]).unwrap();}
 p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&frame.snapshot),frame.at).unwrap();assert!(p.grant.session.is_some());p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}
#[test]
fn cold_switch_admission_rechecks_real_session_and_unknown_inside_transaction() {
 for unknown in [false,true] {
  let f=Fixture::cold();
  {let mut c=f.history.lock();let c=c.as_mut().unwrap();
   if unknown{c.execute("INSERT INTO pc_tx_ledger VALUES('uncertain',?1,'unknown')",["a".repeat(64)]).unwrap();}
   else{let tx=c.transaction().unwrap();crate::local_runtime::transaction_facade::Facade::new(&tx).session(chrono::Utc::now(),false).unwrap();tx.commit().unwrap();}
  }
  let result=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY],||panic!("unsafe fence/spawn"));
  let err=match result{Err(e)=>e,Ok(_)=>panic!("unsafe cold admission")};
  assert_eq!(err,if unknown{"unknown_effects_require_explicit_reconciliation"}else{"cold_state_changed"});
  let c=f.history.lock();assert!(matches!(auth::phase(c.as_ref().unwrap()).unwrap(),Phase::Active(Lease{owner:Owner::BuiltIn,..})));
  assert_ne!(f.gate.status().mode,Mode::External); // No process is admitted; early preflight may leave BuiltIn running.
 }
}
#[test]
fn cold_switch_unknown_cannot_bind_or_take_over() {
 let f=Fixture::cold();let mut p=handover_optional(&f.manager,&f.history,&f.gate,None,&f.backup,&[MATCH_EXECUTION_CAPABILITY],||Ok(())).unwrap();
 f.history.lock().as_ref().unwrap().execute("INSERT INTO pc_tx_ledger VALUES('uncertain',?1,'unknown')",["b".repeat(64)]).unwrap();
 let frame=f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");
 assert_eq!(p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&frame.snapshot),frame.at).unwrap_err(),"unknown_effects_require_explicit_reconciliation");
 assert!(p.fallback(&f.history,&f.gate,||Ok(())).is_err());assert!(f.gate.builtin().is_none());assert_eq!(f.gate.status().mode,Mode::Draining);
 let c=f.history.lock();let c=c.as_ref().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),0);
 assert!(matches!(auth::phase(c).unwrap(),Phase::Draining{..}));
 assert!(auth::runtime_session(c,p.grant.lease,Some(p.grant.binding())).is_err());
}
#[test]
fn installed_process_roundtrip_parity_poststate_and_fenced_fallback() {
 let f=Fixture::new();let p=f.start();assert!(f.gate.builtin().is_none());
 let mut legacy=rusqlite::Connection::open(&f.backup).unwrap();let seed=transaction_tests::ids(&legacy);
 let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let post="DOTA_GAMERULES_STATE_POST_GAME";
 let mut effects=0;
 for (index,state) in [game,"menu",game,post,post].into_iter().enumerate(){
  let frame=f.frame(index as u64+1,state);
  transaction_tests::legacy_apply(&mut legacy,&f.session,&frame.snapshot,index as i64+1);
  p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|_,_,_|{effects+=1;EffectStatus::Completed}).unwrap();
  let guard=f.history.lock();assert_eq!(transaction_tests::normalized(&legacy,&seed),transaction_tests::normalized(guard.as_ref().unwrap(),&seed),"transition {index}");
 }
 let (count,bytes):(u64,u64)=f.history.lock().as_ref().unwrap().query_row("SELECT count(*),sum(length(CAST(receipt AS BLOB))) FROM pc_tx_receipts WHERE operation_key LIKE 'match:%'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
 eprintln!("synthetic match receipts: {count} rows, {bytes} bytes, average {} bytes",bytes/count);
 assert!(effects>0);let old=p.grant.lease;let builtin=p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert!(builtin.epoch>old.epoch);assert!(f.gate.builtin().is_some());
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(6,game),ReplayContext::default(),|_,_,_|panic!("stale effect")).is_err());
 assert_eq!(f.manager.action("dota2","start").unwrap_err(),"dota_live_activation_deferred");
}
#[test]
fn unknown_transport_result_never_repeats_or_allows_unproven_fallback() {
 let f=Fixture::new();let p=f.start();let mut sent=0;
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_,_|{sent+=1;EffectStatus::Unknown}).is_err());
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
 if cfg!(windows){developer_activation_preflight(c,&f.backup).unwrap();}else{assert_eq!(developer_activation_preflight(c,&f.backup).unwrap_err(),ACTIVATION_BLOCKER);}drop(guard);
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
 let thread=std::thread::spawn(move||worker_process.process(&worker_fixture.manager,&worker_fixture.history,&worker_fixture.gate,worker_fixture.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_,_|panic!("hang produced an effect")));
 let deadline=Instant::now()+Duration::from_secs(1);
 while f.gate.status().in_flight==0{assert!(Instant::now()<deadline);std::thread::yield_now();}
 let started=Instant::now();for _ in 0..9{f.gate.enqueue(&serde_json::json!({}));}assert!(started.elapsed()<Duration::from_millis(100));
 assert!(thread.join().unwrap().is_err());assert!(process.runtime.lock().unwrap().stopped_confirmed().is_ok());
 let restored=process.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert_eq!(restored.owner,Owner::BuiltIn);assert!(f.gate.builtin().is_some());
}

#[test]
fn typed_effect_rights_are_explicit_and_ledger_exhaustion_does_not_dispatch() {
 let f=Fixture::new();let p=handover_external(&f.manager,&f.history,&f.gate,&f.session,&f.backup,&[MATCH_EXECUTION_CAPABILITY],||Ok(())).unwrap();
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(1,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_,_|panic!("ungranted effect")).unwrap_err().contains("capability_denied"));
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();let p=f.start();
 f.history.lock().as_ref().unwrap().execute("UPDATE pc_tx_limits SET max_operations=2",[]).unwrap();
 assert!(p.process(&f.manager,&f.history,&f.gate,f.frame(2,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),ReplayContext::default(),|_,_,_|panic!("exhausted ledger dispatched")).unwrap_err().contains("safety_quota_exhausted"));
 assert_eq!(crate::local_runtime::host_execution::live_effects::quota(f.history.lock().as_ref().unwrap()).unwrap().remaining_operations,0);
}

#[test]
fn real_ipc_ordinary_frames_reuse_telemetry_slot_with_receipt_driven_context() {
 let f=Fixture::new();let p=f.start();let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";
 for sequence in 1..=12 {
  p.process(&f.manager,&f.history,&f.gate,f.frame(sequence,game),ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 }
 let guard=f.history.lock();let c=guard.as_ref().unwrap();
 assert_eq!(c.query_row("SELECT count(*) FROM pc_tx_ticket",[],|r|r.get::<_,u64>(0)).unwrap(),2);
 assert_eq!(c.query_row("SELECT count(*) FROM pc_tx_ledger WHERE operation_key LIKE 'telemetry:%'",[],|r|r.get::<_,u64>(0)).unwrap(),1);
 assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,u64>(0)).unwrap(),1);
 drop(guard);p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}

#[test]
fn core_writers_lifecycle_watchdog_and_session_resolution_refresh_real_ipc_context() {
 let f=Fixture::new();let mut p=f.start();let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";
 let at=|n:i64|chrono::DateTime::from_timestamp(1700000000+n,0).unwrap();
 p.process(&f.manager,&f.history,&f.gate,f.frame(1,game),ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 p.lifecycle(&f.manager,&f.history,&f.gate,Some(true),None,at(2)).unwrap();
 {let mut guard=f.history.lock();let c=guard.as_mut().unwrap();let tx=c.transaction().unwrap();crate::local_runtime::transaction_facade::Facade::new(&tx).rating(1200).unwrap();tx.commit().unwrap();}
 p.process(&f.manager,&f.history,&f.gate,f.frame(3,game),ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,at(4)).unwrap();p.lifecycle(&f.manager,&f.history,&f.gate,Some(true),None,at(10)).unwrap();
 assert_eq!(p.grant.session.as_deref(),Some(f.session.as_str()));
 p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,at(11)).unwrap();p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,at(42)).unwrap();
 assert!(f.history.lock().as_ref().unwrap().query_row("SELECT ended_at IS NOT NULL FROM local_sessions WHERE local_id=?1",[&f.session],|r|r.get::<_,bool>(0)).unwrap());
 // No GSI for 20 minutes: shared cutoff interrupts the closed session's unresolved match.
 p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,at(1300)).unwrap();
 let mut next=f.frame(1301,game);next.snapshot.map.as_mut().unwrap().matchid=Some(companion_dota_domain::contracts::ScalarId::Text("43".into()));
 p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&next.snapshot),next.at).unwrap();assert_eq!(p.grant.session.as_deref(),Some(f.session.as_str()));let resolved=p.grant.session.clone();
 p.process(&f.manager,&f.history,&f.gate,next,ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 p.lifecycle(&f.manager,&f.history,&f.gate,None,None,at(1302)).unwrap();assert_eq!(p.grant.session,resolved);
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}

#[test]
fn persisted_generation_does_not_accept_pid_reuse_or_an_empty_runtime_as_stop_proof() {
 let f=Fixture::new();let p=f.start();let guard=f.history.lock();let c=guard.as_ref().unwrap();
 assert_eq!(auth::process_restart_fence(c).unwrap_err(),"previous_process_stop_unproven");drop(guard);
 assert!(Runtime::default().stopped_confirmed().is_ok()); // says NOTHING about the persisted process
 f.history.with_transaction_adapter(|_,c|{assert!(auth::process_stopped(c,&uuid::Uuid::new_v4().to_string()).is_err());Ok(())}).unwrap();
 let startup=LiveDota::default();startup.observe_storage(f.history.lock().as_ref().unwrap());assert!(startup.builtin().is_none());
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();auth::process_restart_fence(f.history.lock().as_ref().unwrap()).unwrap();
}

#[test]
fn obs_mapping_and_reconnect_reapply_only_on_explicit_reconciliation_revision() {
 let f=Fixture::new();let p=f.start();let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let mut scenes=0;
 for seq in 1..=5 {
  if seq==3||seq==5{f.gate.request_obs_reconciliation();}
  p.process(&f.manager,&f.history,&f.gate,f.frame(seq,game),ReplayContext::default(),|effect,_,_|{if matches!(effect,Effect::ObsScene{..}){scenes+=1;}EffectStatus::Completed}).unwrap();
 }
 assert_eq!(scenes,3);p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}

#[test]
#[ignore="explicit multi-match eight-hour IPC/SQLite budget"]
fn eight_hour_multi_match_effect_budget_through_existing_production_ipc() {
 use crate::game_sounds::audio_fence::{AudioFence,Status as Playback};
 let f=Fixture::new();let mut p=f.start();let audio=AudioFence::default();let start=chrono::DateTime::from_timestamp(1700000000,0).unwrap();
 let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let post="DOTA_GAMERULES_STATE_POST_GAME";
 let mut sounds=0;let mut obs=0;let mut overlay=0;let mut sequence=0;
 p.lifecycle(&f.manager,&f.history,&f.gate,Some(true),None,start+chrono::Duration::seconds(1)).unwrap();
 // Twelve 40-minute match cycles, six-second observations, two OBS reconnects
 // per hour and explicit mapping/manual reapply requests. No wall-clock sleeps.
 for cycle in 0..12 {
  for tick in 0..400 {
   sequence+=1;let mut frame=f.frame(sequence,if tick>=398{post}else{game});
   frame.at=start+chrono::Duration::seconds(sequence as i64*6);
   frame.snapshot.map.as_mut().unwrap().matchid=Some(companion_dota_domain::contracts::ScalarId::Text((42+cycle).to_string()));
   frame.snapshot.hero.as_mut().unwrap().id=Some(if cycle%2==0{105}else{14});
   frame.snapshot.items.as_mut().unwrap().get_mut("slot8").unwrap().charges=Some(1000-tick);
   if tick==0||tick==200 {f.gate.request_obs_reconciliation();p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,frame.at).unwrap();p.lifecycle(&f.manager,&f.history,&f.gate,Some(true),None,frame.at+chrono::Duration::seconds(2)).unwrap();}
   p.lifecycle(&f.manager,&f.history,&f.gate,None,Some(&frame.snapshot),frame.at).unwrap();
   p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|effect,_,a|match effect {
    Effect::Sound{..}=>{
     sounds+=1;let token=audio.admit(Some(a.ack.lease),Some(p.grant.session_id().unwrap())).unwrap();audio.bind(&token,&a.ack.idempotency_key).unwrap();
     f.history.with_transaction_adapter(|adapter,c|{adapter.bind_audio(c,a,&token)?;adapter.audio_ack(c,&a.ack.idempotency_key,&token,Playback::Playing)?;adapter.audio_ack(c,&a.ack.idempotency_key,&token,if sounds%50==0{Playback::Cancelled}else{Playback::Completed})}).unwrap();
     audio.ack(token,if sounds%50==0{Playback::Cancelled}else{Playback::Completed}).unwrap();EffectStatus::Accepted
    },
    Effect::ObsScene{..}=>{obs+=1;EffectStatus::Completed},Effect::Overlay{..}=>{overlay+=1;EffectStatus::Completed},_=>panic!("unsupported intent"),
   }).unwrap();
  }
 }
 p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,start+chrono::Duration::hours(8)).unwrap();p.lifecycle(&f.manager,&f.history,&f.gate,Some(false),None,start+chrono::Duration::hours(8)+chrono::Duration::seconds(31)).unwrap();
 let guard=f.history.lock();let c=guard.as_ref().unwrap();let count=|table:&str|c.query_row(&format!("SELECT count(*) FROM {table}"),[],|r|r.get::<_,u64>(0)).unwrap();
 let bytes:u64=c.query_row("SELECT bytes FROM pc_tx_usage WHERE kind='pc_tx_receipts'",[],|r|r.get(0)).unwrap();let quota=crate::local_runtime::host_execution::live_effects::quota(c).unwrap();
 eprintln!("8h: frames={sequence} matches={} sounds={sounds} obs={obs} overlay={overlay} ledger={} tickets={} receipt_bytes={bytes} revisions={} unknown={} remaining_keys={} outbox={}",count("local_matches"),count("pc_tx_ledger"),count("pc_tx_ticket"),count("pc_tx_revision"),quota.unknown,quota.remaining_operations,count("sync_outbox"));
 assert_eq!(count("local_matches"),12);assert!(sounds>=4700);assert_eq!(quota.unknown,0);assert!(quota.remaining_operations>4000);assert!(quota.remaining_tickets>9800);assert!(bytes<4*1024*1024);
 crate::local_runtime::transaction_schema::validate(c).unwrap();drop(guard);p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}

#[test]
fn idle_obs_reconciliation_uses_existing_ipc_without_game_history_writes_or_sound_dispatch() {
 let f=Fixture::new();let p=f.start();let before=transaction_tests::dump(f.history.lock().as_ref().unwrap());
 let mut scenes=0;let frame=Frame{sequence:1,at:chrono::Utc::now(),snapshot:Default::default(),context:ReplayContext::default()};
 p.reconcile_obs(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|effect,_,_|{assert!(!matches!(effect,Effect::Sound{..}));if matches!(effect,Effect::ObsScene{..}){scenes+=1;}EffectStatus::Completed}).unwrap();
 assert_eq!(scenes,1);assert_eq!(before,transaction_tests::dump(f.history.lock().as_ref().unwrap()));
 f.gate.request_obs_reconciliation();let frame=f.gate.obs_frame(p.grant.lease,Default::default(),Default::default()).unwrap();assert_eq!(frame.sequence,1);
 // Gate-owned sequence is independent of this synthetic fixture's direct IPC call.
 let mut frame=frame;frame.sequence=2;
 p.reconcile_obs(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|effect,_,_|{if matches!(effect,Effect::ObsScene{..}){scenes+=1;}EffectStatus::Completed}).unwrap();assert_eq!(scenes,2);
 p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}
#[test]
fn beta_capacity_preflight_fails_closed_without_evicting_unknown_or_keys() {
 let f=Fixture::new();let guard=f.history.lock();let c=guard.as_ref().unwrap();beta_capacity_preflight(c).unwrap();
 c.execute("UPDATE pc_tx_limits SET max_operations=5999",[]).unwrap();assert_eq!(beta_capacity_preflight(c).unwrap_err(),"eight_hour_beta_capacity_unavailable");
 c.execute("INSERT INTO pc_tx_ledger VALUES('effect:unknown',?1,'unknown')",["a".repeat(64)]).unwrap();assert_eq!(beta_capacity_preflight(c).unwrap_err(),"unknown_effects_require_explicit_reconciliation");
 assert_eq!(c.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get::<_,u64>(0)).unwrap(),1);
}
#[test]
fn draft_reminder_is_core_only_audio_source_with_durable_completion() {
 use crate::game_sounds::audio_fence::{AudioFence,Status as Playback};
 let f=Fixture::new();let p=f.start();f.manager.with_verified_match_grant(&p.grant,|pin|{
  let key=format!("effect:{}:1:draft",p.binding.generation);let req=companion_dota_domain::effects::Request{api:1,lease:p.grant.lease,correlation_id:key.clone(),idempotency_key:key.clone(),deadline_ms:1000,effect:Effect::Sound{event_id:"draft-stream-not-started".into(),kind:None}};
  assert!(f.history.with_transaction_adapter(|a,c|a.admit_effect(c,pin,&req,0)).is_err());
  let a=f.history.with_transaction_adapter(|a,c|a.admit_reminder(c,pin,&key,0))?;let fence=AudioFence::default();let token=fence.admit(Some(p.grant.lease),Some(p.grant.session_id().unwrap()))?;fence.bind(&token,&key)?;
  f.history.with_transaction_adapter(|adapter,c|{adapter.bind_audio(c,&a,&token)?;adapter.audio_ack(c,&key,&token,Playback::Completed)})?;fence.ack(token,Playback::Completed)?;
  let duplicate=f.history.with_transaction_adapter(|a,c|a.admit_reminder(c,pin,&key,0))?;assert!(!duplicate.fresh);assert_eq!(duplicate.ack.status,EffectStatus::Completed);Ok(())
 }).unwrap();p.fallback(&f.history,&f.gate,||Ok(())).unwrap();
}
#[test]
fn fallback_can_finish_the_same_drain_after_a_later_confirmed_audio_fence() {
 let f=Fixture::new();let p=f.start();let old=p.grant.lease;
 assert!(p.fallback(&f.history,&f.gate,||Err("audio_stop_unproven".into())).is_err());assert_eq!(f.gate.status().mode,Mode::Draining);assert!(f.gate.builtin().is_none());
 let next=p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert_eq!(next.owner,Owner::BuiltIn);assert_eq!(next.epoch,old.epoch+1);assert!(f.gate.builtin().is_some());
}
#[test]
fn starting_journal_without_pid_is_not_proof_no_process_was_spawned() {
 let f=Fixture::new();let generation=uuid::Uuid::new_v4().to_string();
 let old=match auth::phase(f.history.lock().as_ref().unwrap()).unwrap(){Phase::Active(l)=>l,_=>panic!()};
 let lease=Lease{owner:Owner::External,epoch:old.epoch+1};let grant=f.manager.match_execution_grant(&[MATCH_EXECUTION_CAPABILITY],&f.session,lease).unwrap();
 f.history.with_transaction_adapter(|_,c|{auth::begin(c,old,Owner::External,&f.session,Some(grant.binding().clone()))?;auth::process_starting(c,lease,grant.binding(),&generation)?;
  assert!(auth::process_restart_fence(c).is_err());assert!(auth::crash_fenced(c,old).is_err());Ok(())}).unwrap();
 assert!(matches!(auth::phase(f.history.lock().as_ref().unwrap()).unwrap(),Phase::Draining{..}));
}
#[test]
fn real_ipc_accepts_pending_audio_without_claiming_completion_and_late_cancel_fences_fallback() {
 use crate::game_sounds::audio_fence::{AudioFence,Status as Playback};
 let f=Fixture::new();let p=f.start();let audio=AudioFence::default();let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";
 p.process(&f.manager,&f.history,&f.gate,f.frame(1,game),ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 let mut frame=f.frame(2,game);frame.snapshot.items.as_mut().unwrap().get_mut("slot8").unwrap().charges=Some(2);let mut pending=None;
 p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|effect,_,a|{
  if matches!(effect,Effect::Sound{..}) {
   let token=audio.admit(Some(p.grant.lease),Some(p.grant.session_id().unwrap())).unwrap();audio.bind(&token,&a.ack.idempotency_key).unwrap();f.history.with_transaction_adapter(|adapter,c|adapter.bind_audio(c,a,&token)).unwrap();pending=Some((a.ack.idempotency_key.clone(),token));EffectStatus::Accepted
  }else{EffectStatus::Completed}
 }).unwrap();
 let (key,token)=pending.unwrap();assert_eq!(crate::local_runtime::host_execution::live_effects::quota(f.history.lock().as_ref().unwrap()).unwrap().unknown,1);
 p.process(&f.manager,&f.history,&f.gate,f.frame(3,game),ReplayContext::default(),|effect,_,_|{assert!(!matches!(effect,Effect::Sound{..}));EffectStatus::Completed}).unwrap();
 assert!(p.fallback(&f.history,&f.gate,||Err("pending_audio_unconfirmed".into())).is_err());assert!(f.gate.builtin().is_none());
 f.history.with_transaction_adapter(|a,c|{a.audio_ack(c,&key,&token,Playback::Playing)?;a.audio_ack(c,&key,&token,Playback::Cancelled)}).unwrap();audio.ack(token,Playback::Cancelled).unwrap();
 assert_eq!(crate::local_runtime::host_execution::live_effects::quota(f.history.lock().as_ref().unwrap()).unwrap().unknown,0);p.fallback(&f.history,&f.gate,||Ok(())).unwrap();assert!(f.gate.builtin().is_some());
}
#[test]
fn failed_emit_cannot_be_promoted_to_accepted_by_a_queued_durable_receipt() {
 use crate::game_sounds::audio_fence::AudioFence;
 let f=Fixture::new();let p=f.start();let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let audio=AudioFence::default();
 p.process(&f.manager,&f.history,&f.gate,f.frame(1,game),ReplayContext::default(),|_,_,_|EffectStatus::Completed).unwrap();
 let mut frame=f.frame(2,game);frame.snapshot.items.as_mut().unwrap().get_mut("slot8").unwrap().charges=Some(2);
 assert!(p.process(&f.manager,&f.history,&f.gate,frame,ReplayContext::default(),|_,_,a|{
  let token=audio.admit(Some(p.grant.lease),Some(p.grant.session_id().unwrap())).unwrap();f.history.with_transaction_adapter(|adapter,c|adapter.bind_audio(c,a,&token)).unwrap();
  EffectStatus::Unknown // emit failed and updating the observation may also have failed
 }).unwrap_err().contains("effect_result_unknown"));assert!(p.fallback(&f.history,&f.gate,||Ok(())).is_err());assert!(f.gate.builtin().is_none());
}
