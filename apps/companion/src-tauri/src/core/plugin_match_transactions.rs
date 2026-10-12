//! Test-only transactional prototype. Never opened from application setup or IPC handlers.
use super::plugin_durable::DurableStore;
use companion_dota_domain::{match_transactions::*,effects::{Capability,Effect,Request as Admission,Status},ownership::Lease};
use rusqlite::{Transaction,OptionalExtension,params};
use sha2::{Sha256,Digest};
use std::path::Path;
type Result<T>=std::result::Result<T,String>;
fn hash(s:&str)->String {format!("{:x}",Sha256::digest(s.as_bytes()))}
fn encode<T:serde::Serialize>(value:&T)->Result<String> {serde_json::to_string(value).map_err(|_|"encode_failed".into())}
struct Prototype {store:DurableStore}
impl Prototype {
 fn fixture(path:&Path)->Result<Self> {
  let mut store=DurableStore::open(path)?;
  store.inspect(|tx| {
   let initialized:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='proto_schema')",[],|r|r.get(0)).map_err(|_|"schema_unavailable")?;
   if initialized {
    let version:i64=tx.query_row("SELECT version FROM proto_schema WHERE id=1",[],|r|r.get(0)).map_err(|_|"schema_corrupt")?;
    let tables:i64=tx.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('proto_matches','proto_outbox','proto_receipts','proto_overlay')",[],|r|r.get(0)).map_err(|_|"schema_corrupt")?;
    if version!=1||tables!=4 {return Err("schema_corrupt".into());} return Ok(());
   }
   let leftovers:i64=tx.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'proto_%'",[],|r|r.get(0)).map_err(|_|"schema_corrupt")?;
   if leftovers!=0 {return Err("schema_corrupt".into());}
   let raw:String=tx.query_row("SELECT record FROM plugin_control",[],|r|r.get(0)).map_err(|_|"schema_corrupt")?;
   let record:serde_json::Value=serde_json::from_str(&raw).map_err(|_|"schema_corrupt")?;
   if record["ledger"]["entries"].as_object().map_or(true,|entries|!entries.is_empty()) {return Err("prototype_requires_empty_store".into());}
   tx.execute_batch("CREATE TABLE proto_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO proto_schema VALUES(1,1);").map_err(|_|"schema_unavailable")?;
   tx.execute_batch("CREATE TABLE proto_matches(local_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,match_key TEXT NOT NULL,gsi_id TEXT,doc TEXT NOT NULL,checksum TEXT NOT NULL,UNIQUE(session_id,match_key)); CREATE TABLE proto_outbox(id TEXT PRIMARY KEY,local_id TEXT UNIQUE NOT NULL,doc TEXT NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL); CREATE TABLE proto_overlay(id INTEGER PRIMARY KEY CHECK(id=1),doc TEXT NOT NULL,checksum TEXT NOT NULL); CREATE TABLE proto_receipts(operation_key TEXT PRIMARY KEY,identity TEXT NOT NULL,result TEXT NOT NULL,checksum TEXT NOT NULL);").map_err(|_|"schema_unavailable".into()) })?;
  Ok(Self{store})
 }
 fn submit(&mut self,req:&Request,grants:&[Capability])->Result<Reply> {self.submit_fault(req,grants,0)}
 fn submit_fault(&mut self,req:&Request,grants:&[Capability],fault:u8)->Result<Reply> {
  if !req.validate()||encode(req)?.len()>4096 {return Err("invalid_request".into());}
  let identity=hash(&encode(&req.operation)?);
  let admission=Admission {api:1,lease:req.lease,correlation_id:req.correlation_id.clone(),idempotency_key:req.operation_key.clone(),deadline_ms:req.deadline_ms,effect:Effect::MatchTransaction {identity:identity.clone(),capability:req.operation.capability()}};
  self.store.settle_local(grants,&admission,0,|tx| {
   tx.execute_batch("SAVEPOINT local_operation").map_err(|_|"store_unavailable")?;
   let applied=apply(tx,&req.operation)?;
   let (data,error,status)=match applied {
    Ok(data)=>{tx.execute_batch("RELEASE local_operation").map_err(|_|"store_unavailable")?;(data,None,Status::Completed)},
    Err(error)=>{tx.execute_batch("ROLLBACK TO local_operation; RELEASE local_operation").map_err(|_|"store_unavailable")?;(Data::None,Some(error),Status::Rejected)},
   };
   if fault==1 {return Err("injected_before_commit".into());}
   if fault==2 {std::process::exit(73);}
   let reply=Reply{operation_key:req.operation_key.clone(),correlation_id:req.correlation_id.clone(),status,data,error};let result=encode(&reply)?;
   if result.len()>16384 {return Err("response_too_large".into());}
   tx.execute("INSERT INTO proto_receipts VALUES(?1,?2,?3,?4)",params![req.operation_key,identity,result,hash(&result)]).map_err(|_|"receipt_write_failed")?;Ok(status)
  })?;
  if fault==3 {std::process::exit(74);}
  self.result(&req.operation_key,&identity,&req.correlation_id)
 }
 fn result(&mut self,key:&str,identity:&str,correlation:&str)->Result<Reply> {
  self.store.inspect(|tx|{
   let (stored,result,checksum):(String,String,String)=tx.query_row("SELECT identity,result,checksum FROM proto_receipts WHERE operation_key=?1 AND length(CAST(result AS BLOB))<=16384",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"result_unknown")?;
   if stored!=identity {return Err("idempotency_conflict".into());}if hash(&result)!=checksum {return Err("receipt_corrupt".into());}
   let mut reply:Reply=serde_json::from_str(&result).map_err(|_|"receipt_corrupt")?;reply.correlation_id=correlation.into();Ok(reply)
  })
 }
 // Unknown is resolved ONLY from a terminal local receipt matching the full payload.
 // Outbox delivery remains Unknown; no external success or retry is inferred here.
 fn reconcile_unknown(&mut self,req:&Request)->Result<Reply> {
  if !req.validate(){return Err("invalid_request".into());}
  let identity=hash(&encode(&req.operation)?);let reply=self.result(&req.operation_key,&identity,&req.correlation_id)?;
  if !matches!(reply.status,Status::Completed|Status::Rejected) {return Err("result_unknown".into());}
  let admission=Admission{api:1,lease:req.lease,correlation_id:req.correlation_id.clone(),idempotency_key:req.operation_key.clone(),deadline_ms:req.deadline_ms,effect:Effect::MatchTransaction{identity,capability:req.operation.capability()}};
  self.store.acknowledge(&admission,reply.status)?;Ok(reply)
 }
}
fn read_match(tx:&Transaction<'_>,id:&str)->Result<Option<MatchRow>> {
 let row:Option<(String,String)>=tx.query_row("SELECT length(CAST(doc AS BLOB)),doc,checksum FROM proto_matches WHERE local_id=?1",[id],|r|{if r.get::<_,i64>(0)?>4096 {return Err(rusqlite::Error::InvalidQuery);}Ok((r.get(1)?,r.get(2)?))}).optional().map_err(|_|"match_read_failed")?;
 row.map(|(json,checksum)|{if hash(&json)!=checksum{return Err("match_corrupt".into());}serde_json::from_str(&json).map_err(|_|"match_corrupt".into())}).transpose()
}
fn save_match(tx:&Transaction<'_>,row:&MatchRow)->Result<()> {
 let json=encode(row)?;tx.execute("UPDATE proto_matches SET doc=?2,checksum=?3,gsi_id=?4 WHERE local_id=?1",params![row.identity.local_id,json,hash(&json),row.identity.gsi_match_id]).map_err(|_|"match_write_failed")?;Ok(())
}
fn outbox(tx:&Transaction<'_>,limit:u8)->Result<Vec<OutboxRow>> {
 let mut stmt=tx.prepare("SELECT length(CAST(doc AS BLOB)),length(CAST(payload AS BLOB)),doc,payload,checksum FROM proto_outbox ORDER BY rowid LIMIT ?1").map_err(|_|"outbox_read_failed")?;
 let rows=stmt.query_map([limit],|r|{if r.get::<_,i64>(0)?>2048||r.get::<_,i64>(1)?>4096 {return Err(rusqlite::Error::InvalidQuery);}Ok((r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))}).map_err(|_|"outbox_read_failed")?;
 rows.map(|row|{let (json,payload,checksum)=row.map_err(|_|"outbox_read_failed")?;if json.len()>2048||hash(&format!("{json}\n{payload}"))!=checksum{return Err("outbox_corrupt".into());}serde_json::from_str(&json).map_err(|_|"outbox_corrupt".into())}).collect()
}
fn enqueue(tx:&Transaction<'_>,row:&MatchRow)->Result<OutboxRow> {
 let existing:Option<String>=tx.query_row("SELECT id FROM proto_outbox WHERE local_id=?1",[&row.identity.local_id],|r|r.get(0)).optional().map_err(|_|"outbox_read_failed")?;
 let id=existing.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
 let doc=OutboxRow{id:id.clone(),local_match_id:row.identity.local_id.clone(),event_type:"match_finalized".into(),delivery:Delivery::Pending};
 let encoded=encode(&doc)?;
 let payload=serde_json::json!({"localSessionId":row.identity.session_id,"localMatchId":row.identity.local_id,"matchId":row.identity.gsi_match_id,"heroId":row.hero_id,"result":row.outcome,"isRanked":match row.mode {Mode::Ranked=>Some(true),Mode::Unranked=>Some(false),Mode::Unknown=>None},"ratingBefore":row.rating.as_ref().and_then(|r|r.before),"detectedRatingDelta":row.rating.as_ref().and_then(|r|r.delta),"ratingAfter":row.rating.as_ref().and_then(|r|r.after),"kills":row.telemetry.as_ref().map(|t|t.kills),"deaths":row.telemetry.as_ref().map(|t|t.deaths),"assists":row.telemetry.as_ref().map(|t|t.assists),"inventory":row.telemetry.as_ref().map(|t|t.inventory.clone()).unwrap_or_default(),"confidence":if row.confirmed {"confirmed"}else{"probable"},"startedAt":chrono::DateTime::<chrono::Utc>::from_timestamp_millis(row.started_ms as i64).ok_or("invalid_time")?.to_rfc3339(),"finalizedAt":chrono::DateTime::<chrono::Utc>::from_timestamp_millis(row.finished_ms.ok_or("missing_finish_time")? as i64).ok_or("invalid_time")?.to_rfc3339()});
 tx.execute("INSERT INTO proto_outbox VALUES(?1,?2,?3,?4,?5) ON CONFLICT(local_id) DO NOTHING",params![id,row.identity.local_id,encoded,payload.to_string(),hash(&format!("{encoded}\n{payload}"))]).map_err(|_|"outbox_write_failed")?;Ok(doc)
}
fn apply(tx:&Transaction<'_>,op:&Operation)->Result<std::result::Result<Data,Error>> {
 let (local,revision)=match op {Operation::Updated{local_id,revision,..}|Operation::Finished{local_id,revision,..}|Operation::Reconcile{local_id,revision,..}|Operation::OutboxEnqueue{local_id,revision}=>(Some(local_id),Some(*revision)),_=>(None,None)};
 let mut current=if let Some(id)=local {let Some(row)=read_match(tx,id)? else {return Ok(Err(Error::NotFound))};if Some(row.revision)!=revision{return Ok(Err(Error::RevisionConflict));}Some(row)}else{None};
 let data=match op {
  Operation::Started{identity,hero_id,team,mode,started_ms}=>{
   let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM proto_matches WHERE local_id=?1 OR (session_id=?4 AND (match_key=?2 OR (gsi_id IS NOT NULL AND gsi_id=?3))))",params![identity.local_id,identity.match_key,identity.gsi_match_id,identity.session_id],|r|r.get(0)).map_err(|_|"match_read_failed")?;if exists{return Ok(Err(Error::IdentityConflict));}
   let row=MatchRow{identity:identity.clone(),revision:1,hero_id:*hero_id,team:team.clone(),mode:mode.clone(),started_ms:*started_ms,last_seen_ms:*started_ms,finished_ms:None,telemetry:None,state:MatchState::InProgress,outcome:None,confirmed:false,rating:None};let json=encode(&row)?;
   tx.execute("INSERT INTO proto_matches VALUES(?1,?2,?3,?4,?5,?6)",params![identity.local_id,identity.session_id,identity.match_key,identity.gsi_match_id,json,hash(&json)]).map_err(|_|"match_write_failed")?;Data::Match{row}
  },
  Operation::Updated{telemetry,..}=>{let row=current.as_mut().unwrap();if matches!(row.state,MatchState::Finalized|MatchState::Interrupted)||telemetry.observed_ms<row.last_seen_ms||row.telemetry.as_ref().is_some_and(|t|telemetry.observed_ms<t.observed_ms){return Ok(Err(Error::InvalidTransition));}let mut patch=telemetry.clone();if let Some(old)=&row.telemetry {patch.kills=patch.kills.or(old.kills);patch.deaths=patch.deaths.or(old.deaths);patch.assists=patch.assists.or(old.assists);if !patch.inventory.iter().any(Option::is_some){patch.inventory=old.inventory.clone();}}row.last_seen_ms=telemetry.observed_ms;row.telemetry=Some(patch);row.revision=row.revision.checked_add(1).ok_or("revision_exhausted")?;save_match(tx,row)?;Data::Match{row:row.clone()}},
  Operation::Finished{outcome,confirmed,finished_ms,rating,..}=>{let row=current.as_mut().unwrap();if row.state==MatchState::Finalized||*finished_ms<row.last_seen_ms||row.outcome.as_ref().is_some_and(|o|o!=outcome){return Ok(Err(Error::InvalidTransition));}row.state=MatchState::Finalized;row.outcome=Some(outcome.clone());row.confirmed=*confirmed;row.last_seen_ms=*finished_ms;row.finished_ms=Some(*finished_ms);row.rating=Some(rating.clone());row.revision=row.revision.checked_add(1).ok_or("revision_exhausted")?;save_match(tx,row)?;enqueue(tx,row)?;Data::Match{row:row.clone()}},
  Operation::Reconcile{change,..}=>{let row=current.as_mut().unwrap();if row.state==MatchState::Finalized{return Ok(Err(Error::InvalidTransition));}match change {
   Reconciliation::Resume{hero_id,observed_ms,gsi_match_id}=>{if *observed_ms<row.last_seen_ms{return Ok(Err(Error::InvalidTransition));}if let (Some(a),Some(b))=(&row.identity.gsi_match_id,gsi_match_id){if a!=b{return Ok(Err(Error::IdentityConflict));}}if let Some(gsi)=gsi_match_id {let conflict:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM proto_matches WHERE gsi_id=?1 AND local_id!=?2 AND session_id=?3)",params![gsi,row.identity.local_id,row.identity.session_id],|r|r.get(0)).map_err(|_|"match_read_failed")?;if conflict{return Ok(Err(Error::IdentityConflict));}}row.last_seen_ms=*observed_ms;row.hero_id=*hero_id;if row.identity.gsi_match_id.is_none(){row.identity.gsi_match_id=gsi_match_id.clone();}if row.state==MatchState::Interrupted{row.state=MatchState::InProgress;}},
   Reconciliation::PostGame{outcome}=>{if row.outcome.as_ref().zip(outcome.as_ref()).is_some_and(|(a,b)|a!=b){return Ok(Err(Error::OutcomeConflict));}row.state=MatchState::PostGamePending;if outcome.is_some(){row.outcome=outcome.clone();}},
   Reconciliation::Interrupted{..}=>{row.state=MatchState::Interrupted;},
   Reconciliation::NeedsReview{..}=>{row.state=MatchState::NeedsReview;row.outcome=None;},
  }row.revision=row.revision.checked_add(1).ok_or("revision_exhausted")?;save_match(tx,row)?;Data::Match{row:row.clone()}},
  Operation::OutboxEnqueue{..}=>{let row=current.as_ref().unwrap();if row.state!=MatchState::Finalized{return Ok(Err(Error::InvalidTransition));}enqueue(tx,row)?;Data::Outbox{rows:outbox(tx,20)?}},
  Operation::HistoryRead{session_id,limit}=>{let mut stmt=tx.prepare("SELECT local_id FROM proto_matches WHERE session_id=?1 ORDER BY rowid DESC LIMIT ?2").map_err(|_|"history_read_failed")?;let ids=stmt.query_map(params![session_id,limit],|r|r.get::<_,String>(0)).map_err(|_|"history_read_failed")?.collect::<std::result::Result<Vec<_>,_>>().map_err(|_|"history_read_failed")?;let rows=ids.iter().map(|id|read_match(tx,id)?.ok_or("match_corrupt".into())).collect::<Result<Vec<_>>>()?;Data::History{rows}},
  Operation::OutboxStatus{limit}=>Data::Outbox{rows:outbox(tx,*limit)?},
  Operation::BackendSyncIntent{outbox_id}=>{
   let rows=outbox(tx,20)?;let Some(first)=rows.first() else{return Ok(Err(Error::NotFound))};if &first.id!=outbox_id{return Ok(Err(Error::InvalidTransition));}if first.delivery==Delivery::Unknown{return Ok(Err(Error::ExternalResultUnknown));}
   let mut row=first.clone();row.delivery=Delivery::Unknown;let json=encode(&row)?;let payload:String=tx.query_row("SELECT payload FROM proto_outbox WHERE id=?1",[outbox_id],|r|r.get(0)).map_err(|_|"outbox_read_failed")?;tx.execute("UPDATE proto_outbox SET doc=?2,checksum=?3 WHERE id=?1",params![outbox_id,json,hash(&format!("{json}\n{payload}"))]).map_err(|_|"outbox_write_failed")?;Data::Outbox{rows:vec![row]}
  },
  Operation::OverlayState{state}=>{let json=encode(state)?;tx.execute("INSERT INTO proto_overlay VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc,checksum=excluded.checksum",params![json,hash(&json)]).map_err(|_|"overlay_write_failed")?;Data::Overlay{state:*state}},
 };Ok(Ok(data))
}

