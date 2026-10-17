use super::*;
use super::super::{transaction_tests as parity,model::{LocalMatchState,MatchResult}};
use serde_json::json;
fn now(n:i64)->DateTime<Utc>{DateTime::from_timestamp(1700000000+n,0).unwrap()}
fn frame(game:&str,state:&str,winner:Option<&str>)->ReplayGsi {
    companion_dota_domain::projection::project(&json!({"player":{"activity":"playing","team_name":"radiant","kills":4},"hero":{"id":105},"map":{"game_state":state,"matchid":game,"win_team":winner},"items":{"slot8":{"name":"item_tango","charges":3}}})).unwrap()
}
fn request(adapter:&mut FixtureAdapter,s:&str,key:&str,at:i64,snapshot:ReplayGsi)->Request {
    let prepared=adapter.prepare(s,snapshot,RankedMode::Ranked,now(at),at as u64).unwrap();
    let plan=rules::analyze(&prepared.data.context,&prepared.data.snapshot,at as u64).detector.unwrap();prepared.request(key,"correlation",plan)
}
fn worker()->companion_plugin_protocol::runtime::Runtime {
    let path=std::path::PathBuf::from(std::env::var_os("COMPANION_TEST_PLUGIN_DIR").unwrap_or_else(||std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/debug").into_os_string())).join(if cfg!(windows){"companion-dota-plugin.exe"}else{"companion-dota-plugin"});
    let mut w=companion_plugin_protocol::runtime::Runtime::default();w.start_expected(&path,&[],"dota2",Some(dota_package_version())).unwrap();w
}
pub use super::super::transaction_tests::legacy_apply;
#[test]
fn external_plan_full_write_set_parity_and_exact_identity_receipts() {
    let (fixture,s,m)=Fixture::seeded().unwrap();let old_path=fixture.root.path().join("legacy.sqlite3");std::fs::copy(&fixture.path,&old_path).unwrap();let mut old=Connection::open(&old_path).unwrap();let seed=parity::ids(&old);let mut adapter=Adapter::install(fixture).unwrap();let mut w=worker();
    let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let post="DOTA_GAMERULES_STATE_POST_GAME";
    let frames=[frame("42",game,None),frame("42","menu",None),frame("42",game,None),frame("42",post,Some("radiant")),frame("42",post,Some("radiant"))];
    for (i,snapshot) in frames.into_iter().enumerate(){
        let at=i as i64+1;let prepared=adapter.prepare(&s,snapshot.clone(),RankedMode::Ranked,now(at),at as u64).unwrap();
        let data=w.command("dota.replay".into(),serde_json::to_value(companion_dota_domain::contracts::ReplayInput{sequence:at as u64,observed_at_ms:at as u64*100,snapshot:snapshot.clone(),context:Default::default(),match_context:Some(prepared.data.context.clone())}).unwrap()).unwrap();
        let analysis:rules::Analysis=serde_json::from_value(data["matchAnalysis"].clone()).unwrap();assert!(analysis.conclusive);
        let req=prepared.request(&format!("op{i}"),"correlation",analysis.detector.unwrap());legacy_apply(&mut old,&s,&snapshot,at);
        let response=adapter.execute(&req).unwrap();assert_eq!(response.status,Status::Completed);let receipt=response.receipt.unwrap();
        assert!(receipt.operations.iter().filter_map(|o|o.post_state.as_ref()).all(|state|state.local_id==m));
        assert_eq!(parity::normalized(&old,&seed),parity::normalized(&adapter.conn,&seed),"frame {i}");
        let after=parity::dump(&adapter.conn);let dup=adapter.execute(&req).unwrap();assert_eq!(dup.receipt.as_ref(),Some(&receipt));assert_eq!(parity::dump(&adapter.conn),after);
    }
    assert_eq!(store::find_match(&adapter.conn,&m).unwrap().unwrap().state,LocalMatchState::Finalized);
    assert!(store::find_session(&adapter.conn,&s).unwrap().unwrap().ended_at.is_some());
    // Real manual/server correction kernels, never a plugin correction capability.
    for step in 0..4 {
        match step {
            0=>{store::correct_match_delta(&mut old,&m,Some(50)).unwrap();let tx=adapter.conn.transaction().unwrap();Facade::new(&tx).correct_delta(&m,Some(50)).unwrap();tx.commit().unwrap();},
            1=>{store::correct_match_ranked_mode(&mut old,&m,Some(RankedMode::Unranked)).unwrap();let tx=adapter.conn.transaction().unwrap();Facade::new(&tx).correct_mode(&m,Some(RankedMode::Unranked)).unwrap();tx.commit().unwrap();},
            2=>{store::correct_match_ranked_mode(&mut old,&m,None).unwrap();let tx=adapter.conn.transaction().unwrap();Facade::new(&tx).correct_mode(&m,None).unwrap();tx.commit().unwrap();},
            _=>{super::super::sync::apply_one_correction(&old,&m,50,Some(1050),Some(1050),Some(0)).unwrap();let tx=adapter.conn.transaction().unwrap();Facade::new(&tx).server_correction(&m,50,Some(1050),Some(1050),Some(0)).unwrap();tx.commit().unwrap();},
        }
        assert_eq!(parity::normalized(&old,&seed),parity::normalized(&adapter.conn,&seed),"correction {step}");
    }
    // Delivery bookkeeping is fixture SQL; no requests are sent.
    for c in [&old,&adapter.conn]{c.execute("UPDATE sync_outbox SET attempts=1,failed_at=?1,last_error='fixture_rejected'",[now(8).to_rfc3339()]).unwrap();}
    assert_eq!(parity::normalized(&old,&seed),parity::normalized(&adapter.conn,&seed));w.stop().unwrap();
}
#[test]
fn conditional_insert_ignore_resolves_original_uuid_key_and_actual_session_closure() {
    let (fixture,s,m)=Fixture::seeded().unwrap();let old_path=fixture.root.path().join("legacy.sqlite3");std::fs::copy(&fixture.path,&old_path).unwrap();let mut old=Connection::open(old_path).unwrap();
    // A historical terminal row already owns the incoming game key.
    for c in [&mut old,&mut fixture.connect().unwrap()] {
        store::create_match(c,&s,Some("duplicate"),14,"radiant",RankedMode::Ranked,now(-1)).unwrap();let row=store::diagnostic_find_key(c,&s,"gsi:duplicate").unwrap().unwrap();store::finalize_match(c,&row.local_id,&s,RankedMode::Ranked,MatchResult::Win,"confirmed",now(0)).unwrap();
        store::resume_match(c,&m,Some("old"),105).unwrap();
    }
    // New terminal UUIDs on each independent fixture are compared only by insertion ordinal.
    let seed=std::collections::BTreeSet::from([s.clone(),m.clone()]);let mut adapter=Adapter::install(fixture).unwrap();
    let snapshot=frame("duplicate","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);let req=request(&mut adapter,&s,"conditional",2,snapshot.clone());let prior=store::diagnostic_find_key(&adapter.conn,&s,"gsi:duplicate").unwrap().unwrap();
    legacy_apply(&mut old,&s,&snapshot,2);let receipt=adapter.execute(&req).unwrap().receipt.unwrap();
    let conflict=receipt.operations.iter().find(|o|o.disposition==Disposition::Conflicted).unwrap();let row=conflict.post_state.as_ref().unwrap();assert_eq!(row.local_id,prior.local_id);assert_eq!(row.match_key,prior.match_key);assert!(receipt.current_match.is_none());assert_eq!(receipt.session.unwrap().disposition,Disposition::Applied);
    assert_eq!(parity::normalized(&old,&seed),parity::normalized(&adapter.conn,&seed));
}
#[test]
fn external_plan_parity_for_partial_conflicting_probable_and_distinct_matches() {
    let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let post="DOTA_GAMERULES_STATE_POST_GAME";
    let partial=companion_dota_domain::projection::project(&json!({"map":{"game_state":game,"matchid":"42"},"player":{"activity":"playing"}})).unwrap();
    let cases=vec![
        vec![(1,frame("42",game,None)),(2,partial),(3,frame("42",post,None)),(4,frame("42","menu",None))],
        vec![(1,frame("42",game,None)),(2,frame("42",post,Some("radiant"))),(3,frame("42",post,Some("dire")))],
        vec![(1,frame("42",game,None)),(2,frame("42",post,Some("radiant"))),(3,frame("42","menu",None))],
        vec![(1,frame("42",game,None)),(2,frame("43",game,None))],
        vec![(1,frame("42",game,None)),(1300,frame("43",game,None))],
    ];
    let mut w=worker();
    for (scenario,frames) in cases.into_iter().enumerate() {
        w.command("dota.reset".into(),json!({})).unwrap();
        let (fixture,s,_)=Fixture::seeded().unwrap();let old_path=fixture.root.path().join("legacy.sqlite3");std::fs::copy(&fixture.path,&old_path).unwrap();let mut old=Connection::open(old_path).unwrap();let seed=parity::ids(&old);let mut adapter=Adapter::install(fixture).unwrap();
        for (sequence,(at,snapshot)) in frames.into_iter().enumerate() {
            let sequence=sequence as u64+1;let prepared=adapter.prepare(&s,snapshot.clone(),RankedMode::Ranked,now(at),sequence).unwrap();
            let data=w.command("dota.replay".into(),serde_json::to_value(companion_dota_domain::contracts::ReplayInput{sequence,observed_at_ms:at as u64*100,snapshot:snapshot.clone(),context:Default::default(),match_context:Some(prepared.data.context.clone())}).unwrap()).unwrap();
            let analysis:rules::Analysis=serde_json::from_value(data["matchAnalysis"].clone()).unwrap();assert!(analysis.conclusive);
            let req=prepared.request(&format!("scenario{scenario}:frame{sequence}"),"parity",analysis.detector.unwrap());legacy_apply(&mut old,&s,&snapshot,at);assert_eq!(adapter.execute(&req).unwrap().status,Status::Completed);
            assert_eq!(parity::normalized(&old,&seed),parity::normalized(&adapter.conn,&seed),"scenario {scenario}, frame {sequence}");
        }
    }
    w.stop().unwrap();
}
#[test]
fn bounded_requests_and_receipt_limits_roll_back_the_whole_write_set() {
    let (fixture,s,_)=Fixture::seeded().unwrap();let mut adapter=Adapter::install(fixture).unwrap();
    let mut req=request(&mut adapter,&s,"bounded",1,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));
    req.operation_key="x".repeat(129);assert_eq!(adapter.execute(&req).unwrap_err(),"invalid_request");
    req.operation_key="bounded".into();req.binding="wrong-binding".repeat(4);assert_eq!(adapter.execute(&req).unwrap_err(),"invalid_request");
    let tx=adapter.conn.transaction().unwrap();Facade::new(&tx).enqueue("session",&s,"fixture",&json!({"data":"x".repeat(65536)}),now(0)).unwrap();tx.commit().unwrap();
    req=request(&mut adapter,&s,"outbox-limit",2,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));let before=parity::dump(&adapter.conn);let revisions=preconditions(&adapter.conn,&s).unwrap();
    assert_eq!(adapter.execute(&req).unwrap_err(),"outbox_payload_limit");assert_eq!(parity::dump(&adapter.conn),before);assert_eq!(preconditions(&adapter.conn,&s).unwrap(),revisions);assert_eq!(adapter.recover(&req).unwrap().status,Status::Unknown);
}
#[test]
fn unchanged_values_still_report_applied_when_real_sql_writes_a_revision() {
    let (fixture,s,_)=Fixture::seeded().unwrap();let mut adapter=Adapter::install(fixture).unwrap();let snapshot=frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);
    let first=request(&mut adapter,&s,"first",1,snapshot.clone());adapter.execute(&first).unwrap();
    let second=request(&mut adapter,&s,"second",1,snapshot);let before=preconditions(&adapter.conn,&s).unwrap();let receipt=adapter.execute(&second).unwrap().receipt.unwrap();
    assert!(receipt.operations.iter().any(|o|o.disposition==Disposition::Applied));
    assert!(receipt.after.unwrap().match_revision.unwrap()>before.match_revision.unwrap());
}
#[test]
fn rollback_payload_conflict_stale_revision_invalid_plan_and_unknown_fail_closed() {
    let (fixture,s,_)=Fixture::seeded().unwrap();let mut adapter=Adapter::install(fixture.clone()).unwrap();let req=request(&mut adapter,&s,"op",1,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));let before=parity::dump(&adapter.conn);let epoch=preconditions(&adapter.conn,&s).unwrap();
    assert!(adapter.execute_fault(&req,Fault::RollbackAfterWrites).is_err());assert_eq!(parity::dump(&adapter.conn),before);assert_eq!(preconditions(&adapter.conn,&s).unwrap(),epoch);assert_eq!(adapter.recover(&req).unwrap().status,Status::Unknown);
    let receipt=adapter.execute(&req).unwrap();let mut conflict=req.clone();conflict.plan.evidence="changed".into();assert_eq!(adapter.execute(&conflict).unwrap_err(),"payload_conflict");assert_eq!(adapter.recover(&req).unwrap(),receipt);
    let stale=request(&mut adapter,&s,"stale",2,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));let other=fixture.connect().unwrap();other.execute("UPDATE local_matches SET kills=coalesce(kills,0)+1",[]).unwrap();
    let write_set=parity::dump(&adapter.conn);let rejected=adapter.execute(&stale).unwrap();assert_eq!(rejected.status,Status::Rejected);assert_eq!(rejected.receipt.unwrap().error.as_deref(),Some("stale_precondition"));assert_eq!(parity::dump(&adapter.conn),write_set);
    let mut forged=request(&mut adapter,&s,"forged",3,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));forged.plan.actions.clear();let rejected=adapter.execute(&forged).unwrap();assert_eq!(rejected.receipt.unwrap().error.as_deref(),Some("invalid_plan"));
    let unknown=request(&mut adapter,&s,"unknown",4,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));adapter.retain_unknown(&unknown).unwrap();let before=parity::dump(&adapter.conn);assert_eq!(adapter.execute(&unknown).unwrap().status,Status::Unknown);assert_eq!(adapter.recover(&unknown).unwrap().status,Status::Unknown);assert_eq!(parity::dump(&adapter.conn),before);
    drop(adapter);let mut reopened=Adapter::install(fixture).unwrap();assert_eq!(reopened.recover(&req).unwrap(),receipt);
    let mut fresh_corr=req.clone();fresh_corr.correlation_id="new-correlation".into();let response=reopened.execute(&fresh_corr).unwrap();assert_eq!(response.correlation_id,"new-correlation");assert_eq!(response.receipt,receipt.receipt);
}
#[test]
fn concurrent_resolution_returns_one_committed_identity_and_rejects_other_stale_tickets() {
    let (fixture,s,m)=Fixture::seeded().unwrap();let mut adapter=Adapter::install(fixture.clone()).unwrap();store::mark_needs_review(&adapter.conn,&m).unwrap();
    let req=request(&mut adapter,&s,"create",1,frame("new","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));let stale=request(&mut adapter,&s,"different-key",1,frame("new","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));
    let shared=Arc::new(std::sync::Mutex::new(adapter));let threads:Vec<_>=(0..2).map(|_|{let shared=shared.clone();let req=req.clone();std::thread::spawn(move||shared.lock().unwrap().execute(&req).unwrap())}).collect();let mut results=Vec::new();for thread in threads{results.push(thread.join().unwrap());}let mut adapter=Arc::try_unwrap(shared).unwrap_or_else(|_|panic!("still shared")).into_inner().unwrap();assert_eq!(results[0],results[1]);assert_eq!(adapter.execute(&stale).unwrap().status,Status::Rejected);
    assert_eq!(adapter.conn.query_row("SELECT count(*) FROM local_matches WHERE match_key='gsi:new'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}
#[test]
fn revision_policy_tracks_aba_tombstones_other_writers_and_counter_overflow() {
    let (fixture,s,m)=Fixture::seeded().unwrap();let adapter=Adapter::install(fixture.clone()).unwrap();let initial=revision(&adapter.conn,"local_matches",&m).unwrap();let other=fixture.connect().unwrap();
    other.execute("UPDATE local_matches SET kills=99 WHERE local_id=?1",[&m]).unwrap();other.execute("UPDATE local_matches SET kills=NULL WHERE local_id=?1",[&m]).unwrap();assert_eq!(revision(&adapter.conn,"local_matches",&m).unwrap(),initial+2);
    assert!(other.execute("UPDATE local_matches SET local_id='replacement' WHERE local_id=?1",[&m]).is_err());
    other.execute("DELETE FROM local_matches WHERE local_id=?1",[&m]).unwrap();assert_eq!(revision(&adapter.conn,"local_matches",&m).unwrap(),initial+3);assert_eq!(other.query_row("SELECT deleted FROM pc_tx_revision WHERE kind='local_matches' AND id=?1",[&m],|r|r.get::<_,i64>(0)).unwrap(),1);
    other.execute("INSERT INTO local_matches(local_id,session_local_id,match_key,hero_id,player_team,state,started_at) VALUES(?1,?2,'same-id',14,'radiant','in_progress',?3)",params![m,s,now(0).to_rfc3339()]).unwrap();assert_eq!(revision(&adapter.conn,"local_matches",&m).unwrap(),initial+4);
    other.execute("UPDATE pc_tx_epoch SET value=9223372036854775807",[]).unwrap();let before=parity::dump(&adapter.conn);assert!(other.execute("UPDATE local_matches SET kills=1",[]).is_err());assert_eq!(parity::dump(&adapter.conn),before);
}
#[test]
fn receipt_corruption_storage_corruption_and_missing_revision_triggers_refuse_execution() {
    let (fixture,s,_)=Fixture::seeded().unwrap();let mut adapter=Adapter::install(fixture.clone()).unwrap();let req=request(&mut adapter,&s,"op",1,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));adapter.execute(&req).unwrap();adapter.conn.execute("UPDATE pc_tx_receipts SET receipt='{}'",[]).unwrap();assert_eq!(adapter.recover(&req).unwrap_err(),"receipt_corrupt");
    adapter.conn.execute_batch("DROP TRIGGER pc_tx_write_sync_outbox_UPDATE").unwrap();assert!(adapter.execute(&req).is_err());drop(adapter);assert!(Adapter::install(fixture.clone()).is_err());
    std::fs::write(&fixture.path,b"corrupt fixture").unwrap();assert!(Adapter::install(fixture).is_err());
    let (fixture,_,_)=Fixture::seeded().unwrap();fixture.connect().unwrap().execute("UPDATE local_matches SET inventory='invalid-json'",[]).unwrap();assert!(Adapter::install(fixture).is_err());
}
#[test]
fn crash_child() {
    let Ok(root)=std::env::var("PC11_CHILD_ROOT")else{return;};
    // Only a marker created by this fixture harness can be adopted by the child test.
    assert_eq!(std::fs::read(std::path::Path::new(&root).join("fixture-marker")).unwrap(),b"pc11 test fixture");
    let root=Arc::new(FixtureRoot::CrashChild(PathBuf::from(root)));
    let fixture=Fixture{path:root.path().join("isolated.sqlite3"),root};let req:Request=serde_json::from_str(&std::env::var("PC11_CHILD_REQUEST").unwrap()).unwrap();let mut adapter=Adapter::install(fixture).unwrap();
    adapter.execute_fault(&req,if std::env::var("PC11_CHILD_FAULT").unwrap()=="before"{Fault::CrashBeforeCommit}else{Fault::CrashAfterCommit}).unwrap();panic!("child should exit");
}
#[test]
fn real_process_crash_before_commit_and_after_commit_before_reply() {
    for fault in ["before","after"] {
        let (fixture,s,_)=Fixture::seeded().unwrap();std::fs::write(fixture.root.path().join("fixture-marker"),b"pc11 test fixture").unwrap();let mut adapter=Adapter::install(fixture.clone()).unwrap();let req=request(&mut adapter,&s,"crash",1,frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None));let before=parity::dump(&adapter.conn);drop(adapter);
        let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","local_runtime::host_execution::tests::crash_child","--nocapture"]).env("PC11_CHILD_ROOT",fixture.root.path()).env("PC11_CHILD_REQUEST",encode(&req).unwrap()).env("PC11_CHILD_FAULT",fault).status().unwrap();assert_eq!(status.code(),Some(if fault=="before"{81}else{82}));
        let mut reopened=Adapter::install(fixture).unwrap();let recovered=reopened.recover(&req).unwrap();
        if fault=="before"{assert_eq!(recovered.status,Status::Unknown);assert_eq!(parity::dump(&reopened.conn),before);assert_eq!(preconditions(&reopened.conn,&s).unwrap(),req.preconditions);}
        else{assert_eq!(recovered.status,Status::Completed);let committed=parity::dump(&reopened.conn);assert_eq!(reopened.execute(&req).unwrap(),recovered);assert_eq!(parity::dump(&reopened.conn),committed);}
    }
}

#[test]
fn rolling_telemetry_preserves_writes_and_rejects_old_sequence_pending_and_unknown() {
 use companion_dota_domain::ownership::{Owner,Lease};
 use crate::local_runtime::transaction_authorization as auth;
 let (fixture,s,m)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
 let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&s).unwrap();
 let snapshot=frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);
 let initial=h.prepare(&s,snapshot.clone(),RankedMode::Ranked,now(1),1).unwrap();let req=initial.core_request("initial","initial").unwrap();h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).unwrap();
 let before=revision(&h.conn,"local_matches",&m).unwrap();
 let mut previous=None;
 for sequence in 2..=20 {
  let prepared=h.adapter.prepare_internal(&mut h.conn,&s,snapshot.clone(),RankedMode::Ranked,now(sequence as i64),sequence,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).unwrap().unwrap();
  assert!(prepared.ticket.starts_with("telemetry:"));
  let request=prepared.core_request(&prepared.ticket,"telemetry").unwrap();
  if let Some(old)=&previous {assert!(h.adapter.execute_builtin(&mut h.conn,lease,&s,old).is_err());}
  let result=h.adapter.execute_builtin(&mut h.conn,lease,&s,&request).unwrap();assert_eq!(result.status,Status::Completed);
  assert_eq!(h.adapter.execute_builtin(&mut h.conn,lease,&s,&request).unwrap().receipt,result.receipt);
  previous=Some(request);
 }
 assert_eq!(h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get::<_,u64>(0)).unwrap(),2);
 assert!(revision(&h.conn,"local_matches",&m).unwrap()>before+18); // resume + telemetry on every tick
 assert!(h.adapter.prepare_internal(&mut h.conn,&s,snapshot.clone(),RankedMode::Ranked,now(20),20,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).is_err());
 let prepared=h.adapter.prepare_internal(&mut h.conn,&s,snapshot.clone(),RankedMode::Ranked,now(21),21,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).unwrap().unwrap();
 assert!(h.adapter.prepare_internal(&mut h.conn,&s,snapshot,RankedMode::Ranked,now(22),22,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).is_err());
 let req=prepared.core_request(&prepared.ticket,"telemetry").unwrap();
 h.conn.execute("UPDATE pc_tx_ledger SET status='unknown' WHERE operation_key=?1",[&req.operation_key]).unwrap();
 assert!(h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).is_err());
}

