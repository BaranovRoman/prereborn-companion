use super::*;
use serde_json::{json,Value};
use super::super::super::transaction_tests as parity;
fn now(n:i64)->DateTime<Utc>{DateTime::from_timestamp(1700000000+n,0).unwrap()}
fn snapshot(game:&str,state:&str)->ReplayGsi {
    companion_dota_domain::projection::project(&json!({"player":{"activity":"playing","team_name":"radiant","kills":3},"hero":{"id":105},"map":{"game_state":state,"matchid":game,"win_team":"radiant"}})).unwrap()
}
fn setup()->(Host,Fixture,String,String) {
    let(fixture,s,m)=Fixture::seeded().unwrap();let mut host=Host::open(fixture.clone(),&s).unwrap();host.start().unwrap();(host,fixture,s,m)
}
fn send(host:&mut Host,frame:DiagnosticFrame)->Value {host.roundtrip("dota.diagnostic_frame",serde_json::to_value(frame).unwrap(),Fault::None).unwrap()}
fn receipt(value:&Value)->Receipt {let DiagnosticReply::Result{response}=serde_json::from_value(value["reply"].clone()).unwrap()else{panic!("expected result: {value}")};assert_eq!(response.status,Status::Completed);response.receipt.unwrap()}
fn recovery(host:&mut Host,request:Request)->Value {
    let args=DiagnosticRequest::Recover{scope:host.scope.clone(),request};host.roundtrip("dota.diagnostic_recover",serde_json::to_value(args).unwrap(),Fault::None).unwrap()
}
#[test]
fn ipc_chain_uses_resolved_identity_and_confirmed_post_state_for_next_frames() {
    let(mut host,fixture,s,m)=setup();let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";
    let legacy_path=fixture.root.path().join("ipc-legacy.sqlite3");std::fs::copy(&fixture.path,&legacy_path).unwrap();let mut legacy=Connection::open(legacy_path).unwrap();let seed=parity::ids(&legacy);
    for (seq,state) in [game,"menu",game,"DOTA_GAMERULES_STATE_POST_GAME","DOTA_GAMERULES_STATE_POST_GAME"].into_iter().enumerate() {
        let frame=host.frame(snapshot("42",state),now(seq as i64+1),seq as u64+1,&format!("frame{seq}")).unwrap();
        if let Some(prior)=&host.confirmed {assert_eq!(frame.context.active,prior.current_context);assert_eq!(Some(&frame.preconditions),prior.after.as_ref());}
        let raw=frame.snapshot.clone();let committed=receipt(&send(&mut host,frame));
        super::super::tests::legacy_apply(&mut legacy,&s,&raw,seq as i64+1);
        assert_eq!(parity::normalized(&legacy,&seed),parity::normalized(&host.adapter.conn,&seed),"IPC frame {seq}");
        assert!(committed.operations.iter().filter_map(|o|o.post_state.as_ref()).all(|row|row.local_id==m));
        assert_eq!(committed.session.as_ref().unwrap().local_id,s);
    }
    let final_receipt=host.confirmed.as_ref().unwrap();assert!(final_receipt.current_context.is_none());assert!(final_receipt.session.as_ref().unwrap().ended_at.is_some());
    host.runtime.stop().unwrap();
}
#[test]
fn conditional_ignore_receipt_resolves_existing_uuid_then_resume_and_closure() {
    let(fixture,s,m)=Fixture::seeded().unwrap();let c=fixture.connect().unwrap();store::mark_needs_review(&c,&m).unwrap();
    store::create_match(&c,&s,Some("duplicate"),14,"radiant",RankedMode::Ranked,now(-2)).unwrap();let prior=store::diagnostic_find_key(&c,&s,"gsi:duplicate").unwrap().unwrap();store::mark_interrupted(&c,&prior.local_id,now(-1)).unwrap();
    store::create_match(&c,&s,Some("old"),14,"radiant",RankedMode::Ranked,now(0)).unwrap();drop(c);
    let mut host=Host::open(fixture,&s).unwrap();host.start().unwrap();
    let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let frame=host.frame(snapshot("duplicate",game),now(1),1,"conditional").unwrap();let first=receipt(&send(&mut host,frame));
    let conflict=first.operations.iter().find(|o|o.disposition==Disposition::Conflicted).unwrap().post_state.as_ref().unwrap();assert_eq!(conflict.local_id,prior.local_id);assert_eq!(conflict.match_key,"gsi:duplicate");
    for (seq,state) in [(2,game),(3,"DOTA_GAMERULES_STATE_POST_GAME"),(4,"DOTA_GAMERULES_STATE_POST_GAME")] {
        let frame=host.frame(snapshot("duplicate",state),now(seq),seq as u64,&format!("next{seq}")).unwrap();assert_eq!(frame.context.active.as_ref().unwrap().local_id,prior.local_id);let result=receipt(&send(&mut host,frame));
        if let Some(active)=&result.current_match {assert_eq!(active.local_id,prior.local_id);assert_eq!(active.game_id.as_deref(),Some("duplicate"));}
    }
    assert!(host.confirmed.as_ref().unwrap().session.as_ref().unwrap().ended_at.is_some());host.runtime.stop().unwrap();
}
#[test]
fn duplicate_receipt_payload_conflict_unknown_and_revision_staleness_over_ipc() {
    let(mut host,_,_,_)=setup();let frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(1),1,"op").unwrap();let result=send(&mut host,frame);let committed=receipt(&result);
    let DiagnosticRequest::Execute{request,..}=serde_json::from_value(result["request"].clone()).unwrap()else{panic!()};
    let before=parity::dump(&host.adapter.conn);assert_eq!(receipt(&recovery(&mut host,request.clone())),committed);assert_eq!(parity::dump(&host.adapter.conn),before);
    let next=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(2),2,"next").unwrap();let latest=receipt(&send(&mut host,next));
    assert_eq!(receipt(&recovery(&mut host,request.clone())),committed);assert_eq!(host.confirmed.as_ref(),Some(&latest));
    let next=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(3),3,"third").unwrap();receipt(&send(&mut host,next));
    let mut conflicting=request.clone();conflicting.plan.evidence="different".into();assert_eq!(recovery(&mut host,conflicting)["reply"]["code"],"payload_conflict");host.restart().unwrap();
    let frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(2),2,"unknown").unwrap();let prepared=host.expected.as_ref().unwrap();let op=prepared.request("unknown","frame:2",rules::analyze(&prepared.data.context,&prepared.data.snapshot,2).detector.unwrap());host.adapter.retain_unknown(&op).unwrap();
    let result=send(&mut host,frame);assert_eq!(result["reply"]["response"]["status"],"unknown");assert!(result["confirmedContext"].is_null());assert_eq!(host.frame(snapshot("42","menu"),now(3),3,"no").unwrap_err(),"diagnostic_reset_required");
    host.restart().unwrap();let frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(4),4,"stale").unwrap();host.adapter.conn.execute("UPDATE local_matches SET kills=9",[]).unwrap();
    let result=send(&mut host,frame);assert_eq!(result["reply"]["response"]["status"],"rejected");assert_eq!(result["reply"]["response"]["receipt"]["error"],"stale_precondition");host.runtime.stop().unwrap();
}
#[test]
fn ownership_scope_phase_snapshot_and_reconnect_fences_over_ipc() {
    for mode in ["epoch","session","draining","vacant","snapshot"] {
        let(mut host,_,_,_)=setup();let mut frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(1),1,"fenced").unwrap();let before=parity::dump(&host.adapter.conn);
        match mode {
            "epoch"=>frame.scope.epoch+=1,
            "session"=>{frame.scope.session="other-session".into();frame.context.session.local_id="other-session".into();frame.context.active.as_mut().unwrap().session_local_id="other-session".into();},
            "snapshot"=>frame.context.snapshot_identity="0".repeat(64),
            "draining"=>host.draining().unwrap(),
            "vacant"=>{let mut value=owner(&host.adapter.conn).unwrap().unwrap();value.phase=Phase::Vacant{epoch:host.scope.epoch};save(&host.adapter.conn,&value).unwrap();},
            _=>unreachable!(),
        }
        let result=host.roundtrip("dota.diagnostic_frame",serde_json::to_value(frame).unwrap(),Fault::None);
        if mode=="snapshot" {assert!(result.unwrap_err().contains("unbound_snapshot"));}else{let value=result.unwrap();assert_eq!(value["reply"]["kind"],"denied");}
        assert_eq!(parity::dump(&host.adapter.conn),before);host.runtime.stop().unwrap();
    }
    let(mut host,_,_,_)=setup();let old=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(1),1,"old").unwrap();let epoch=host.scope.epoch;host.restart().unwrap();assert!(host.scope.epoch>epoch);
    let value=send(&mut host,old);assert_eq!(value["reply"]["code"],"ownership_fenced");host.restart().unwrap();
    // A dropped-frame reset starts with a fresh scope and authoritative store context.
    let frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(5),5,"after-loss").unwrap();receipt(&send(&mut host,frame));host.runtime.stop().unwrap();
}
#[test]
fn opening_active_fixture_stays_draining_until_confirmed_fence() {
    let(mut host,fixture,s,_)=setup();let old=host.scope.epoch;assert!(matches!(Host::open(fixture.clone(),&s),Err(e) if e=="second_coordinator_denied"));
    host.runtime.stop().unwrap();drop(host);let mut reopened=Host::open(fixture,&s).unwrap();assert!(matches!(owner(&reopened.adapter.conn).unwrap().unwrap().phase,Phase::Draining{..}));assert!(reopened.start().is_err());assert_eq!(reopened.restart().unwrap_err(),"fence_confirmation_required");
    reopened.confirm_reaped().unwrap();reopened.start().unwrap();assert!(reopened.scope.epoch>old);reopened.runtime.stop().unwrap();
}
#[cfg(unix)]
#[test]
fn host_checks_forged_fingerprint_inside_transaction_even_if_worker_bypasses_validation() {
    use std::os::unix::fs::PermissionsExt;
    let(mut host,fixture,_,_)=setup();let frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(1),1,"forged").unwrap();let expected=host.expected.clone().unwrap();
    host.runtime.stop().unwrap(); // Reap real worker before using an adversarial test process.
    let request=DiagnosticRequest::Execute{scope:host.scope.clone(),sequence:1,snapshot_identity:"0".repeat(64),request:expected.request("forged","frame:1",rules::analyze(&frame.context,&frame.snapshot,1).detector.unwrap())};
    let path=fixture.root.path().join("forged-worker");let ready=json!({"protocol":1,"message":{"type":"ready","id":"dota2","version":"0.1.0","min_core_api":companion_plugin_protocol::CORE_API,"max_core_api":companion_plugin_protocol::CORE_API}});
    let reverse=json!({"protocol":1,"message":{"type":"diagnostic_execute","id":1,"request":request}});let reply=json!({"protocol":1,"message":{"type":"reply","id":1,"result":{}}});
    std::fs::write(&path,format!("#!/bin/sh\nread line\nprintf '%s\\n' '{ready}'\nread line\nprintf '%s\\n' '{reverse}'\nread line\nprintf '%s\\n' '{reply}'\n")).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut runtime=Runtime::default();runtime.start_expected(&path,&[],"dota2",Some("0.1.0")).unwrap();let before=parity::dump(&host.adapter.conn);let mut refusal=None;
    runtime.command_diagnostic("dota.diagnostic_frame".into(),json!({}),&[DIAGNOSTIC_CAPABILITY],|raw| {
        let req:DiagnosticRequest=serde_json::from_value(raw).unwrap();let error=dispatch(&mut host.adapter,&host.scope,Some(&expected),&req,Fault::None).unwrap_err();refusal=Some(error.clone());Ok(json!({"kind":"denied","code":error}))
    }).unwrap();assert_eq!(refusal.as_deref(),Some("snapshot_mismatch"));assert_eq!(parity::dump(&host.adapter.conn),before);let _=runtime.stop();runtime.stop().unwrap();
}