#[cfg(test)] mod tests {
 use super::*;use companion_dota_domain::ownership::Phase;
 fn start()->Operation {Operation::Started{identity:Identity{local_id:"00000000-0000-4000-8000-000000000001".into(),session_id:"00000000-0000-4000-8000-000000000002".into(),match_key:"gsi:42".into(),gsi_match_id:Some("42".into())},hero_id:105,team:Team::Radiant,mode:Mode::Ranked,started_ms:10}}
 fn finish()->Operation {Operation::Finished{local_id:"00000000-0000-4000-8000-000000000001".into(),revision:1,outcome:Outcome::Win,confirmed:true,finished_ms:100,rating:Rating{before:Some(1000),delta:Some(25),after:Some(1025)}}}
 fn lease(p:&mut Prototype)->Lease {let Phase::Active(l)=p.store.phase().unwrap() else {panic!()};l}
 fn request(lease:Lease,key:&str,operation:Operation)->Request {Request{api:1,lease,correlation_id:"corr".into(),operation_key:key.into(),deadline_ms:1000,operation}}
 fn counts(p:&mut Prototype)->(i64,i64,i64) {p.store.inspect(|tx|Ok((tx.query_row("SELECT count(*) FROM proto_matches",[],|r|r.get(0)).unwrap(),tx.query_row("SELECT count(*) FROM proto_outbox",[],|r|r.get(0)).unwrap(),tx.query_row("SELECT count(*) FROM proto_receipts",[],|r|r.get(0)).unwrap()))).unwrap()}
 #[test] fn finish_rollback_atomic_commit_duplicate_and_conflict() {
  let dir=tempfile::tempdir().unwrap();let mut p=Prototype::fixture(&dir.path().join("fixture.sqlite3")).unwrap();let l=lease(&mut p);
  p.submit(&request(l,"start",start()),&[Capability::History]).unwrap();let mut req=request(l,"finish",finish());
  assert!(p.submit_fault(&req,&[Capability::History],1).is_err());assert_eq!(counts(&mut p),(1,0,1));assert!(p.store.last_ack("finish").unwrap().is_none());
  assert_eq!(p.store.inspect(|tx|Ok(read_match(tx,"00000000-0000-4000-8000-000000000001")?.unwrap().revision)).unwrap(),1);
  let result=p.submit(&req,&[Capability::History]).unwrap();assert_eq!(result.status,Status::Completed);assert_eq!(counts(&mut p),(1,1,2));
  assert_eq!(p.store.last_ack("finish").unwrap().unwrap().status,Status::Completed);
  req.correlation_id="retry".into();assert_eq!(p.submit(&req,&[Capability::History]).unwrap().correlation_id,"retry");assert_eq!(counts(&mut p),(1,1,2));
  req.operation=start();assert_eq!(p.submit(&req,&[Capability::History]).unwrap_err(),"idempotency_conflict");
 }
 #[test] fn reopen_returns_committed_result_and_unknown_delivery_never_retries() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("fixture.sqlite3");let mut p=Prototype::fixture(&path).unwrap();let l=lease(&mut p);
  p.submit(&request(l,"start",start()),&[Capability::History]).unwrap();p.submit(&request(l,"finish",finish()),&[Capability::History]).unwrap();
  let mut sync=request(l,"sync",Operation::BackendSyncIntent{outbox_id:p.store.inspect(|tx|Ok(outbox(tx,1)?[0].id.clone())).unwrap()});
  assert!(matches!(p.submit(&sync,&[Capability::Sync]).unwrap().data,Data::Outbox{rows} if rows[0].delivery==Delivery::Unknown));drop(p);
  let mut p=Prototype::fixture(&path).unwrap();assert!(p.submit(&sync,&[Capability::Sync]).is_err());sync.lease=p.store.confirm_fenced(l).unwrap();
  assert!(matches!(p.submit(&sync,&[Capability::Sync]).unwrap().data,Data::Outbox{rows} if rows[0].delivery==Delivery::Unknown));
  sync.operation_key="unsafe_retry".into();let rejected=p.submit(&sync,&[Capability::Sync]).unwrap();assert_eq!(rejected.status,Status::Rejected);assert!(matches!(rejected.error,Some(Error::ExternalResultUnknown)));
  assert_eq!(p.submit(&sync,&[Capability::Sync]).unwrap().status,Status::Rejected);assert_eq!(counts(&mut p),(1,1,4));drop(p);
  let mut p=Prototype::fixture(&path).unwrap();sync.lease=p.store.confirm_fenced(sync.lease).unwrap();assert_eq!(p.submit(&sync,&[Capability::Sync]).unwrap().status,Status::Rejected);assert_eq!(counts(&mut p),(1,1,4));
 }
 #[test] fn local_unknown_reconciles_only_from_matching_terminal_receipt() {
  let dir=tempfile::tempdir().unwrap();let mut p=Prototype::fixture(&dir.path().join("fixture.sqlite3")).unwrap();let l=lease(&mut p);let req=request(l,"start",start());
  let identity=hash(&encode(&req.operation).unwrap());
  let admission=Admission{api:1,lease:l,correlation_id:req.correlation_id.clone(),idempotency_key:req.operation_key.clone(),deadline_ms:1000,effect:Effect::MatchTransaction{identity:identity.clone(),capability:req.operation.capability()}};
  // Iteration-6 style local commit with an Accepted ledger before acknowledgement.
  p.store.admit_with(&[Capability::History],&admission,0,|tx| {
   let data=apply(tx,&req.operation)?.unwrap();let result=encode(&Reply{operation_key:req.operation_key.clone(),correlation_id:req.correlation_id.clone(),status:Status::Completed,data,error:None})?;
   tx.execute("INSERT INTO proto_receipts VALUES(?1,?2,?3,?4)",params![req.operation_key,identity,result,hash(&result)]).unwrap();Ok(())
  }).unwrap();
  let path=dir.path().join("fixture.sqlite3");drop(p);let mut p=Prototype::fixture(&path).unwrap();let mut req=req;req.lease=p.store.confirm_fenced(l).unwrap();
  assert_eq!(p.store.last_ack("start").unwrap().unwrap().status,Status::Unknown);
  assert_eq!(p.reconcile_unknown(&req).unwrap().status,Status::Completed);assert_eq!(counts(&mut p),(1,0,1));
  let missing=request(req.lease,"missing",start());assert!(p.reconcile_unknown(&missing).is_err());
 }
 #[test] fn capabilities_revision_bounds_and_history_contracts() {
  let dir=tempfile::tempdir().unwrap();let mut p=Prototype::fixture(&dir.path().join("fixture.sqlite3")).unwrap();let l=lease(&mut p);let req=request(l,"start",start());
  assert!(p.submit(&req,&[]).is_err());assert_eq!(counts(&mut p),(0,0,0));p.submit(&req,&[Capability::History]).unwrap();
  let bad=request(l,"old",Operation::Updated{local_id:"00000000-0000-4000-8000-000000000001".into(),revision:0,telemetry:Telemetry{kills:Some(1),deaths:Some(0),assists:Some(0),observed_ms:20,inventory:vec![]}});assert!(matches!(p.submit(&bad,&[Capability::History]).unwrap().error,Some(Error::RevisionConflict)));
  let history=request(l,"history",Operation::HistoryRead{session_id:"00000000-0000-4000-8000-000000000002".into(),limit:20});assert!(matches!(p.submit(&history,&[Capability::History]).unwrap().data,Data::History{rows} if rows.len()==1));
  let mut huge=history.clone();huge.operation=Operation::OutboxStatus{limit:21};assert!(p.submit(&huge,&[Capability::History]).is_err());
  let mut json=serde_json::to_value(&history).unwrap();json["sql"]=serde_json::json!("DROP TABLE proto_matches");assert!(serde_json::from_value::<Request>(json).is_err());
 }
 #[test] fn damaged_receipt_and_store_are_fail_closed() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("fixture.sqlite3");let mut p=Prototype::fixture(&path).unwrap();let req=request(lease(&mut p),"start",start());p.submit(&req,&[Capability::History]).unwrap();
  p.store.inspect(|tx|{tx.execute("UPDATE proto_receipts SET result='{}'",[]).unwrap();Ok(())}).unwrap();assert!(p.submit(&req,&[Capability::History]).is_err());assert_eq!(counts(&mut p),(1,0,1));drop(p);
  std::fs::write(&path,b"broken").unwrap();assert!(Prototype::fixture(&path).is_err());
 }
 #[test] #[ignore="abrupt process fixture invoked by parent test"] fn crash_fixture() {
  let path=std::env::var_os("PREREBORN_MATCH_FIXTURE").unwrap();let fault:u8=std::env::var("PREREBORN_MATCH_FAULT").unwrap().parse().unwrap();let mut p=Prototype::fixture(Path::new(&path)).unwrap();let l=lease(&mut p);p.submit(&request(l,"start",start()),&[Capability::History]).unwrap();p.submit_fault(&request(l,"finish",finish()),&[Capability::History],fault).unwrap();panic!("exit fixture failed");
 }
 #[test] fn abrupt_exit_before_commit_rolls_back_and_after_commit_recovers_receipt() {
  for fault in [2,3] {let dir=tempfile::tempdir().unwrap();let path=dir.path().join("fixture.sqlite3");let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","core::plugin_match_transactions::tests::crash_fixture","--ignored"]).env("PREREBORN_MATCH_FIXTURE",&path).env("PREREBORN_MATCH_FAULT",fault.to_string()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap();assert_eq!(status.code(),Some(if fault==2 {73}else{74}));
   let mut p=Prototype::fixture(&path).unwrap();assert_eq!(counts(&mut p),if fault==2 {(1,0,1)}else{(1,1,2)});
   let Phase::Draining{old,..}=p.store.phase().unwrap() else {panic!()};let l=p.store.confirm_fenced(old).unwrap();let req=request(l,"finish",finish());let result=p.submit(&req,&[Capability::History]).unwrap();assert_eq!(result.status,Status::Completed);assert_eq!(counts(&mut p),(1,1,2));
  }
 }
}

