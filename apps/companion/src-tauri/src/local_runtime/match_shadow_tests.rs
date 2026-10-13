//! Compare actual pre-write legacy decisions/SQLite execution with the real external worker.
use super::{detector,watchdog,store,schema,model::{RankedMode,LocalMatchState,MatchResult}};
use companion_dota_domain::{match_shadow as rules,contracts::{ReplayInput,ReplayContext}};
use crate::core::{dota_observer::project,plugin_runtime::Runtime};
use chrono::{DateTime,Utc,Duration};
use serde_json::{Value,json};
use rusqlite::Connection;
fn now(n:i64)->DateTime<Utc>{DateTime::from_timestamp(1700000000+n,0).unwrap()}
fn worker()->Runtime {
    let path=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/target/debug/companion-dota-plugin");
    let mut worker=Runtime::default();worker.start_expected(&path,&[],"dota2",Some("0.1.0")).unwrap();worker
}
fn tick(id:&str,hero:i64,state:&str,winner:Option<&str>)->Value {
    json!({"player":{"activity":"playing","team_name":"radiant"},"hero":{"id":hero},"map":{"matchid":id,"game_state":state,"win_team":winner}})
}
fn compare_and_apply(c:&mut Connection,w:&mut Runtime,s:&str,raw:Value,seq:u64) -> rules::Analysis {
    let projected=project(&raw).unwrap();
    let mut context=detector::context(c,s,RankedMode::Ranked,now(seq as i64)).unwrap();
    let session=store::find_session(c,s).unwrap().unwrap();context.session.streamed=session.is_streamed;context.session.ended=session.ended_at.is_some();
    context.frame_sequence=seq;context.snapshot_identity=rules::snapshot_identity(&projected);
    let expected=rules::analyze(&context,&projected,seq);
    let result=w.command("dota.replay".into(),serde_json::to_value(ReplayInput{sequence:seq,observed_at_ms:seq*100,snapshot:projected,context:ReplayContext::default(),match_context:Some(context.clone())}).unwrap()).unwrap();
    let actual:rules::Analysis=serde_json::from_value(result["matchAnalysis"].clone()).unwrap();
    assert_eq!(actual,expected);assert!(actual.conclusive);
    let snapshot=super::gsi::parse(&raw).unwrap();
    detector::handle_snapshot_with_context(c,s,&snapshot,context.captured_at,&context).unwrap();
    actual
}
#[test]
fn real_sqlite_lifecycle_and_external_decisions_share_identity_evidence_and_confidence() {
    let mut c=Connection::open_in_memory().unwrap();schema::migrate(&c).unwrap();store::set_current_rating(&mut c,1000).unwrap();let s=store::ensure_active_session(&mut c,now(0)).unwrap().local_id;let mut w=worker();
    let game="DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";let post="DOTA_GAMERULES_STATE_POST_GAME";
    compare_and_apply(&mut c,&mut w,&s,tick("111",14,game,None),1);
    let first=store::find_active_match(&c,&s).unwrap().unwrap().local_id;
    let a=compare_and_apply(&mut c,&mut w,&s,tick("111",105,game,None),2);
    assert_eq!(a.detector.unwrap().evidence,"same_match_resume");assert_eq!(store::find_active_match(&c,&s).unwrap().unwrap().local_id,first);
    compare_and_apply(&mut c,&mut w,&s,json!({"player":{"activity":"playing"},"map":{"game_state":game}}),3);
    compare_and_apply(&mut c,&mut w,&s,json!({"map":{"game_state":"menu"}}),4);
    assert_eq!(store::find_match(&c,&first).unwrap().unwrap().state,LocalMatchState::Interrupted);
    compare_and_apply(&mut c,&mut w,&s,tick("111",105,game,None),5);
    assert_eq!(store::find_active_match(&c,&s).unwrap().unwrap().local_id,first);
    compare_and_apply(&mut c,&mut w,&s,json!({"map":{"game_state":post,"matchid":"111","win_team":"radiant"}}),6);
    let a=compare_and_apply(&mut c,&mut w,&s,json!({"map":{"game_state":post,"matchid":"111","win_team":"radiant"}}),7);
    assert!(matches!(&a.detector.unwrap().actions[1],rules::Action::Finalize{local_id,confidence,..} if local_id==&first && confidence=="confirmed"));
    assert_eq!(store::find_match(&c,&first).unwrap().unwrap().result,Some(MatchResult::Win));assert_eq!(store::get_current_rating(&c).unwrap(),Some(1025));
    compare_and_apply(&mut c,&mut w,&s,tick("222",14,game,None),8);
    let second=store::find_active_match(&c,&s).unwrap().unwrap().local_id;
    compare_and_apply(&mut c,&mut w,&s,tick("222",14,post,Some("radiant")),9);
    compare_and_apply(&mut c,&mut w,&s,tick("222",14,post,Some("dire")),10);
    assert_eq!(store::find_match(&c,&second).unwrap().unwrap().state,LocalMatchState::NeedsReview);
    compare_and_apply(&mut c,&mut w,&s,tick("333",14,game,None),11);
    let third=store::find_active_match(&c,&s).unwrap().unwrap().local_id;
    compare_and_apply(&mut c,&mut w,&s,tick("333",14,post,None),12);
    compare_and_apply(&mut c,&mut w,&s,json!({"map":{"game_state":"menu"}}),13);
    assert_eq!(store::find_match(&c,&third).unwrap().unwrap().state,LocalMatchState::NeedsReview);
    compare_and_apply(&mut c,&mut w,&s,tick("444",14,game,None),14);
    compare_and_apply(&mut c,&mut w,&s,tick("444",14,post,Some("radiant")),15);
    let a=compare_and_apply(&mut c,&mut w,&s,json!({"map":{"game_state":"menu"}}),16);
    assert!(matches!(&a.detector.unwrap().actions[0],rules::Action::Finalize{confidence,..} if confidence=="probable"));
    compare_and_apply(&mut c,&mut w,&s,tick("555",14,game,None),17);
    store::finalize_session_end(&mut c,&s,now(18)).unwrap();
    compare_and_apply(&mut c,&mut w,&s,tick("555",105,game,None),19);
    assert_eq!(store::find_active_match(&c,&s).unwrap().unwrap().hero_id,105);w.stop().unwrap();
}
#[test]
fn watchdog_matches_actual_sql_cutoff_without_guessing_from_silence() {
    let mut c=Connection::open_in_memory().unwrap();schema::migrate(&c).unwrap();let s=store::ensure_active_session(&mut c,now(0)).unwrap();store::create_match(&c,&s.local_id,Some("42"),14,"radiant",RankedMode::Ranked,now(0)).unwrap();let mut w=worker();
    for (seq,at,ended) in [(1,now(60),false),(2,now(1200),false),(3,now(1201),true)] {
        if ended{store::finalize_session_end(&mut c,&s.local_id,at).unwrap();}
        let mut ctx=watchdog::shadow_context(&c,at).unwrap();ctx.frame_sequence=seq;
        let expected=rules::analyze(&ctx,&Default::default(),seq);
        let actual=w.command("dota.watchdog_shadow".into(),serde_json::to_value(ctx).unwrap()).unwrap();assert_eq!(actual["matchAnalysis"],serde_json::to_value(&expected).unwrap());
        let decision=expected.watchdog.unwrap();assert_eq!(decision.auto_interrupt,!store::find_stale_matches_with_ended_session(&c,at,rules::STALE_THRESHOLD).unwrap().is_empty());
        assert_eq!(decision.stale,seq>=2);assert_eq!(decision.auto_interrupt,ended);
    }
    // Real lexical SQL behavior at the Z vs +00:00 boundary is deliberately preserved.
    c.execute("UPDATE local_matches SET last_seen_at=?1",[now(0).to_rfc3339_opts(chrono::SecondsFormat::Secs,true)]).unwrap();
    let ctx=watchdog::shadow_context(&c,now(1200)).unwrap();let d=rules::watchdog(&ctx);
    assert!(d.stale);assert!(!d.auto_interrupt);assert!(store::find_stale_matches_with_ended_session(&c,now(1200),Duration::minutes(20)).unwrap().is_empty());w.stop().unwrap();
}