#[cfg(unix)]
#[test]
fn ipc_crash_child() {
    let Ok(root)=std::env::var("PC12_ROOT")else{return;};let path=PathBuf::from(root);assert_eq!(std::fs::read(path.join("fixture-marker")).unwrap(),b"pc11 test fixture");
    let fixture=Fixture{path:path.join("isolated.sqlite3"),root:Arc::new(FixtureRoot::CrashChild(path.clone()))};let mut frame:DiagnosticFrame=serde_json::from_str(&std::env::var("PC12_FRAME").unwrap()).unwrap();
    let mut host=Host::open(fixture,&frame.scope.session).unwrap();host.start().unwrap();frame.scope=host.scope.clone();host.expected=Some(Prepared{ticket:frame.ticket.clone(),binding:frame.binding.clone(),data:Ticket{context:frame.context.clone(),snapshot:frame.snapshot.clone(),preconditions:frame.preconditions.clone()},core_context:None});
    std::fs::write(path.join("worker-pid"),host.runtime.diagnostic_process_id().unwrap().to_string()).unwrap();
    let fault=if std::env::var("PC12_FAULT").unwrap()=="before"{Fault::CrashBeforeCommit}else{Fault::CrashAfterCommit};host.roundtrip("dota.diagnostic_frame",serde_json::to_value(frame).unwrap(),fault).unwrap();panic!("expected crash");
}
#[cfg(unix)]
#[test]
fn actual_host_crash_before_commit_and_after_commit_before_ipc_reply_recovers() {
    for fault in ["before","after"] {
        let(mut host,fixture,s,_)=setup();std::fs::write(fixture.root.path().join("fixture-marker"),b"pc11 test fixture").unwrap();let frame=host.frame(snapshot("42","DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"),now(1),1,"crash").unwrap();
        let req=host.expected.as_ref().unwrap().request("crash","frame:1",rules::analyze(&frame.context,&frame.snapshot,1).detector.unwrap());let before=parity::dump(&host.adapter.conn);host.runtime.stop().unwrap();host.confirm_reaped().unwrap();drop(host);
        let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","local_runtime::host_execution::bridge::tests::ipc_crash_child","--nocapture"]).env("PC12_ROOT",fixture.root.path()).env("PC12_FRAME",encode(&frame).unwrap()).env("PC12_FAULT",fault).status().unwrap();assert_eq!(status.code(),Some(if fault=="before"{81}else{82}));
        let pid=std::fs::read_to_string(fixture.root.path().join("worker-pid")).unwrap();let mut exited=false;
        for _ in 0..40 {let status=std::process::Command::new("/bin/ps").args(["-p",&pid,"-o","stat="]).output().unwrap();let state=String::from_utf8(status.stdout).unwrap();if state.trim().is_empty()||state.trim().starts_with('Z'){exited=true;break;}std::thread::sleep(Duration::from_millis(25));}assert!(exited,"orphan must be fenced before recovery");
        let mut reopened=Host::open(fixture,&s).unwrap();assert!(reopened.start().is_err());reopened.confirm_reaped().unwrap();reopened.start().unwrap();let result=recovery(&mut reopened,req.clone());
        if fault=="before"{assert_eq!(result["reply"]["response"]["status"],"unknown");assert_eq!(parity::dump(&reopened.adapter.conn),before);}
        else {let committed=receipt(&result);let after=parity::dump(&reopened.adapter.conn);assert_eq!(receipt(&recovery(&mut reopened,req)),committed);assert_eq!(parity::dump(&reopened.adapter.conn),after);}
        reopened.runtime.stop().unwrap();
    }
}