#[cfg(test)] mod coverage {
 use super::*;use companion_dota_domain::ownership::Phase;
 const MATCH:&str="00000000-0000-4000-8000-000000000001";
 const SESSION:&str="00000000-0000-4000-8000-000000000002";
 fn req(lease:Lease,key:&str,operation:Operation)->Request {Request{api:1,lease,correlation_id:"corr".into(),operation_key:key.into(),deadline_ms:1000,operation}}
 fn start()->Operation {Operation::Started{identity:Identity{local_id:MATCH.into(),session_id:SESSION.into(),match_key:"gsi:42".into(),gsi_match_id:Some("42".into())},hero_id:105,team:Team::Radiant,mode:Mode::Ranked,started_ms:10}}
 #[test] fn update_reconnect_postgame_overlay_and_ipc_contract_roundtrip() {
  let dir=tempfile::tempdir().unwrap();let mut p=Prototype::fixture(&dir.path().join("fixture.sqlite3")).unwrap();let Phase::Active(l)=p.store.phase().unwrap() else {panic!()};
  p.submit(&req(l,"start",start()),&[Capability::History]).unwrap();
  for (key,op) in [
   ("telemetry",Operation::Updated{local_id:MATCH.into(),revision:1,telemetry:Telemetry{kills:Some(1),deaths:Some(0),assists:Some(1),observed_ms:20,inventory:vec![Some("item_tango".into())]}}),
   ("interrupt",Operation::Reconcile{local_id:MATCH.into(),revision:2,change:Reconciliation::Interrupted{evidence:InterruptEvidence::SessionEnded}}),
   ("resume",Operation::Reconcile{local_id:MATCH.into(),revision:3,change:Reconciliation::Resume{hero_id:105,observed_ms:30,gsi_match_id:Some("42".into())}}),
   ("postgame",Operation::Reconcile{local_id:MATCH.into(),revision:4,change:Reconciliation::PostGame{outcome:Some(Outcome::Win)}}),
  ] {assert_eq!(p.submit(&req(l,key,op),&[Capability::History]).unwrap().status,Status::Completed);}
  let row=p.store.inspect(|tx|Ok(read_match(tx,MATCH)?.unwrap())).unwrap();assert_eq!(row.state,MatchState::PostGamePending);assert_eq!(row.revision,5);assert_eq!(row.identity.match_key,"gsi:42");
  let overlay=req(l,"overlay",Operation::OverlayState{state:companion_dota_domain::broadcast_state::BroadcastState::Draft});assert!(p.submit(&overlay,&[Capability::History]).is_err());let reply=p.submit(&overlay,&[Capability::Overlay]).unwrap();assert!(matches!(reply.data,Data::Overlay{..}));
  let mut bytes=vec![];companion_plugin_protocol::write_frame(&mut bytes,companion_plugin_protocol::Message::Command{id:7,name:"dota.match_transaction".into(),args:serde_json::to_value(&overlay).unwrap()}).unwrap();
  let Some(companion_plugin_protocol::Message::Command{id:7,args,..})=companion_plugin_protocol::read_frame(&mut &bytes[..]).unwrap() else {panic!()};assert!(serde_json::from_value::<Request>(args).unwrap().validate());
 }
 #[test] fn full_ledger_fails_closed_without_eviction_and_keeps_duplicates_readable() {
  let dir=tempfile::tempdir().unwrap();let mut p=Prototype::fixture(&dir.path().join("fixture.sqlite3")).unwrap();let Phase::Active(l)=p.store.phase().unwrap() else {panic!()};let first=req(l,"start",start());p.submit(&first,&[Capability::History]).unwrap();
  for i in 0..255 {p.submit(&req(l,&format!("read{i}"),Operation::OutboxStatus{limit:1}),&[Capability::History]).unwrap();}
  assert_eq!(p.submit(&req(l,"overflow",Operation::OutboxStatus{limit:1}),&[Capability::History]).unwrap_err(),"ledger_full");
  assert_eq!(p.submit(&first,&[Capability::History]).unwrap().status,Status::Completed);
  assert_eq!(p.store.inspect(|tx|Ok(tx.query_row("SELECT count(*) FROM proto_receipts",[],|r|r.get::<_,i64>(0)).unwrap())).unwrap(),256);
 }
 #[test] fn missing_committed_table_is_not_recreated() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("fixture.sqlite3");let mut p=Prototype::fixture(&path).unwrap();p.store.inspect(|tx|{tx.execute_batch("DROP TABLE proto_outbox").unwrap();Ok(())}).unwrap();drop(p);assert!(Prototype::fixture(&path).is_err());
 }
}
