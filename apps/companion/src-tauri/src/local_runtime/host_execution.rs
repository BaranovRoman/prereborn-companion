//! TEST-ONLY: host adapter on owned temporary copies of the real schema.
//! Not registered as a Tauri command, manager capability or GSI consumer.
use std::{path::PathBuf,sync::Arc,time::Duration};
use chrono::{DateTime,Utc};
use rusqlite::{Connection,Transaction,TransactionBehavior,OptionalExtension,params};
use serde::{Serialize,Deserialize};
use companion_dota_domain::{match_execution::*,match_shadow::{self as rules,Context,Action},contracts::ReplayGsi,effects::Status};
use super::{store,schema,detector,model::{LocalMatch,RankedMode},transaction_facade::Facade};
type Result<T> = std::result::Result<T,String>;
fn sql<T>(value:rusqlite::Result<T>)->Result<T>{value.map_err(|_|"storage_unavailable".into())}
fn encode<T:Serialize>(value:&T)->Result<String>{serde_json::to_string(value).map_err(|_|"encoding_failed".into())}
fn hash(value:&str)->String{use sha2::{Digest,Sha256};format!("{:x}",Sha256::digest(value.as_bytes()))}
const TABLES:[(&str,&str);4]=[("local_matches","local_id"),("local_sessions","local_id"),("sync_meta","key"),("sync_outbox","id")];