#[test]
#[ignore = "explicit long-stream budget check; targeted invocation only"]
fn eight_hour_telemetry_storage_budget() {
 use companion_dota_domain::ownership::{Owner,Lease};
 use crate::local_runtime::transaction_authorization as auth;
 let (fixture,s,m)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
 let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&s).unwrap();
 let snapshot=frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);
 let initial=h.prepare(&s,snapshot.clone(),RankedMode::Ranked,now(1),1).unwrap();let req=initial.core_request("initial","initial").unwrap();h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).unwrap();
 // WAL stays enabled. Both production preparation and execution run on EVERY frame.
 let frames=std::env::var("COMPANION_TELEMETRY_FRAMES").ok().map(|v|v.parse::<u64>().unwrap()).unwrap_or(288000);
 let started=std::time::Instant::now();let before=revision(&h.conn,"local_matches",&m).unwrap();
 for sequence in 2..=frames+1 {
  let at=now(1)+chrono::Duration::milliseconds(sequence as i64*100);
  let prepared=h.adapter.prepare_internal(&mut h.conn,&s,snapshot.clone(),RankedMode::Ranked,at,sequence,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).unwrap().unwrap();
  let req=prepared.core_request(&prepared.ticket,"telemetry-budget").unwrap();
  assert_eq!(h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).unwrap().status,Status::Completed);
  if sequence%10000==0 {println!("frames={sequence} elapsed={:?}",started.elapsed());}
 }
 let quota=super::live_effects::quota(&h.conn).unwrap();
 let rows:u64=h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();
 let receipt_bytes:u64=h.conn.query_row("SELECT bytes FROM pc_tx_usage WHERE kind='pc_tx_receipts'",[],|r|r.get(0)).unwrap();
 let ticket_bytes:u64=h.conn.query_row("SELECT bytes FROM pc_tx_usage WHERE kind='pc_tx_ticket'",[],|r|r.get(0)).unwrap();
 println!("frames={frames} ledger_rows={rows} receipt_bytes={receipt_bytes} ticket_bytes={ticket_bytes} quota={quota:?} elapsed={:?}",started.elapsed());
 assert_eq!(rows,2);assert_eq!(quota.remaining_operations,9998);assert_eq!(quota.remaining_tickets,9998);assert_eq!(quota.unknown,0);
 assert!(receipt_bytes<32768);assert!(ticket_bytes<16384);
 assert_eq!(revision(&h.conn,"local_matches",&m).unwrap(),before+frames*2);
 crate::local_runtime::transaction_schema::validate(&h.conn).unwrap();
}