#[test]
fn read_only_context_contains_no_backend_data_and_bad_bindings_fail_inconclusive() {
    let mut c=Connection::open_in_memory().unwrap();schema::migrate(&c).unwrap();let s=store::ensure_active_session(&mut c,now(0)).unwrap();store::create_match(&c,&s.local_id,Some("42"),14,"radiant",RankedMode::Ranked,now(0)).unwrap();
    c.execute("UPDATE local_matches SET backend_id='SECRET'",[]).unwrap();c.execute("UPDATE local_sessions SET backend_id='SECRET'",[]).unwrap();
    let raw=tick("42",14,"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",None);let projected=project(&raw).unwrap();
    let mut context=detector::context(&c,&s.local_id,RankedMode::Ranked,now(1)).unwrap();context.frame_sequence=1;context.snapshot_identity=rules::snapshot_identity(&projected);
    assert!(!serde_json::to_string(&context).unwrap().contains("SECRET"));assert!(context.active.as_ref().unwrap().revision.is_none());
    assert!(!rules::analyze(&context,&projected,2).conclusive);
    context.active.as_mut().unwrap().last_seen_at=Some("invalid_timestamp".into());assert!(!rules::analyze(&context,&projected,1).conclusive);
    context.active.as_mut().unwrap().last_seen_at=Some(now(0).to_rfc3339());context.active.as_mut().unwrap().local_id="x".repeat(129);assert!(!rules::analyze(&context,&projected,1).conclusive);
    let mut injected=serde_json::to_value(context).unwrap();injected["sql"]=json!("SELECT secrets");assert!(serde_json::from_value::<rules::Context>(injected).is_err());
}