#[derive(Clone)]
struct Fixture {root:Arc<FixtureRoot>,path:PathBuf}
enum FixtureRoot { Owned(tempfile::TempDir), CrashChild(PathBuf) }
impl FixtureRoot { fn path(&self)->&std::path::Path {match self {Self::Owned(dir)=>dir.path(),Self::CrashChild(path)=>path}} }
impl Fixture {
    fn seeded()->Result<(Self,String,String)> {
        let root=Arc::new(FixtureRoot::Owned(tempfile::tempdir().map_err(|_|"fixture_failed")?));let seed=root.path().join("seed.sqlite3");
        let (session,matched)=super::transaction_tests::seed(&seed);
        let path=root.path().join("isolated.sqlite3");std::fs::copy(seed,&path).map_err(|_|"fixture_failed")?;
        Ok((Self{root,path},session,matched))
    }
    fn connect(&self)->Result<Connection> {
        if self.path.parent()!=Some(self.root.path())||self.path.symlink_metadata().map_err(|_|"fixture_failed")?.file_type().is_symlink(){return Err("not_isolated_fixture".into());}
        let c=sql(Connection::open(&self.path))?;sql(c.busy_timeout(Duration::from_secs(2)))?;Ok(c)
    }
}
fn signature(c:&Connection,legacy:bool)->Result<Vec<(String,String)>> {
    let query=if legacy{"SELECT name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'pc11_%' ORDER BY name"}else{"SELECT name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"};
    let mut stmt=sql(c.prepare(query))?;let rows=sql(stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?))))?;sql(rows.collect())
}
fn reserved(c:&Connection)->Result<()> {
    sql(c.execute_batch("CREATE TABLE pc11_epoch(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0)); INSERT INTO pc11_epoch VALUES(1,0);
    CREATE TABLE pc11_revision(kind TEXT NOT NULL,id TEXT NOT NULL,value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0),deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),PRIMARY KEY(kind,id));
    CREATE TABLE pc11_ticket(id TEXT PRIMARY KEY,doc TEXT NOT NULL,checksum TEXT NOT NULL);
    CREATE TABLE pc11_ledger(operation_key TEXT PRIMARY KEY,identity TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('completed','rejected','unknown')),receipt TEXT,checksum TEXT);") )?;
    for (table,key) in TABLES {
        if matches!(table,"local_matches"|"local_sessions") {
            sql(c.execute(&format!("INSERT INTO pc11_revision SELECT ?1,{key},0,0 FROM {table}"),[table]))?;
            sql(c.execute_batch(&format!("CREATE TRIGGER pc11_identity_{table} BEFORE UPDATE OF {key} ON {table} WHEN OLD.{key}!=NEW.{key} BEGIN SELECT RAISE(ABORT,'immutable_identity'); END;")))?;
        }
        for event in ["INSERT","UPDATE","DELETE"] {
            let row=if event=="DELETE"{"OLD"}else{"NEW"};let deleted=if event=="DELETE"{1}else{0};
            let revision=if matches!(table,"local_matches"|"local_sessions") {format!("INSERT INTO pc11_revision VALUES('{table}',{row}.{key},1,{deleted}) ON CONFLICT(kind,id) DO UPDATE SET value=value+1,deleted={deleted};")}else{String::new()};
            sql(c.execute_batch(&format!("CREATE TRIGGER pc11_write_{table}_{event} AFTER {event} ON {table} BEGIN UPDATE pc11_epoch SET value=value+1 WHERE id=1; {revision} END;")))?;
        }
    }
    Ok(())
}
fn reference()->Result<Connection>{let c=sql(Connection::open_in_memory())?;sql(schema::migrate(&c))?;Ok(c)}
fn integrity(c:&Connection)->Result<()> {
    if sql(c.query_row("PRAGMA quick_check",[],|r|r.get::<_,String>(0)))?!="ok"{return Err("storage_corrupt".into());}
    let invalid:i64=sql(c.query_row("SELECT count(*) FROM local_matches WHERE state NOT IN ('in_progress','post_game_pending','finalized','needs_review','interrupted') OR (result IS NOT NULL AND result NOT IN ('win','loss','abandon'))",[],|r|r.get(0)))?;
    if invalid!=0{return Err("storage_corrupt".into());}
    let mut stmt=sql(c.prepare("SELECT CASE WHEN length(CAST(inventory AS BLOB))<=16384 THEN inventory ELSE NULL END FROM local_matches"))?;
    let rows=sql(stmt.query_map([],|r|r.get::<_,Option<String>>(0)))?;
    for row in rows {let raw=sql(row)?.ok_or("storage_corrupt")?;let inventory:Vec<Option<String>>=serde_json::from_str(&raw).map_err(|_|"storage_corrupt")?;if inventory.len()>9||inventory.iter().flatten().any(|s|s.len()>128){return Err("storage_corrupt".into());}}
    Ok(())
}
// Close SQLite before the owned temporary directory is removed (also on Windows).
struct Adapter {conn:Connection,expected_schema:Vec<(String,String)>,_fixture:Fixture}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {context:Context,snapshot:ReplayGsi,preconditions:Preconditions}
#[derive(Clone)]
struct Prepared {ticket:String,binding:String,data:Ticket}
impl Prepared {
    fn request(&self,key:&str,correlation:&str,plan:rules::Decision)->Request {
        Request{api:1,operation_key:key.into(),correlation_id:correlation.into(),ticket:self.ticket.clone(),binding:self.binding.clone(),preconditions:self.data.preconditions.clone(),plan}
    }
}
fn revision(c:&Connection,kind:&str,id:&str)->Result<u64>{sql(c.query_row("SELECT value FROM pc11_revision WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0)))}
fn preconditions(c:&Connection,session:&str)->Result<Preconditions>{
    let active=sql(store::find_active_match(c,session))?;
    Ok(Preconditions{policy:1,epoch:sql(c.query_row("SELECT value FROM pc11_epoch WHERE id=1",[],|r|r.get(0)))?,session_revision:revision(c,"local_sessions",session)?,match_revision:active.map(|a|revision(c,"local_matches",&a.local_id)).transpose()?})
}
fn state(c:&Connection,matched:&LocalMatch)->Result<MatchState> {
    Ok(MatchState{local_id:matched.local_id.clone(),session_local_id:matched.session_local_id.clone(),match_key:matched.match_key.clone(),game_id:matched.match_id.clone(),state:matched.state,result:matched.result,ranked_mode:matched.ranked_mode,hero_id:matched.hero_id,
        rating_before:matched.rating_before,rating_after:matched.rating_after,kills:matched.kills,deaths:matched.deaths,assists:matched.assists,inventory:matched.inventory.clone(),last_seen_at:matched.last_seen_at.clone(),interrupted_at:matched.interrupted_at.clone(),finalized_at:matched.finalized_at.clone(),diagnostic_revision:revision(c,"local_matches",&matched.local_id)?})
}
fn identity(req:&Request)->Result<String>{Ok(hash(&encode(&(req.api,&req.ticket,&req.binding,&req.preconditions,&req.plan))?))}
fn saved(c:&Connection,req:&Request)->Result<Option<Response>> {
    let oversized:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM pc11_ledger WHERE operation_key=?1 AND (length(CAST(receipt AS BLOB))>32768 OR length(identity)>64 OR length(checksum)>64))",[&req.operation_key],|r|r.get(0)))?;
    if oversized{return Err("receipt_corrupt".into());}
    let row:Option<(String,String,Option<String>,Option<String>)>=sql(c.query_row("SELECT identity,status,receipt,checksum FROM pc11_ledger WHERE operation_key=?1",[&req.operation_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
    let Some((stored,status,receipt,checksum))=row else{return Ok(None);};
    if stored!=identity(req)?{return Err("payload_conflict".into());}
    if status=="unknown"&&receipt.is_none()&&checksum.is_none(){return Ok(Some(Response{correlation_id:req.correlation_id.clone(),status:Status::Unknown,receipt:None}));}
    let (Some(receipt),Some(checksum))=(receipt,checksum)else{return Err("receipt_corrupt".into());};
    if receipt.len()>32768||hash(&receipt)!=checksum{return Err("receipt_corrupt".into());}
    let decoded:Receipt=serde_json::from_str(&receipt).map_err(|_|"receipt_corrupt")?;
    if decoded.operation_key!=req.operation_key||!matches!((&*status,decoded.status),("completed",Status::Completed)|("rejected",Status::Rejected)){return Err("receipt_corrupt".into());}
    Ok(Some(Response{correlation_id:req.correlation_id.clone(),status:decoded.status,receipt:Some(decoded)}))
}
#[derive(Clone,Copy,PartialEq)]
enum Fault {None,RollbackAfterWrites,CrashBeforeCommit,CrashAfterCommit}
impl Adapter {
    fn install(fixture:Fixture)->Result<Self> {
        let mut conn=fixture.connect()?;integrity(&conn)?;let expected=reference()?;
        let version:i64=sql(conn.query_row("PRAGMA user_version",[],|r|r.get(0)))?;
        let expected_version:i64=sql(expected.query_row("PRAGMA user_version",[],|r|r.get(0)))?;
        if version!=expected_version||signature(&conn,true)?!=signature(&expected,true)?{return Err("schema_incompatible".into());}
        let present:i64=sql(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc11_%'",[],|r|r.get(0)))?;
        if present==0 {let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;reserved(&tx)?;sql(tx.commit())?;}
        reserved(&expected)?;let expected_schema=signature(&expected,false)?;
        if signature(&conn,false)?!=expected_schema{return Err("schema_incompatible".into());}
        Ok(Self{_fixture:fixture,conn,expected_schema})
    }
    fn verify(c:&Connection,expected:&[(String,String)])->Result<()> {
        integrity(c)?;if signature(c,false)?!=expected{return Err("schema_incompatible".into());}Ok(())
    }
    fn prepare(&mut self,session:&str,snapshot:ReplayGsi,mode:RankedMode,now:DateTime<Utc>,sequence:u64)->Result<Prepared> {
        let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        let mut context=sql(detector::context(&tx,session,mode,now))?;let row=sql(store::find_session(&tx,session))?.ok_or("session_missing")?;
        context.frame_sequence=sequence;context.snapshot_identity=rules::snapshot_identity(&snapshot);context.session.ended=row.ended_at.is_some();context.session.streamed=row.is_streamed;
        if !rules::analyze(&context,&snapshot,sequence).conclusive{return Err("context_inconclusive".into());}
        let data=Ticket{preconditions:preconditions(&tx,session)?,context,snapshot};let encoded=encode(&data)?;if encoded.len()>16384{return Err("context_too_large".into());}
        let ticket=uuid::Uuid::new_v4().to_string();let binding=hash(&encoded);
        sql(tx.execute("INSERT INTO pc11_ticket VALUES(?1,?2,?3)",params![ticket,encoded,binding]))?;sql(tx.commit())?;
        Ok(Prepared{ticket,binding,data})
    }
    fn execute(&mut self,req:&Request)->Result<Response>{self.execute_fault(req,Fault::None)}
    fn execute_fault(&mut self,req:&Request,fault:Fault)->Result<Response> {
        if !req.bounded(){return Err("invalid_request".into());}
        let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        if let Some(saved)=saved(&tx,req)? {return Ok(saved);}
        let oversized:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM pc11_ticket WHERE id=?1 AND (length(CAST(doc AS BLOB))>16384 OR length(checksum)>64))",[&req.ticket],|r|r.get(0)))?;
        if oversized{return Err("context_corrupt".into());}
        let (raw,checksum):(String,String)=sql(tx.query_row("SELECT doc,checksum FROM pc11_ticket WHERE id=?1",[&req.ticket],|r|Ok((r.get(0)?,r.get(1)?))))?;
        if raw.len()>16384||hash(&raw)!=checksum{return Err("context_corrupt".into());}
        let ticket:Ticket=serde_json::from_str(&raw).map_err(|_|"context_corrupt")?;
        let expected=rules::analyze(&ticket.context,&ticket.snapshot,ticket.context.frame_sequence);
        let error=if req.binding!=checksum||req.preconditions!=ticket.preconditions {Some("invalid_binding")}
            else if preconditions(&tx,&ticket.context.session.local_id)?!=ticket.preconditions{Some("stale_precondition")}
            else if !expected.conclusive||expected.detector.as_ref()!=Some(&req.plan){Some("invalid_plan")}
            else{None};
        let mut receipt=Receipt{api:1,operation_key:req.operation_key.clone(),committed_correlation_id:req.correlation_id.clone(),status:if error.is_some(){Status::Rejected}else{Status::Completed},error:error.map(str::to_string),precondition_outcome:if error.is_some(){PreconditionOutcome::Rejected}else{PreconditionOutcome::Satisfied},before:ticket.preconditions.clone(),after:None,operations:Vec::new(),session:None,current_match:None,outbox:Vec::new()};
        if error.is_none(){apply(&tx,&ticket,&req.plan,&mut receipt)?;}
        if fault==Fault::RollbackAfterWrites{return Err("injected_rollback".into());}
        let encoded=encode(&receipt)?;if encoded.len()>32768{return Err("receipt_too_large".into());}
        sql(tx.execute("INSERT INTO pc11_ledger VALUES(?1,?2,?3,?4,?5)",params![req.operation_key,identity(req)?,if receipt.status==Status::Completed{"completed"}else{"rejected"},encoded,hash(&encoded)]))?;
        if fault==Fault::CrashBeforeCommit{std::process::exit(81);}
        sql(tx.commit())?;
        if fault==Fault::CrashAfterCommit{std::process::exit(82);}
        Ok(Response{correlation_id:req.correlation_id.clone(),status:receipt.status,receipt:Some(receipt)})
    }
    fn recover(&mut self,req:&Request)->Result<Response> {
        if !req.bounded(){return Err("invalid_request".into());}Self::verify(&self.conn,&self.expected_schema)?;
        Ok(saved(&self.conn,req)?.unwrap_or(Response{correlation_id:req.correlation_id.clone(),status:Status::Unknown,receipt:None}))
    }
    fn retain_unknown(&mut self,req:&Request)->Result<()> {
        if !req.bounded(){return Err("invalid_request".into());}
        let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        sql(tx.execute("INSERT INTO pc11_ledger VALUES(?1,?2,'unknown',NULL,NULL)",params![req.operation_key,identity(req)?]))?;sql(tx.commit())
    }
}
fn outbox(c:&Connection,session:&str,matched:&[String])->Result<Vec<OutboxReceipt>> {
    let entities:Vec<&str>=std::iter::once(session).chain(matched.iter().map(String::as_str)).collect();
    let placeholders=vec!["?";entities.len()].join(",");
    let query=format!("SELECT id,entity_local_id,event_type,delivered_at,failed_at,attempts,CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload ELSE NULL END FROM sync_outbox WHERE entity_local_id IN ({placeholders}) ORDER BY rowid LIMIT 65");
    let mut stmt=sql(c.prepare(&query))?;
    let rows=sql(stmt.query_map(rusqlite::params_from_iter(entities),|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,i64>(5)?,r.get::<_,Option<String>>(6)?))))?;
    let mut result=Vec::new();for row in rows {let(id,entity,event,delivered,failed,attempts,payload)=sql(row)?;let payload=payload.ok_or("outbox_payload_limit")?;result.push(OutboxReceipt{id,entity_local_id:entity,event_type:event,delivery:if failed.is_some(){Delivery::Failed}else if delivered.is_some(){Delivery::Delivered}else{Delivery::Pending},attempts,payload_identity:hash(&payload)});if result.len()>64{return Err("outbox_limit".into());}}Ok(result)
}
fn apply(tx:&Transaction<'_>,ticket:&Ticket,plan:&rules::Decision,receipt:&mut Receipt)->Result<()> {
    let f=Facade::new(tx);let session=&ticket.context.session.local_id;let now=ticket.context.captured_at;
    let parsed=super::gsi::parse(&serde_json::to_value(&ticket.snapshot).map_err(|_|"invalid_snapshot")?).ok_or("invalid_snapshot")?;
    let original=sql(f.lookup_active(session))?;let mut current=original.clone();let mut touched=Vec::new();
    for (index,action) in plan.actions.iter().enumerate(){
        let id=match action{Action::UpdateTelemetry{local_id}|Action::Interrupted{local_id}|Action::NeedsReview{local_id}|Action::Pending{local_id,..}|Action::Finalize{local_id,..}|Action::Resume{local_id,..}=>Some(local_id.clone()),_=>current.as_ref().map(|a|a.local_id.clone())};
        let before=id.as_deref().map(|id|sql(f.lookup_match(id))).transpose()?.flatten();
        let before_revision=before.as_ref().map(|a|revision(tx,"local_matches",&a.local_id)).transpose()?;
        let mut resolved=id;let mut conflict=false;
        match action {
            Action::UpdateTelemetry{local_id}=>sql(f.telemetry(local_id,&parsed.telemetry,now))?,
            Action::Interrupted{local_id}=>{sql(f.interrupted(local_id,now))?;current=None;},
            Action::NeedsReview{local_id}=>{sql(f.needs_review(local_id))?;current=None;},
            Action::Pending{local_id,result}=>sql(f.post_game(local_id,*result))?,
            Action::Finalize{local_id,session_local_id,ranked_mode,result,confidence}=>sql(f.finish(local_id,session_local_id,*ranked_mode,*result,confidence,now))?,
            Action::Resume{local_id,game_match_id,hero_id}=>{sql(f.resume(local_id,game_match_id.as_deref(),*hero_id))?;current=sql(f.lookup_active(session))?;},
            Action::EnsureMatch{game_match_id,hero_id,player_team,ranked_mode}=>if current.is_none(){
                let key=store::diagnostic_match_key(session,game_match_id.as_deref(),*hero_id,now);let existing=sql(f.lookup_key(session,&key))?;
                sql(f.create_match(session,game_match_id.as_deref(),*hero_id,player_team,*ranked_mode,now))?;
                let keyed=sql(f.lookup_key(session,&key))?;resolved=keyed.as_ref().map(|a|a.local_id.clone());conflict=existing.is_some();current=sql(f.lookup_active(session))?;
            },
            Action::UpdateCurrentTelemetry=>if let Some(a)=&current{sql(f.telemetry(&a.local_id,&parsed.telemetry,now))?;},
        }
        let after=resolved.as_deref().map(|id|sql(f.lookup_match(id))).transpose()?.flatten();
        let after_revision=after.as_ref().map(|a|revision(tx,"local_matches",&a.local_id)).transpose()?;
        let changed=encode(&before)?!=encode(&after)?||before_revision!=after_revision;
        if let Some(row)=&after {if !touched.contains(&row.local_id){touched.push(row.local_id.clone());}}
        receipt.operations.push(OperationReceipt{index:index as u8,disposition:if conflict{Disposition::Conflicted}else if changed{Disposition::Applied}else{Disposition::Skipped},post_state:after.as_ref().map(|a|state(tx,a)).transpose()?});
    }
    // Resolve closure from real post-state, exactly as legacy mod::handle_gsi, not plan prediction.
    current=sql(f.lookup_active(session))?;
    let terminal=original.as_ref().filter(|_|current.is_none()).map(|a|sql(f.lookup_match(&a.local_id))).transpose()?.flatten();
    let before_session=sql(f.lookup_session(session))?.ok_or("session_missing")?;
    if rules::should_end_gameplay(before_session.is_streamed,terminal.is_some()){sql(f.end_session(session,now))?;}
    let after_session=sql(f.lookup_session(session))?.ok_or("session_missing")?;
    receipt.session=Some(SessionReceipt{local_id:after_session.local_id,ended_at:after_session.ended_at.clone(),rating_current:after_session.rating_current,disposition:if before_session.ended_at!=after_session.ended_at{Disposition::Applied}else{Disposition::Skipped},diagnostic_revision:revision(tx,"local_sessions",session)?});
    receipt.current_match=current.as_ref().map(|a|state(tx,a)).transpose()?;
    receipt.after=Some(preconditions(tx,session)?);receipt.outbox=outbox(tx,session,&touched)?;Ok(())
}
#[cfg(test)]
mod tests;