#[test]
fn rolling_telemetry_restart_fences_old_slots_and_aba_changes_are_not_hidden() {
 use companion_dota_domain::ownership::{Owner,Lease};
 use crate::local_runtime::transaction_authorization as auth;
 let (fixture,s,m)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture.clone()).unwrap();
 let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&s).unwrap();
 let snapshot=frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);
 let p=h.prepare(&s,snapshot.clone(),RankedMode::Ranked,now(1),1).unwrap();let req=p.core_request("initial","initial").unwrap();h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).unwrap();
 let p=h.adapter.prepare_internal(&mut h.conn,&s,snapshot.clone(),RankedMode::Ranked,now(2),2,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).unwrap().unwrap();
 let old=p.core_request(&p.ticket,"old").unwrap();let receipt=h.adapter.execute_builtin(&mut h.conn,lease,&s,&old).unwrap().receipt;
 drop(h);let mut c=fixture.connect().unwrap();let mut adapter=Adapter::attach(&mut c).unwrap();
 assert!(adapter.execute_builtin(&mut c,lease,&s,&old).is_err());
 let next=auth::confirm_fenced(&mut c,lease).unwrap();auth::bind_builtin_session(&mut c,next,&s).unwrap();
 assert!(adapter.execute_builtin(&mut c,lease,&s,&old).is_err()); // old epoch cannot replay a saved receipt
 let p=adapter.prepare_internal(&mut c,&s,snapshot.clone(),RankedMode::Ranked,now(3),1,true,Some(next),&|tx|auth::authorize_scope(tx,next,&s,None)).unwrap().unwrap();
 assert_ne!(old.ticket,p.ticket);let fresh=p.core_request(&p.ticket,"new").unwrap();adapter.execute_builtin(&mut c,next,&s,&fresh).unwrap();
 assert_eq!(saved(&c,&old).unwrap().unwrap().receipt,receipt); // retained, never deleted
 let p=adapter.prepare_internal(&mut c,&s,snapshot,RankedMode::Ranked,now(4),2,true,Some(next),&|tx|auth::authorize_scope(tx,next,&s,None)).unwrap().unwrap();
 let stale=p.core_request(&p.ticket,"aba").unwrap();
 store::mark_interrupted(&c,&m,now(4)).unwrap();store::resume_match(&c,&m,Some("42"),105).unwrap();
 let before=parity::dump(&c);
 let reply=adapter.execute_builtin(&mut c,next,&s,&stale).unwrap();assert_eq!(reply.status,Status::Rejected);
 assert_eq!(reply.receipt.unwrap().error.as_deref(),Some("stale_precondition"));assert_eq!(parity::dump(&c),before);
 drop(adapter);
 assert_eq!(crate::local_runtime::transaction_schema::restore_before_writes(&mut c,&fixture.root.path().join("verified-backup.sqlite3")).unwrap_err(),"unsafe_backup_restore_denied");
}

