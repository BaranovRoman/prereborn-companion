//! Independent frozen-oracle parity and offline migration rehearsal on temporary real schemas.
use super::{model,gsi,schema,store,transaction_facade::Facade};
use chrono::{DateTime,Utc};
use rusqlite::{Connection,types::ValueRef,params};
use serde_json::{Value,json};
use std::collections::{BTreeMap,BTreeSet};
#[allow(dead_code)] mod sync {include!("fixtures/legacy_sync_9d46cc5.rs");}
#[allow(dead_code)] mod legacy {include!("fixtures/legacy_store_9d46cc5.rs");}
fn now(n:i64)->DateTime<Utc> {DateTime::from_timestamp(1700000000+n,0).unwrap()}
fn tables(conn:&Connection)->Vec<String> {conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'pc8_%' AND name NOT LIKE 'pc_tx_%' ORDER BY name").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap()}
pub fn dump(conn:&Connection)->BTreeMap<String,Vec<Vec<Value>>> {
 tables(conn).into_iter().map(|table| {
  let mut stmt=conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid")).unwrap();let width=stmt.column_count();
  let rows=stmt.query_map([],|r|Ok((0..width).map(|i|match r.get_ref(i).unwrap() {ValueRef::Null=>Value::Null,ValueRef::Integer(n)=>json!(n),ValueRef::Real(n)=>json!(n),ValueRef::Text(t)=>Value::String(std::str::from_utf8(t).unwrap().into()),ValueRef::Blob(_)=>panic!("unexpected blob")}).collect())).unwrap().collect::<Result<Vec<_>,_>>().unwrap();(table,rows)
 }).collect()
}
pub fn ids(conn:&Connection)->BTreeSet<String> {
 ["local_sessions","local_matches","sync_outbox"].into_iter().flat_map(|table|{let col=if table=="sync_outbox"{"id"}else{"local_id"};conn.prepare(&format!("SELECT {col} FROM {table} ORDER BY rowid")).unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()}).collect()
}
pub fn normalized(conn:&Connection,seed:&BTreeSet<String>)->Value {
 let mut mappings=BTreeMap::new();
 for table in ["local_sessions","local_matches","sync_outbox"] {let col=if table=="sync_outbox"{"id"}else{"local_id"};let generated=conn.prepare(&format!("SELECT {col} FROM {table} ORDER BY rowid")).unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();for(i,id)in generated.iter().enumerate(){assert!(uuid::Uuid::parse_str(id).is_ok());if !seed.contains(id){mappings.insert(id.clone(),format!("generated:{table}:{i}"));}}}
 fn walk(value:&mut Value,map:&BTreeMap<String,String>){match value {Value::String(s)=>{for(id,label)in map { *s=s.replace(id,label); }},Value::Array(a)=>for v in a {walk(v,map)},Value::Object(o)=>for v in o.values_mut(){walk(v,map)},_=>{}}}
 let mut value=serde_json::to_value(dump(conn)).unwrap();walk(&mut value,&mappings);value
}
pub fn seed(path:&std::path::Path)->(String,String) {let mut c=Connection::open(path).unwrap();schema::migrate(&c).unwrap();legacy::set_current_rating(&mut c,1000).unwrap();let s=legacy::ensure_gameplay_session(&mut c,now(0)).unwrap();legacy::create_match(&c,&s.local_id,None,14,"radiant",model::RankedMode::Ranked,now(1)).unwrap();let m=legacy::find_active_match(&c,&s.local_id).unwrap().unwrap();(s.local_id,m.local_id)}
fn step(conn:&mut Connection,old:bool,n:u8,session:&str,matched:&str) {
 use model::{RankedMode as R,MatchResult as M};
 let telemetry=gsi::MatchTelemetry{kills:Some(4),deaths:None,assists:Some(2),inventory:(0..9).map(|i|if i==8{Some("item_tango".into())}else{None}).collect()};
 if old {match n {
 0=>legacy::mark_session_streamed(conn,session,now(2)).unwrap(),1=>legacy::resume_match(conn,matched,Some("42"),105).unwrap(),2=>legacy::update_match_telemetry(conn,matched,&telemetry,now(3)).unwrap(),3=>legacy::mark_interrupted(conn,matched,now(4)).unwrap(),4=>legacy::resume_match(conn,matched,Some("42"),105).unwrap(),5=>legacy::mark_needs_review(conn,matched).unwrap(),6=>legacy::set_post_game(conn,matched,Some(M::Win)).unwrap(),7=>legacy::finalize_match(conn,matched,session,R::Ranked,M::Win,"confirmed",now(5)).unwrap(),8=>{legacy::correct_match_delta(conn,matched,Some(50)).unwrap();},9=>{legacy::correct_match_ranked_mode(conn,matched,Some(R::Unranked)).unwrap();},10=>{legacy::correct_match_ranked_mode(conn,matched,None).unwrap();},11=>sync::apply_one_correction(conn,matched,50,Some(1050),Some(1050),Some(0)).unwrap(),12=>legacy::finalize_session_end(conn,session,now(6)).unwrap(),13=>{legacy::ensure_active_session(conn,now(7)).unwrap();},14=>{let session=legacy::find_open_session(conn).unwrap().unwrap();legacy::create_match(conn,&session.local_id,Some("43"),14,"dire",R::Ranked,now(8)).unwrap();},15=>{let session=legacy::find_open_session(conn).unwrap().unwrap();let matched=legacy::find_active_match(conn,&session.local_id).unwrap().unwrap();legacy::finalize_match(conn,&matched.local_id,&session.local_id,R::Ranked,M::Loss,"probable",now(9)).unwrap();},16=>{legacy::correct_match_delta(conn,matched,None).unwrap();},17=>{let tx=conn.transaction().unwrap();sync::enqueue(&tx,"session",session,"between_matches_entered",&json!({}),now(10)).unwrap();tx.commit().unwrap();},_=>unreachable!()}}
 else {let tx=conn.transaction().unwrap();let f=Facade::new(&tx);match n {
 0=>f.streamed(session,now(2)).unwrap(),1=>f.resume(matched,Some("42"),105).unwrap(),2=>f.telemetry(matched,&telemetry,now(3)).unwrap(),3=>f.interrupted(matched,now(4)).unwrap(),4=>f.resume(matched,Some("42"),105).unwrap(),5=>f.needs_review(matched).unwrap(),6=>f.post_game(matched,Some(M::Win)).unwrap(),7=>f.finish(matched,session,R::Ranked,M::Win,"confirmed",now(5)).unwrap(),8=>{f.correct_delta(matched,Some(50)).unwrap();},9=>{f.correct_mode(matched,Some(R::Unranked)).unwrap();},10=>{f.correct_mode(matched,None).unwrap();},11=>f.server_correction(matched,50,Some(1050),Some(1050),Some(0)).unwrap(),12=>f.end_session(session,now(6)).unwrap(),13=>{f.session(now(7),true).unwrap();},14=>{let session=store::find_open_session(&tx).unwrap().unwrap();f.create_match(&session.local_id,Some("43"),14,"dire",R::Ranked,now(8)).unwrap();},15=>{let session=store::find_open_session(&tx).unwrap().unwrap();let matched=store::find_active_match(&tx,&session.local_id).unwrap().unwrap();f.finish(&matched.local_id,&session.local_id,R::Ranked,M::Loss,"probable",now(9)).unwrap();},16=>{f.correct_delta(matched,None).unwrap();},17=>f.enqueue("session",session,"between_matches_entered",&json!({}),now(10)).unwrap(),_=>unreachable!()}tx.commit().unwrap();}
}
fn public_step(c:&mut Connection,n:u8,s:&str,m:&str) {
 use model::{RankedMode as R,MatchResult as M};
 let telemetry=gsi::MatchTelemetry{kills:Some(4),deaths:None,assists:Some(2),inventory:(0..9).map(|i|if i==8{Some("item_tango".into())}else{None}).collect()};
 match n {
 0=>store::mark_session_streamed(c,s,now(2)).unwrap(),1=>store::resume_match(c,m,Some("42"),105).unwrap(),2=>store::update_match_telemetry(c,m,&telemetry,now(3)).unwrap(),3=>store::mark_interrupted(c,m,now(4)).unwrap(),4=>store::resume_match(c,m,Some("42"),105).unwrap(),5=>store::mark_needs_review(c,m).unwrap(),6=>store::set_post_game(c,m,Some(M::Win)).unwrap(),7=>store::finalize_match(c,m,s,R::Ranked,M::Win,"confirmed",now(5)).unwrap(),
 8=>{store::correct_match_delta(c,m,Some(50)).unwrap();},9=>{store::correct_match_ranked_mode(c,m,Some(R::Unranked)).unwrap();},10=>{store::correct_match_ranked_mode(c,m,None).unwrap();},11=>super::sync::apply_one_correction(c,m,50,Some(1050),Some(1050),Some(0)).unwrap(),12=>store::finalize_session_end(c,s,now(6)).unwrap(),13=>{store::ensure_active_session(c,now(7)).unwrap();},14=>{let s=store::find_open_session(c).unwrap().unwrap();store::create_match(c,&s.local_id,Some("43"),14,"dire",R::Ranked,now(8)).unwrap();},15=>{let s=store::find_open_session(c).unwrap().unwrap();let m=store::find_active_match(c,&s.local_id).unwrap().unwrap();store::finalize_match(c,&m.local_id,&s.local_id,R::Ranked,M::Loss,"probable",now(9)).unwrap();},16=>{store::correct_match_delta(c,m,None).unwrap();},17=>{let tx=c.transaction().unwrap();super::sync::enqueue(&tx,"session",s,"between_matches_entered",&json!({}),now(10)).unwrap();tx.commit().unwrap();},_=>unreachable!()
 }
}
#[test]
fn production_migrated_public_legacy_api_matches_frozen_full_write_set() {
 let dir=tempfile::tempdir().unwrap();let base=dir.path().join("seed.sqlite3");let(s,m)=seed(&base);let old_path=dir.path().join("old.sqlite3");let new_path=dir.path().join("new.sqlite3");std::fs::copy(&base,&old_path).unwrap();std::fs::copy(&base,&new_path).unwrap();let mut old=Connection::open(old_path).unwrap();let mut current=Connection::open(new_path).unwrap();let seeded=ids(&old);
 super::transaction_schema::migrate(&mut current,&dir.path().join("backup.sqlite3")).unwrap();
 for n in 0..18 {step(&mut old,true,n,&s,&m);public_step(&mut current,n,&s,&m);assert_eq!(normalized(&old,&seeded),normalized(&current,&seeded),"public migrated step {n}");}
 for c in [&old,&current] {c.execute("UPDATE sync_outbox SET delivered_at=?1,attempts=1 WHERE rowid=(SELECT min(rowid) FROM sync_outbox)",[now(12).to_rfc3339()]).unwrap();c.execute("UPDATE sync_outbox SET failed_at=?1,last_error='fixture rejection' WHERE rowid=(SELECT max(rowid) FROM sync_outbox)",[now(13).to_rfc3339()]).unwrap();}
 assert_eq!(normalized(&old,&seeded),normalized(&current,&seeded));super::transaction_schema::validate(&current).unwrap();assert!(super::host_execution::revision(&current,"local_matches",&m).unwrap()>0);
}
#[test] fn full_write_set_matches_frozen_legacy_after_every_transition() {
 let dir=tempfile::tempdir().unwrap();let base=dir.path().join("seed.sqlite3");let(s,m)=seed(&base);
 let a=dir.path().join("old.sqlite3");let b=dir.path().join("new.sqlite3");std::fs::copy(&base,&a).unwrap();std::fs::copy(&base,&b).unwrap();let mut old=Connection::open(a).unwrap();let mut new=Connection::open(b).unwrap();let seeded=ids(&old);
 for n in 0..18 {step(&mut old,true,n,&s,&m);step(&mut new,false,n,&s,&m);assert_eq!(normalized(&old,&seeded),normalized(&new,&seeded),"step {n}");assert_eq!(store::find_match(&new,&m).unwrap().unwrap().local_id,m);let tx=new.transaction().unwrap();assert_eq!(super::sync::outbox_status(&old).unwrap(),Facade::new(&tx).outbox_status().unwrap());tx.commit().unwrap();}
 // Delivery/dead-letter bookkeeping is deterministic fixture data, never HTTP.
 for c in [&old,&new] {c.execute("UPDATE sync_outbox SET delivered_at=?1,attempts=1 WHERE rowid=(SELECT min(rowid) FROM sync_outbox)",[now(12).to_rfc3339()]).unwrap();c.execute("UPDATE sync_outbox SET failed_at=?1,last_error='fixture rejection' WHERE rowid=(SELECT max(rowid) FROM sync_outbox)",[now(13).to_rfc3339()]).unwrap();}
 assert_eq!(normalized(&old,&seeded),normalized(&new,&seeded));
}
fn signature(c:&Connection)->Vec<(String,Option<String>)>{c.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'pc8_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap()}
fn fingerprint(c:&Connection)->String {use sha2::{Digest,Sha256};format!("{:x}",Sha256::digest(serde_json::to_vec(&dump(c)).unwrap()))}
fn install(c:&mut Connection)->rusqlite::Result<()> {
 let expected=Connection::open_in_memory()?;schema::migrate(&expected)?;
 let version:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0))?;let expected_version:i64=expected.query_row("PRAGMA user_version",[],|r|r.get(0))?;
 let integrity:String=c.query_row("PRAGMA quick_check",[],|r|r.get(0))?;
 if integrity!="ok"||version!=expected_version||signature(c)!=signature(&expected){return Err(rusqlite::Error::InvalidQuery);}
 let baseline=fingerprint(c);
 let tx=c.transaction()?;
 tx.execute_batch("CREATE TABLE pc8_migration(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,baseline TEXT NOT NULL,write_count INTEGER NOT NULL DEFAULT 0); CREATE TABLE pc8_owner(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,phase TEXT NOT NULL); INSERT INTO pc8_owner VALUES(1,1,'draining'); CREATE TABLE pc8_ledger(operation_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('accepted','unknown','completed','rejected'))); CREATE TABLE pc8_receipts(operation_key TEXT PRIMARY KEY REFERENCES pc8_ledger(operation_key),result TEXT NOT NULL);")?;tx.execute("INSERT INTO pc8_migration(id,version,baseline) VALUES(1,1,?1)",[baseline])?;
 for table in tables(&tx).into_iter().chain(["pc8_owner".into(),"pc8_ledger".into(),"pc8_receipts".into()]) {for event in ["INSERT","UPDATE","DELETE"] {tx.execute_batch(&format!("CREATE TRIGGER pc8_watch_{table}_{event} AFTER {event} ON {table} BEGIN UPDATE pc8_migration SET write_count=write_count+1 WHERE id=1; END;"))?;}}
 tx.commit()
}
fn rollback(c:&mut Connection)->rusqlite::Result<()> {
 let current=fingerprint(c);
 let tx=c.transaction()?;let baseline:String=tx.query_row("SELECT baseline FROM pc8_migration WHERE id=1",[],|r|r.get(0))?;
 if current!=baseline{return Err(rusqlite::Error::InvalidQuery);}
 let written:i64=tx.query_row("SELECT count(*) FROM pc8_ledger",[],|r|r.get(0))?;
 let changes:i64=tx.query_row("SELECT write_count FROM pc8_migration WHERE id=1",[],|r|r.get(0))?;
 if written!=0||changes!=0{return Err(rusqlite::Error::InvalidQuery);}
 let triggers:Vec<String>=tx.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'pc8_watch_%'")?.query_map([],|r|r.get(0))?.collect::<Result<_,_>>()?;
 for trigger in triggers {tx.execute_batch(&format!("DROP TRIGGER {trigger}"))?;}
 tx.execute_batch("DROP TABLE pc8_receipts; DROP TABLE pc8_ledger; DROP TABLE pc8_owner; DROP TABLE pc8_migration;")?;tx.commit()
}
#[test] fn migration_preserves_rows_and_old_queries_reopens_and_blocks_unsafe_rollback() {
 let dir=tempfile::tempdir().unwrap();let p=dir.path().join("copy.sqlite3");let(s,m)=seed(&p);let mut c=Connection::open(&p).unwrap();let before=dump(&c);let sig=signature(&c);install(&mut c).unwrap();assert_eq!(dump(&c),before);drop(c);
 let mut c=Connection::open(&p).unwrap();assert!(legacy::find_match(&c,&m).unwrap().is_some());assert!(legacy::find_session(&c,&s).unwrap().is_some());assert_eq!(dump(&c),before);rollback(&mut c).unwrap();assert_eq!(signature(&c),sig);
 install(&mut c).unwrap();store::set_current_rating(&mut c,1100).unwrap();assert!(rollback(&mut c).is_err());let tx=c.transaction().unwrap();Facade::new(&tx).rating(1200).unwrap();tx.execute("INSERT INTO pc8_ledger VALUES('op','hash','unknown')",[]).unwrap();tx.commit().unwrap();assert!(rollback(&mut c).is_err());assert_eq!(c.query_row("SELECT status FROM pc8_ledger",[],|r|r.get::<_,String>(0)).unwrap(),"unknown");
}
#[test] fn facade_ledger_receipt_and_full_match_writes_roll_back_together() {
 let dir=tempfile::tempdir().unwrap();let p=dir.path().join("copy.sqlite3");let(s,m)=seed(&p);let mut c=Connection::open(&p).unwrap();install(&mut c).unwrap();let before=dump(&c);
 {let tx=c.transaction().unwrap();let f=Facade::new(&tx);f.streamed(&s,now(2)).unwrap();f.finish(&m,&s,model::RankedMode::Ranked,model::MatchResult::Win,"confirmed",now(3)).unwrap();tx.execute("INSERT INTO pc8_ledger VALUES('op','hash','completed')",[]).unwrap();tx.execute("INSERT INTO pc8_receipts VALUES('op','saved')",[]).unwrap();}
 assert_eq!(dump(&c),before);assert_eq!(c.query_row("SELECT count(*) FROM pc8_ledger",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert_eq!(c.query_row("SELECT count(*) FROM pc8_receipts",[],|r|r.get::<_,i64>(0)).unwrap(),0);
 let tx=c.transaction().unwrap();Facade::new(&tx).finish(&m,&s,model::RankedMode::Ranked,model::MatchResult::Win,"confirmed",now(3)).unwrap();tx.execute("INSERT INTO pc8_ledger VALUES('op','hash','completed')",[]).unwrap();tx.execute("INSERT INTO pc8_receipts VALUES('op','saved')",[]).unwrap();tx.commit().unwrap();assert_eq!(store::get_current_rating(&c).unwrap(),Some(1025));assert_eq!(c.query_row("SELECT count(*) FROM sync_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),1);
 drop(c);let mut c=Connection::open(&p).unwrap();
 assert_eq!(c.query_row("SELECT status,result FROM pc8_ledger JOIN pc8_receipts USING(operation_key) WHERE operation_key='op'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),("completed".into(),"saved".into()));
 let committed=dump(&c);
 // Failure after real writes must undo those writes together, not partially commit.
 {let tx=c.transaction().unwrap();Facade::new(&tx).rating(1500).unwrap();assert!(tx.execute("INSERT INTO pc8_ledger VALUES('op','conflicting','accepted')",[]).is_err());}
 assert_eq!(dump(&c),committed);

}
#[test] fn incompatible_and_corrupt_copies_refuse_migration() {
 let mut c=Connection::open_in_memory().unwrap();schema::migrate(&c).unwrap();c.pragma_update(None,"user_version",999).unwrap();assert!(install(&mut c).is_err());
 let dir=tempfile::tempdir().unwrap();let p=dir.path().join("bad.sqlite3");std::fs::write(&p,b"broken").unwrap();let mut bad=Connection::open(&p).unwrap();assert!(install(&mut bad).is_err());assert_eq!(std::fs::read(p).unwrap(),b"broken");
}

#[test] fn indexed_retention_exceeds_256_preserves_unknown_and_rejects_duplicate_identity() {
 let dir=tempfile::tempdir().unwrap();let path=dir.path().join("indexed.sqlite3");let mut c=Connection::open(&path).unwrap();schema::migrate(&c).unwrap();install(&mut c).unwrap();
 let tx=c.transaction().unwrap();
 for n in 0..300 {tx.execute("INSERT INTO pc8_ledger VALUES(?1,?2,'accepted')",params![format!("op{n}"),format!("identity{n}")]).unwrap();}
 tx.commit().unwrap();drop(c);let mut c=Connection::open(&path).unwrap();
 // Recovery never infers external success and never deletes keys.
 let tx=c.transaction().unwrap();tx.execute("UPDATE pc8_ledger SET status='unknown' WHERE status='accepted'",[]).unwrap();tx.commit().unwrap();
 assert_eq!(c.query_row("SELECT count(*) FROM pc8_ledger WHERE status='unknown'",[],|r|r.get::<_,i64>(0)).unwrap(),300);
 assert!(c.execute("INSERT INTO pc8_ledger VALUES('op1','different','completed')",[]).is_err());
 assert_eq!(c.query_row("SELECT payload_hash,status FROM pc8_ledger WHERE operation_key='op1'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),("identity1".into(),"unknown".into()));
 assert!(rollback(&mut c).is_err());
}

pub fn legacy_apply(c:&mut Connection,s:&str,raw:&companion_dota_domain::contracts::ReplayGsi,at:i64) {
    let before=store::find_active_match(c,s).unwrap();let parsed=gsi::parse(&serde_json::to_value(raw).unwrap()).unwrap();
    super::detector::handle_snapshot(c,s,model::RankedMode::Ranked,&parsed,now(at)).unwrap();
    let after=store::find_active_match(c,s).unwrap();let terminal=before.filter(|_|after.is_none()).and_then(|a|store::find_match(c,&a.local_id).unwrap());
    if let Some(session)=store::find_session(c,s).unwrap(){if companion_dota_domain::match_shadow::should_end_gameplay(session.is_streamed,terminal.is_some()){store::finalize_session_end(c,s,now(at)).unwrap();}}
}
