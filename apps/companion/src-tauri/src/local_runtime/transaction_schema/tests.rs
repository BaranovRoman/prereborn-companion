use super::*;
use super::super::{transaction_tests as parity,host_execution::{Adapter,Fixture,preconditions},transaction_authorization as auth,store,model::RankedMode};
use companion_dota_domain::{ownership::{Phase,Owner,Lease},match_shadow as rules,effects::Status};
use chrono::{DateTime,Utc};
fn now(n:i64)->DateTime<Utc>{DateTime::from_timestamp(1700000000+n,0).unwrap()}
#[test]
fn cold_switch_storage_status_distinguishes_unprepared_from_incompatible_without_writes() {
 let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();let before=parity::dump(&c);
 assert!(!namespace_prepared(&c).unwrap());assert_eq!(parity::dump(&c),before);
 migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).unwrap();assert!(namespace_prepared(&c).unwrap());
 let(fixture,_,_)=Fixture::seeded().unwrap();let c=fixture.connect().unwrap();c.execute_batch("CREATE TABLE pc_tx_partial(id INTEGER)").unwrap();assert!(namespace_prepared(&c).is_err());
 let(fixture,_,_)=Fixture::seeded().unwrap();let c=fixture.connect().unwrap();c.pragma_update(None,"user_version",999).unwrap();assert_eq!(namespace_prepared(&c).unwrap_err(),"schema_incompatible");
}
#[test]
fn explicit_migration_verified_wal_backup_idempotence_and_legacy_rows() {
    let(fixture,s,m)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();let before=parity::dump(&c);let old_version=schema::version();
    let backup=fixture.root.path().join("backup.sqlite3");migrate(&mut c,&backup).unwrap();assert_eq!(parity::dump(&c),before);assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),old_version);
    assert_eq!(parity::dump(&super::backup(&backup).unwrap()),before);migrate(&mut c,&backup).unwrap();drop(c);
    let c=fixture.connect().unwrap();validate(&c).unwrap();assert!(store::find_session(&c,&s).unwrap().is_some());assert_eq!(store::find_match(&c,&m).unwrap().unwrap().local_id,m);
}
#[test]
fn backup_rollback_before_writes_retains_safety_tables_and_advances_builtin_epoch() {
    let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();let backup=fixture.root.path().join("backup.sqlite3");let before=parity::dump(&c);migrate(&mut c,&backup).unwrap();
    restore_before_writes(&mut c,&backup).unwrap();validate(&c).unwrap();assert_eq!(parity::dump(&c),before);assert!(matches!(auth::phase(&c).unwrap(),Phase::Active(Lease{owner:Owner::BuiltIn,epoch:2})));
    assert_eq!(restore_before_writes(&mut c,&backup).unwrap_err(),"unsafe_backup_restore_denied");
    let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();let backup=fixture.root.path().join("backup.sqlite3");migrate(&mut c,&backup).unwrap();store::set_current_rating(&mut c,1200).unwrap();assert_eq!(restore_before_writes(&mut c,&backup).unwrap_err(),"unsafe_backup_restore_denied");
}
#[test]
fn production_adapter_is_borrowed_exclusive_authorized_and_reopen_recovers_receipts() {
    let(fixture,s,m)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).unwrap();let mut adapter=Adapter::attach(&mut c).unwrap();
    let mut second=fixture.connect().unwrap();assert!(matches!(Adapter::attach(&mut second),Err(e) if e=="second_coordinator_denied"));
    let old=Lease{owner:Owner::BuiltIn,epoch:1};assert!(matches!(auth::phase(&c).unwrap(),Phase::Draining{..}));let lease=auth::confirm_fenced(&mut c,old).unwrap();auth::bind_builtin_session(&mut c,lease,&s).unwrap();
    let snapshot=crate::core::dota_observer::project(&serde_json::json!({"player":{"activity":"playing","team_name":"radiant"},"hero":{"id":105},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":"42"}})).unwrap();
    let prepared=adapter.prepare(&mut c,&s,snapshot,RankedMode::Ranked,now(2),1).unwrap();let request=prepared.request("stable-key","correlation",rules::analyze(&prepared.data.context,&prepared.data.snapshot,1).detector.unwrap());
    assert!(adapter.execute_builtin(&mut c,old,&s,&request).is_err());let response=adapter.execute_builtin(&mut c,lease,&s,&request).unwrap();assert_eq!(response.status,Status::Completed);assert_eq!(response.receipt.as_ref().unwrap().current_match.as_ref().unwrap().local_id,m);
    let committed=parity::dump(&c);assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&request).unwrap(),response);assert_eq!(parity::dump(&c),committed);
    let mut conflict=request.clone();conflict.plan.evidence="conflict".into();assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&conflict).unwrap_err(),"payload_conflict");
    drop(adapter);drop(c);let mut c=fixture.connect().unwrap();let mut adapter=Adapter::attach(&mut c).unwrap();assert!(adapter.recover_builtin(&mut c,lease,&s,&request).is_err());let next=auth::confirm_fenced(&mut c,lease).unwrap();assert!(next.epoch>lease.epoch);assert_eq!(adapter.recover_builtin(&mut c,next,&s,&request).unwrap(),response);assert_eq!(parity::dump(&c),committed);
    assert_eq!(preconditions(&c,&s).unwrap(),response.receipt.unwrap().after.unwrap());
}
#[test]
fn damaged_unknown_schema_and_partial_reserved_schema_fail_closed_without_mutation() {
    let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();c.pragma_update(None,"user_version",999).unwrap();let before=parity::dump(&c);assert!(migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).is_err());assert_eq!(parity::dump(&c),before);
    let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();c.execute_batch("CREATE TABLE pc_tx_partial(id INTEGER)").unwrap();assert!(migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).is_err());
    let(fixture,_,_)=Fixture::seeded().unwrap();std::fs::write(&fixture.path,b"damaged sqlite").unwrap();let mut c=fixture.connect().unwrap();assert!(migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).is_err());assert_eq!(std::fs::read(&fixture.path).unwrap(),b"damaged sqlite");
}
#[test]
fn ordinary_legacy_schema_start_does_not_install_safety_or_change_data() {
    let(fixture,_,_)=Fixture::seeded().unwrap();let c=fixture.connect().unwrap();let before=parity::dump(&c);schema::migrate(&c).unwrap();assert_eq!(parity::dump(&c),before);assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc_tx_%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn quotas_roll_back_all_writes_keep_receipts_and_never_delete_unknown_keys() {
    let(fixture,s,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).unwrap();let mut adapter=Adapter::attach(&mut c).unwrap();let lease=auth::confirm_fenced(&mut c,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut c,lease,&s).unwrap();
    let snapshot=crate::core::dota_observer::project(&serde_json::json!({"player":{"activity":"playing","team_name":"radiant"},"hero":{"id":105},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":"42"}})).unwrap();
    let first=adapter.prepare(&mut c,&s,snapshot.clone(),RankedMode::Ranked,now(1),1).unwrap().core_request("first","first").unwrap();let response=adapter.execute_builtin(&mut c,lease,&s,&first).unwrap();
    c.execute("UPDATE pc_tx_limits SET max_operations=1",[]).unwrap();let second=adapter.prepare(&mut c,&s,snapshot.clone(),RankedMode::Ranked,now(2),2).unwrap().core_request("second","second").unwrap();let before=parity::dump(&c);let before_revision=preconditions(&c,&s).unwrap();
    assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&second).unwrap_err(),"safety_quota_exhausted");assert_eq!(parity::dump(&c),before);assert_eq!(preconditions(&c,&s).unwrap(),before_revision);assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&first).unwrap(),response);
    c.execute("UPDATE pc_tx_limits SET max_operations=2",[]).unwrap();adapter.record_unknown_builtin(&mut c,lease,&s,&second).unwrap();assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&second).unwrap().status,Status::Unknown);
    c.execute("UPDATE pc_tx_limits SET max_ticket_bytes=1",[]).unwrap();assert!(adapter.prepare(&mut c,&s,snapshot,RankedMode::Ranked,now(3),3).is_err());assert_eq!(c.query_row("SELECT count(*) FROM pc_tx_ledger WHERE status='unknown'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert!(c.execute("DELETE FROM pc_tx_ledger WHERE status='unknown'",[]).is_err());assert!(c.execute("DELETE FROM pc_tx_limits",[]).is_err());
}
#[test]
fn production_authorization_fences_phase_epoch_session_and_snapshot_binding() {
    let(fixture,s,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).unwrap();let mut adapter=Adapter::attach(&mut c).unwrap();
    let snapshot=crate::core::dota_observer::project(&serde_json::json!({"player":{"activity":"playing","team_name":"radiant"},"hero":{"id":105},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":"42"}})).unwrap();let request=adapter.prepare(&mut c,&s,snapshot,RankedMode::Ranked,now(1),1).unwrap().core_request("fenced","fenced").unwrap();
    let old=Lease{owner:Owner::BuiltIn,epoch:1};assert_eq!(adapter.execute_builtin(&mut c,old,&s,&request).unwrap_err(),"ownership_fenced");let lease=auth::confirm_fenced(&mut c,old).unwrap();auth::bind_builtin_session(&mut c,lease,&s).unwrap();let before=parity::dump(&c);
    assert_eq!(adapter.execute_builtin(&mut c,old,&s,&request).unwrap_err(),"ownership_fenced");assert_eq!(adapter.execute_builtin(&mut c,lease,"other-session",&request).unwrap_err(),"execution_scope_mismatch");let mut forged=request.clone();forged.binding="0".repeat(64);assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&forged).unwrap_err(),"context_corrupt");
    auth::crash_fenced(&mut c,lease).unwrap();assert_eq!(adapter.execute_builtin(&mut c,lease,&s,&request).unwrap_err(),"ownership_fenced");let next=auth::recover(&mut c,Owner::BuiltIn).unwrap();assert!(next.epoch>lease.epoch);assert_eq!(parity::dump(&c),before);assert_eq!(adapter.execute_builtin(&mut c,next,&s,&request).unwrap().status,Status::Completed);
}
#[test]
fn coordinator_child() {
    let Ok(path)=std::env::var("PC13_COORDINATOR_FIXTURE")else{return;};let path=std::path::PathBuf::from(path);assert_eq!(std::fs::read(path.parent().unwrap().join("coordinator-marker")).unwrap(),b"temporary coordinator fixture");let c=Connection::open(path).unwrap();
    std::process::exit(if matches!(claim(&c),Err(e) if e=="second_coordinator_denied"){74}else{75});
}
#[test]
fn another_process_cannot_claim_the_core_write_coordinator() {
    let(fixture,_,_)=Fixture::seeded().unwrap();std::fs::write(fixture.root.path().join("coordinator-marker"),b"temporary coordinator fixture").unwrap();let mut c=fixture.connect().unwrap();migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).unwrap();let adapter=Adapter::attach(&mut c).unwrap();
    let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","local_runtime::transaction_schema::tests::coordinator_child"]).env("PC13_COORDINATOR_FIXTURE",&fixture.path).status().unwrap();assert_eq!(status.code(),Some(74));drop(adapter);assert!(claim(&c).is_ok());
}
#[test]
fn mid_migration_disk_quota_failure_rolls_back_all_reserved_tables() {
    let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();let before=parity::dump(&c);let pages:i64=c.query_row("PRAGMA page_count",[],|r|r.get(0)).unwrap();c.pragma_update(None,"max_page_count",pages+2).unwrap();
    assert!(migrate(&mut c,&fixture.root.path().join("backup.sqlite3")).is_err());assert_eq!(parity::dump(&c),before);assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc_tx_%'",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert_eq!(parity::dump(&super::backup(&fixture.root.path().join("backup.sqlite3")).unwrap()),before);
}
#[test]
fn invalid_backup_and_corrupt_accounting_are_rejected_without_history_changes() {
    let(fixture,_,_)=Fixture::seeded().unwrap();let mut c=fixture.connect().unwrap();let backup=fixture.root.path().join("backup.sqlite3");migrate(&mut c,&backup).unwrap();let before=parity::dump(&c);std::fs::write(&backup,b"broken backup").unwrap();assert!(restore_before_writes(&mut c,&backup).is_err());assert_eq!(parity::dump(&c),before);
    c.execute("UPDATE pc_tx_usage SET entries=entries+1 WHERE kind='pc_tx_revision'",[]).unwrap();assert_eq!(validate(&c).unwrap_err(),"quota_accounting_corrupt");assert!(Adapter::attach(&mut c).is_err());assert_eq!(parity::dump(&c),before);
}