#[test]
fn rolling_telemetry_rollback_preserves_full_write_set_and_requires_commit_confirmation() {
 use companion_dota_domain::ownership::{Owner,Lease};
 use crate::local_runtime::transaction_authorization as auth;
 let (fixture,s,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
 let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&s).unwrap();
 let snapshot=frame("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);
 let initial=h.prepare(&s,snapshot.clone(),RankedMode::Ranked,now(1),1).unwrap();let req=initial.core_request("initial","initial").unwrap();h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).unwrap();
 let p=h.adapter.prepare_internal(&mut h.conn,&s,snapshot.clone(),RankedMode::Ranked,now(2),2,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).unwrap().unwrap();
 let req=p.core_request(&p.ticket,"rollback").unwrap();let before=parity::dump(&h.conn);
 assert_eq!(h.adapter.execute_guarded(&mut h.conn,&req,Fault::RollbackAfterWrites,&|tx|auth::authorize(tx,lease,&s,None,&req)).unwrap_err(),"injected_rollback");
 assert_eq!(parity::dump(&h.conn),before);assert!(saved(&h.conn,&req).unwrap().is_none());
 assert!(h.adapter.prepare_internal(&mut h.conn,&s,snapshot,RankedMode::Ranked,now(3),3,true,Some(lease),&|tx|auth::authorize_scope(tx,lease,&s,None)).is_err());
 assert_eq!(h.adapter.execute_builtin(&mut h.conn,lease,&s,&req).unwrap().status,Status::Completed);
}
