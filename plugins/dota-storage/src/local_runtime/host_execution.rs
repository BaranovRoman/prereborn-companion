//! Production transaction adapter on the core-owned connection. Migration is explicit.
//! Not registered as a Tauri command, manager capability or GSI consumer.
use std::path::PathBuf;
#[cfg(test)]
use std::{sync::Arc,time::Duration};
use chrono::{DateTime,Utc};
use rusqlite::{Connection,Transaction,TransactionBehavior,OptionalExtension,params};
use serde::{Serialize,Deserialize};
use companion_dota_domain::{match_execution::*,match_shadow::{self as rules,Context,Action},contracts::ReplayGsi,effects::Status};
use super::{store,schema,detector,model::{LocalMatch,RankedMode},transaction_facade::Facade};
pub type Result<T> = std::result::Result<T,String>;
pub fn sql<T>(value:rusqlite::Result<T>)->Result<T>{value.map_err(|e|if e.to_string().contains("safety_quota_exhausted"){"safety_quota_exhausted".into()}else{"storage_unavailable".into()})}
pub fn encode<T:Serialize>(value:&T)->Result<String>{serde_json::to_string(value).map_err(|_|"encoding_failed".into())}
pub fn hash(value:&str)->String{use sha2::{Digest,Sha256};format!("{:x}",Sha256::digest(value.as_bytes()))}
/// Borrowed verified host authorization. Not deserializable and never granted by Hello.
pub trait ExecutionGrant: companion_plugin_protocol::ProcessGrant {
 fn lease(&self)->companion_dota_domain::ownership::Lease;
 fn session(&self)->Option<&str>;
 fn session_id(&self)->Result<&str> {self.session().ok_or("session_unbound".into())}
}
const TABLES:[(&str,&str);4]=[("local_matches","local_id"),("local_sessions","local_id"),("sync_meta","key"),("sync_outbox","id")];

#[cfg(test)]
#[derive(Clone)]
pub struct Fixture {pub root:Arc<FixtureRoot>,pub path:PathBuf}
#[cfg(test)]
pub enum FixtureRoot { Owned(tempfile::TempDir), CrashChild(PathBuf) }
#[cfg(test)]
impl FixtureRoot { pub fn path(&self)->&std::path::Path {match self {Self::Owned(dir)=>dir.path(),Self::CrashChild(path)=>path}} }
#[cfg(test)]
impl Fixture {
    pub fn seeded()->Result<(Self,String,String)> {
        let root=Arc::new(FixtureRoot::Owned(tempfile::tempdir().map_err(|_|"fixture_failed")?));let seed=root.path().join("seed.sqlite3");
        let (session,matched)=super::transaction_tests::seed(&seed);
        let path=root.path().join("isolated.sqlite3");std::fs::copy(seed,&path).map_err(|_|"fixture_failed")?;
        Ok((Self{root,path},session,matched))
    }
    pub fn connect(&self)->Result<Connection> {
        if self.path.parent()!=Some(self.root.path())||self.path.symlink_metadata().map_err(|_|"fixture_failed")?.file_type().is_symlink(){return Err("not_isolated_fixture".into());}
        let c=sql(Connection::open(&self.path))?;sql(c.busy_timeout(Duration::from_secs(2)))?;Ok(c)
    }
}
pub fn signature(c:&Connection,legacy:bool)->Result<Vec<(String,String)>> {
    let query=if legacy{"SELECT name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'pc_tx_%' ORDER BY name"}else{"SELECT name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"};
    let mut stmt=sql(c.prepare(query))?;let rows=sql(stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?))))?;sql(rows.collect())
}
pub fn reserved(c:&Connection)->Result<()> {
    sql(c.execute_batch("CREATE TABLE pc_tx_epoch(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0)); INSERT INTO pc_tx_epoch VALUES(1,0);
    CREATE TABLE pc_tx_revision(kind TEXT NOT NULL,id TEXT NOT NULL,value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0),deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),PRIMARY KEY(kind,id));
    CREATE TABLE pc_tx_ticket(id TEXT PRIMARY KEY,doc TEXT NOT NULL,checksum TEXT NOT NULL);
    CREATE TABLE pc_tx_ledger(operation_key TEXT PRIMARY KEY,identity TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('completed','rejected','unknown')));
    CREATE TABLE pc_tx_receipts(operation_key TEXT PRIMARY KEY REFERENCES pc_tx_ledger(operation_key),receipt TEXT NOT NULL,checksum TEXT NOT NULL);
    CREATE INDEX pc_tx_ledger_status ON pc_tx_ledger(status,operation_key);
    CREATE TABLE pc_tx_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),baseline TEXT NOT NULL,new_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(new_writes)='integer' AND new_writes>=0));INSERT INTO pc_tx_meta(id,version,baseline) VALUES(1,1,'');") )?;
    sql(c.execute_batch("CREATE TABLE pc_tx_diagnostic_owner(id INTEGER PRIMARY KEY CHECK(id=1),doc TEXT NOT NULL);"))?;
    sql(c.execute_batch("CREATE TABLE pc_tx_limits(id INTEGER PRIMARY KEY CHECK(id=1),max_operations INTEGER NOT NULL CHECK(max_operations>0 AND max_operations<=1000000),max_receipt_bytes INTEGER NOT NULL CHECK(max_receipt_bytes>0 AND max_receipt_bytes<=1073741824),max_tickets INTEGER NOT NULL CHECK(max_tickets>0 AND max_tickets<=1000000),max_ticket_bytes INTEGER NOT NULL CHECK(max_ticket_bytes>0 AND max_ticket_bytes<=1073741824),max_revisions INTEGER NOT NULL CHECK(max_revisions>0 AND max_revisions<=1000000));INSERT INTO pc_tx_limits VALUES(1,10000,67108864,10000,67108864,100000);"))?;
    sql(c.execute_batch("CREATE TABLE pc_tx_usage(kind TEXT PRIMARY KEY,entries INTEGER NOT NULL CHECK(typeof(entries)='integer' AND entries>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=0));"))?;
    super::transaction_authorization::install(c)?;
    for (table,key) in TABLES {
        if matches!(table,"local_matches"|"local_sessions") {
            sql(c.execute(&format!("INSERT INTO pc_tx_revision SELECT ?1,{key},0,0 FROM {table}"),[table]))?;
            sql(c.execute_batch(&format!("CREATE TRIGGER pc_tx_identity_{table} BEFORE UPDATE OF {key} ON {table} WHEN OLD.{key}!=NEW.{key} BEGIN SELECT RAISE(ABORT,'immutable_identity'); END;")))?;
        }
        for event in ["INSERT","UPDATE","DELETE"] {
            let row=if event=="DELETE"{"OLD"}else{"NEW"};let deleted=if event=="DELETE"{1}else{0};
            let revision=if matches!(table,"local_matches"|"local_sessions") {format!("INSERT INTO pc_tx_revision VALUES('{table}',{row}.{key},1,{deleted}) ON CONFLICT(kind,id) DO UPDATE SET value=value+1,deleted={deleted};")}else{String::new()};
            sql(c.execute_batch(&format!("CREATE TRIGGER pc_tx_write_{table}_{event} AFTER {event} ON {table} BEGIN UPDATE pc_tx_epoch SET value=value+1 WHERE id=1; {revision} END;")))?;
        }
    }
    for (table,column,max_rows,max_bytes) in [("pc_tx_ledger","identity","max_operations","max_receipt_bytes"),("pc_tx_receipts","receipt","max_operations","max_receipt_bytes"),("pc_tx_ticket","doc","max_tickets","max_ticket_bytes"),("pc_tx_revision","id","max_revisions","max_receipt_bytes")] {
        sql(c.execute_batch(&format!("INSERT INTO pc_tx_usage SELECT '{table}',count(*),coalesce(sum(length(CAST({column} AS BLOB))),0) FROM {table};")))?;
        let fresh=if table=="pc_tx_revision"{"NOT EXISTS(SELECT 1 FROM pc_tx_revision WHERE kind=NEW.kind AND id=NEW.id) AND"}else{""};
        sql(c.execute_batch(&format!("CREATE TRIGGER pc_tx_quota_{table} BEFORE INSERT ON {table} WHEN {fresh} ((SELECT entries FROM pc_tx_usage WHERE kind='{table}')>=(SELECT {max_rows} FROM pc_tx_limits WHERE id=1) OR (SELECT bytes FROM pc_tx_usage WHERE kind='{table}')+length(CAST(NEW.{column} AS BLOB))>(SELECT {max_bytes} FROM pc_tx_limits WHERE id=1)) BEGIN SELECT RAISE(ABORT,'safety_quota_exhausted'); END;
        CREATE TRIGGER pc_tx_usage_{table}_INSERT AFTER INSERT ON {table} BEGIN UPDATE pc_tx_usage SET entries=entries+1,bytes=bytes+length(CAST(NEW.{column} AS BLOB)) WHERE kind='{table}'; END;
        CREATE TRIGGER pc_tx_usage_{table}_UPDATE AFTER UPDATE ON {table} BEGIN UPDATE pc_tx_usage SET bytes=bytes+length(CAST(NEW.{column} AS BLOB))-length(CAST(OLD.{column} AS BLOB)) WHERE kind='{table}'; END;")))?;
    }
    let revisions:i64=sql(c.query_row("SELECT count(*) FROM pc_tx_revision",[],|r|r.get(0)))?;if revisions>100000{return Err("safety_quota_exhausted".into());}
    for table in ["pc_tx_ticket","pc_tx_ledger","pc_tx_receipts","pc_tx_owner","pc_tx_limits"] {
        for event in ["INSERT","UPDATE","DELETE"] {
            sql(c.execute_batch(&format!("CREATE TRIGGER pc_tx_new_{table}_{event} AFTER {event} ON {table} BEGIN UPDATE pc_tx_meta SET new_writes=new_writes+1 WHERE id=1; END;")))?;
        }
    }
    for table in ["pc_tx_ticket","pc_tx_ledger","pc_tx_receipts","pc_tx_revision","pc_tx_owner","pc_tx_limits","pc_tx_usage","pc_tx_meta","pc_tx_epoch"] {
        sql(c.execute_batch(&format!("CREATE TRIGGER pc_tx_keep_{table} BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'safety_retention_delete_denied'); END;")))?;
    }
    Ok(())
}
pub fn reference()->Result<Connection>{let c=sql(Connection::open_in_memory())?;sql(schema::migrate(&c))?;Ok(c)}
pub fn integrity(c:&Connection)->Result<()> {
    if sql(c.query_row("PRAGMA quick_check",[],|r|r.get::<_,String>(0)))?!="ok"{return Err("storage_corrupt".into());}
    let foreign_keys:i64=sql(c.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get(0)))?;
    if foreign_keys!=0{return Err("storage_corrupt".into());}
    let invalid:i64=sql(c.query_row("SELECT count(*) FROM local_matches WHERE state NOT IN ('in_progress','post_game_pending','finalized','needs_review','interrupted') OR (result IS NOT NULL AND result NOT IN ('win','loss','abandon'))",[],|r|r.get(0)))?;
    if invalid!=0{return Err("storage_corrupt".into());}
    let mut stmt=sql(c.prepare("SELECT CASE WHEN length(CAST(inventory AS BLOB))<=16384 THEN inventory ELSE NULL END FROM local_matches"))?;
    let rows=sql(stmt.query_map([],|r|r.get::<_,Option<String>>(0)))?;
    for row in rows {let raw=sql(row)?.ok_or("storage_corrupt")?;let inventory:Vec<Option<String>>=serde_json::from_str(&raw).map_err(|_|"storage_corrupt")?;if inventory.len()>9||inventory.iter().flatten().any(|s|s.len()>128){return Err("storage_corrupt".into());}}
    Ok(())
}
fn integrity_scope(c:&Connection,session:&str)->Result<()> {
    let mut stmt=sql(c.prepare("SELECT state,result,CASE WHEN length(CAST(inventory AS BLOB))<=16384 THEN inventory ELSE NULL END FROM local_matches WHERE session_local_id=?1"))?;
    let rows=sql(stmt.query_map([session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))))?;
    for row in rows {let(state,result,inventory)=sql(row)?;
        if super::model::LocalMatchState::from_db_str(&state).is_none()||result.as_deref().is_some_and(|s|super::model::MatchResult::from_db_str(s).is_none()){return Err("storage_corrupt".into());}
        let inventory:Vec<Option<String>>=serde_json::from_str(&inventory.ok_or("storage_corrupt")?).map_err(|_|"storage_corrupt")?;
        if inventory.len()>9||inventory.iter().flatten().any(|s|s.len()>128){return Err("storage_corrupt".into());}
    }Ok(())
}
// Close SQLite before the owned temporary directory is removed (also on Windows).
pub struct Adapter {expected_schema:Vec<(String,String)>,path:PathBuf,_coordinator:std::fs::File}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ticket {pub context:Context,pub snapshot:ReplayGsi,pub preconditions:Preconditions}
#[derive(Clone)]
pub struct Prepared {pub ticket:String,pub binding:String,pub data:Ticket,pub core_context:Option<ContextReceipt>}
impl Prepared {
    pub fn core_request(&self,key:&str,correlation:&str)->Result<Request> {
        let analysis=rules::analyze(&self.data.context,&self.data.snapshot,self.data.context.frame_sequence);
        if !analysis.conclusive{return Err("context_inconclusive".into());}Ok(self.request(key,correlation,analysis.detector.ok_or("missing_plan")?))
    }
    pub fn request(&self,key:&str,correlation:&str,plan:rules::Decision)->Request {
        Request{api:1,operation_key:key.into(),correlation_id:correlation.into(),ticket:self.ticket.clone(),binding:self.binding.clone(),preconditions:self.data.preconditions.clone(),plan}
    }
}
pub fn revision(c:&Connection,kind:&str,id:&str)->Result<u64>{sql(c.query_row("SELECT value FROM pc_tx_revision WHERE kind=?1 AND id=?2",params![kind,id],|r|r.get(0)))}
pub fn preconditions(c:&Connection,session:&str)->Result<Preconditions>{
    let active=sql(store::find_active_match(c,session))?;
    Ok(Preconditions{policy:1,epoch:sql(c.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?,session_revision:revision(c,"local_sessions",session)?,match_revision:active.map(|a|revision(c,"local_matches",&a.local_id)).transpose()?})
}
fn state(c:&Connection,matched:&LocalMatch)->Result<MatchState> {
    Ok(MatchState{local_id:matched.local_id.clone(),session_local_id:matched.session_local_id.clone(),match_key:matched.match_key.clone(),game_id:matched.match_id.clone(),state:matched.state,result:matched.result,ranked_mode:matched.ranked_mode,hero_id:matched.hero_id,
        rating_before:matched.rating_before,rating_after:matched.rating_after,kills:matched.kills,deaths:matched.deaths,assists:matched.assists,inventory:matched.inventory.clone(),last_seen_at:matched.last_seen_at.clone(),interrupted_at:matched.interrupted_at.clone(),finalized_at:matched.finalized_at.clone(),diagnostic_revision:revision(c,"local_matches",&matched.local_id)?})
}
fn identity(req:&Request)->Result<String>{Ok(hash(&encode(&(req.api,&req.ticket,&req.binding,&req.preconditions,&req.plan))?))}
fn saved(c:&Connection,req:&Request)->Result<Option<Response>> {
    let oversized:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1 AND (length(CAST(receipt AS BLOB))>32768 OR length(identity)>64 OR length(checksum)>64))",[&req.operation_key],|r|r.get(0)))?;
    if oversized{return Err("receipt_corrupt".into());}
    let row:Option<(String,String,Option<String>,Option<String>)>=sql(c.query_row("SELECT identity,status,receipt,checksum FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&req.operation_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
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
enum Fault {None,#[cfg(test)] RollbackAfterWrites,#[cfg(test)] CrashBeforeCommit,#[cfg(test)] CrashAfterCommit}
impl Adapter {
    pub fn execute_builtin(&mut self,conn:&mut Connection,lease:companion_dota_domain::ownership::Lease,session:&str,req:&Request)->Result<Response> {
        if lease.owner!=companion_dota_domain::ownership::Owner::BuiltIn{return Err("builtin_identity_required".into());}
        self.execute_guarded(conn,req,Fault::None,&|tx|super::transaction_authorization::authorize(tx,lease,session,None,req))
    }
    pub fn recover_builtin(&mut self,conn:&mut Connection,lease:companion_dota_domain::ownership::Lease,session:&str,req:&Request)->Result<Response> {
        if lease.owner!=companion_dota_domain::ownership::Owner::BuiltIn{return Err("builtin_identity_required".into());}
        self.recover_guarded(conn,req,&|tx|super::transaction_authorization::authorize(tx,lease,session,None,req))
    }
    pub fn record_unknown_builtin(&mut self,conn:&mut Connection,lease:companion_dota_domain::ownership::Lease,session:&str,req:&Request)->Result<()> {
        if lease.owner!=companion_dota_domain::ownership::Owner::BuiltIn{return Err("builtin_identity_required".into());}
        self.retain_unknown_guarded(conn,req,&|tx|super::transaction_authorization::authorize(tx,lease,session,None,req))
    }
    pub fn execute_plugin(&mut self,conn:&mut Connection,pin:&impl ExecutionGrant,req:&Request)->Result<Response> {
        let grant=pin;self.execute_guarded(conn,req,Fault::None,&|tx|super::transaction_authorization::authorize(tx,grant.lease(),grant.session_id()?,Some(grant.binding()),req))
    }
    pub fn record_unknown_plugin(&mut self,conn:&mut Connection,pin:&impl ExecutionGrant,req:&Request)->Result<()> {
        let grant=pin;self.retain_unknown_guarded(conn,req,&|tx|super::transaction_authorization::authorize(tx,grant.lease(),grant.session_id()?,Some(grant.binding()),req))
    }
    pub fn recover_plugin(&mut self,conn:&mut Connection,pin:&impl ExecutionGrant,req:&Request)->Result<Response> {
        let grant=pin;self.recover_guarded(conn,req,&|tx|super::transaction_authorization::authorize(tx,grant.lease(),grant.session_id()?,Some(grant.binding()),req))
    }
    pub fn attach(conn:&mut Connection)->Result<Self> {
        let (path,lock)=super::transaction_schema::claim(conn)?;
        super::transaction_schema::validate(conn)?;
        super::transaction_authorization::uncertain_restart(conn)?;
        live_effects::recover_pending_audio(conn)?;
        Ok(Self{path,_coordinator:lock,expected_schema:signature(conn,false)?})
    }
    fn bound(&self,conn:&Connection)->Result<()> {
        if std::fs::canonicalize(conn.path().ok_or("connection_unbound")?).map_err(|_|"connection_unbound")?!=self.path{return Err("connection_unbound".into());}Ok(())
    }
    fn verify(c:&Connection,expected:&[(String,String)])->Result<()> {
        if signature(c,false)?!=expected{return Err("schema_incompatible".into());}super::transaction_schema::version(c)
    }
    pub fn prepare_plugin_operation(&mut self,conn:&mut Connection,pin:&impl ExecutionGrant,snapshot:ReplayGsi,now:DateTime<Utc>,sequence:u64)->Result<Option<Prepared>> {
        let grant=pin;let mode=super::sync::cached_ranked_mode(conn);
        self.prepare_internal(conn,grant.session_id()?,snapshot,mode,now,sequence,true,Some(grant.lease()),&|tx|super::transaction_authorization::authorize_scope(tx,grant.lease(),grant.session_id()?,Some(grant.binding())))
    }
    pub fn prepare_live_operation(&mut self,conn:&mut Connection,session:&str,snapshot:ReplayGsi,now:DateTime<Utc>,sequence:u64)->Result<Option<Prepared>> {
        let mode=super::sync::cached_ranked_mode(conn);
        self.prepare_operation(conn,session,snapshot,mode,now,sequence)
    }
    pub fn prepare_operation(&mut self,conn:&mut Connection,session:&str,snapshot:ReplayGsi,mode:RankedMode,now:DateTime<Utc>,sequence:u64)->Result<Option<Prepared>> {
        self.prepare_internal(conn,session,snapshot,mode,now,sequence,true,None,&|_|Ok(()))
    }
    pub fn prepare(&mut self,conn:&mut Connection,session:&str,snapshot:ReplayGsi,mode:RankedMode,now:DateTime<Utc>,sequence:u64)->Result<Prepared> {
        self.prepare_internal(conn,session,snapshot,mode,now,sequence,false,None,&|_|Ok(()))?.ok_or("missing_plan".into())
    }
    fn prepare_internal(&mut self,conn:&mut Connection,session:&str,snapshot:ReplayGsi,mode:RankedMode,now:DateTime<Utc>,sequence:u64,skip_noop:bool,rolling:Option<companion_dota_domain::ownership::Lease>,guard:&dyn Fn(&Connection)->Result<()>)->Result<Option<Prepared>> {
        self.bound(conn)?;let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        guard(&tx)?;integrity_scope(&tx,session)?;
        let mut context=sql(detector::context(&tx,session,mode,now))?;let row=sql(store::find_session(&tx,session))?.ok_or("session_missing")?;
        context.frame_sequence=sequence;context.snapshot_identity=rules::snapshot_identity(&snapshot);context.session.ended=row.ended_at.is_some();context.session.streamed=row.is_streamed;
        let analysis=rules::analyze(&context,&snapshot,sequence);
        if !analysis.conclusive{return Err("context_inconclusive".into());}
        if skip_noop&&(analysis.detector.is_none()||analysis.detector.as_ref().is_some_and(|p|p.actions.is_empty()&&!p.end_gameplay_session)){return Ok(None);}
        let data=Ticket{preconditions:preconditions(&tx,session)?,context,snapshot};let encoded=encode(&data)?;if encoded.len()>16384{return Err("context_too_large".into());}
        let ticket=if let Some(lease)=rolling.filter(|_|telemetry_only(&data,analysis.detector.as_ref().unwrap())) {
            let matched=data.context.active.as_ref().ok_or("missing_match")?;
            let id=format!("telemetry:{}:{}",lease.epoch,matched.local_id);
            let prior:Option<String>=sql(tx.query_row("SELECT doc FROM pc_tx_ticket WHERE id=?1",[&id],|r|r.get(0)).optional())?;
            if let Some(raw)=prior {
                if raw.len()>16384{return Err("context_corrupt".into());}
                let old:Ticket=serde_json::from_str(&raw).map_err(|_|"context_corrupt")?;
                let old_req=Prepared{ticket:id.clone(),binding:hash(&raw),data:old.clone(),core_context:None}.core_request(&id,&id)?;
                let confirmed=saved(&tx,&old_req)?.ok_or("telemetry_commit_unconfirmed")?;
                if confirmed.status!=Status::Completed||confirmed.receipt.as_ref().and_then(|r|r.after.as_ref()).is_none_or(|p|p.epoch>data.preconditions.epoch){return Err("telemetry_commit_unconfirmed".into());}
                if sequence<=old.context.frame_sequence{return Err("stale_telemetry_sequence".into());}
            }
            id
        }else{uuid::Uuid::new_v4().to_string()};let binding=hash(&encoded);
        check_update_bytes(&tx,"pc_tx_ticket","doc","id",&ticket,encoded.len(),"max_ticket_bytes")?;
        sql(tx.execute("INSERT INTO pc_tx_ticket VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc,checksum=excluded.checksum",params![ticket,encoded,binding]))?;sql(tx.commit())?;
        let core_context=Some(ContextReceipt{preconditions:data.preconditions.clone(),current_context:data.context.active.clone(),session:SessionReceipt{local_id:row.local_id,ended_at:row.ended_at,streamed:row.is_streamed,rating_current:row.rating_current,disposition:Disposition::Skipped,diagnostic_revision:data.preconditions.session_revision}});
        Ok(Some(Prepared{ticket,binding,data,core_context}))
    }
    #[cfg(test)]
    fn execute(&mut self,conn:&mut Connection,req:&Request)->Result<Response>{self.execute_fault(conn,req,Fault::None)}
    #[cfg(test)]
    fn execute_fault(&mut self,conn:&mut Connection,req:&Request,fault:Fault)->Result<Response> {
        self.execute_guarded(conn,req,fault,&|_|Ok(()))
    }
    fn execute_guarded(&mut self,conn:&mut Connection,req:&Request,_fault:Fault,guard:&dyn Fn(&Connection)->Result<()>)->Result<Response> {
        if !req.bounded()||req.operation_key.starts_with("effect:"){return Err("invalid_request".into());}
        self.bound(conn)?;let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        guard(&tx)?;
        let rolling=req.operation_key.starts_with("telemetry:");
        if !rolling {if let Some(saved)=saved(&tx,req)? {integrity(&tx)?;return Ok(saved);}}
        else {
            if req.operation_key!=req.ticket{return Err("invalid_telemetry_slot".into());}
            match saved(&tx,req) {Ok(Some(saved))=>return Ok(saved),Ok(None)=>(),Err(e) if e=="payload_conflict"=>(),Err(e)=>return Err(e)}
        }
        let oversized:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM pc_tx_ticket WHERE id=?1 AND (length(CAST(doc AS BLOB))>16384 OR length(checksum)>64))",[&req.ticket],|r|r.get(0)))?;
        if oversized{return Err("context_corrupt".into());}
        let (raw,checksum):(String,String)=sql(tx.query_row("SELECT doc,checksum FROM pc_tx_ticket WHERE id=?1",[&req.ticket],|r|Ok((r.get(0)?,r.get(1)?))))?;
        if raw.len()>16384||hash(&raw)!=checksum{return Err("context_corrupt".into());}
        let ticket:Ticket=serde_json::from_str(&raw).map_err(|_|"context_corrupt")?;
        integrity_scope(&tx,&ticket.context.session.local_id)?;
        if rolling {
            if !telemetry_only(&ticket,&req.plan){return Err("irreversible_telemetry_plan".into());}
            verify_telemetry_slot(&tx,req,&ticket)?;
        }
        let expected=rules::analyze(&ticket.context,&ticket.snapshot,ticket.context.frame_sequence);
        let error=if req.binding!=checksum||req.preconditions!=ticket.preconditions {Some("invalid_binding")}
            else if preconditions(&tx,&ticket.context.session.local_id)?!=ticket.preconditions{Some("stale_precondition")}
            else if !expected.conclusive||expected.detector.as_ref()!=Some(&req.plan){Some("invalid_plan")}
            else{None};
        let mut receipt=Receipt{api:1,operation_key:req.operation_key.clone(),committed_correlation_id:req.correlation_id.clone(),status:if error.is_some(){Status::Rejected}else{Status::Completed},error:error.map(str::to_string),precondition_outcome:if error.is_some(){PreconditionOutcome::Rejected}else{PreconditionOutcome::Satisfied},before:ticket.preconditions.clone(),after:None,operations:Vec::new(),session:None,current_match:None,current_context:None,outbox:Vec::new()};
        if error.is_none(){apply(&tx,&ticket,&req.plan,&mut receipt)?;}
        #[cfg(test)]
        if _fault==Fault::RollbackAfterWrites{return Err("injected_rollback".into());}
        let encoded=encode(&receipt)?;if encoded.len()>32768{return Err("receipt_too_large".into());}
        check_update_bytes(&tx,"pc_tx_receipts","receipt","operation_key",&req.operation_key,encoded.len(),"max_receipt_bytes")?;
        let ledger_sql=if rolling {"INSERT INTO pc_tx_ledger VALUES(?1,?2,?3) ON CONFLICT(operation_key) DO UPDATE SET identity=excluded.identity,status=excluded.status"}else{"INSERT INTO pc_tx_ledger VALUES(?1,?2,?3)"};
        let receipt_sql=if rolling {"INSERT INTO pc_tx_receipts VALUES(?1,?2,?3) ON CONFLICT(operation_key) DO UPDATE SET receipt=excluded.receipt,checksum=excluded.checksum"}else{"INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)"};
        sql(tx.execute(ledger_sql,params![req.operation_key,identity(req)?,if receipt.status==Status::Completed{"completed"}else{"rejected"}]))?;
        sql(tx.execute(receipt_sql,params![req.operation_key,encoded,hash(&encoded)]))?;
        #[cfg(test)]
        if _fault==Fault::CrashBeforeCommit{std::process::exit(81);}
        sql(tx.commit())?;
        #[cfg(test)]
        if _fault==Fault::CrashAfterCommit{std::process::exit(82);}
        Ok(Response{correlation_id:req.correlation_id.clone(),status:receipt.status,receipt:Some(receipt)})
    }
    #[cfg(test)]
    fn recover(&mut self,conn:&mut Connection,req:&Request)->Result<Response> {
        self.recover_guarded(conn,req,&|_|Ok(()))
    }
    fn recover_guarded(&mut self,conn:&mut Connection,req:&Request,guard:&dyn Fn(&Connection)->Result<()>)->Result<Response> {
        if !req.bounded()||req.operation_key.starts_with("effect:"){return Err("invalid_request".into());}
        self.bound(conn)?;let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;integrity(&tx)?;guard(&tx)?;
        Ok(saved(&tx,req)?.unwrap_or(Response{correlation_id:req.correlation_id.clone(),status:Status::Unknown,receipt:None}))
    }
    #[cfg(test)]
    fn retain_unknown(&mut self,conn:&mut Connection,req:&Request)->Result<()> {self.retain_unknown_guarded(conn,req,&|_|Ok(()))}
    fn retain_unknown_guarded(&mut self,conn:&mut Connection,req:&Request,guard:&dyn Fn(&Connection)->Result<()>)->Result<()> {
        if !req.bounded()||req.operation_key.starts_with("effect:"){return Err("invalid_request".into());}
        self.bound(conn)?;let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        guard(&tx)?;if let Some(response)=saved(&tx,req)? {return if response.status==Status::Unknown{Ok(())}else{Err("terminal_receipt_is_immutable".into())};}
        sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'unknown')",params![req.operation_key,identity(req)?]))?;sql(tx.commit())
    }
}
// A telemetry slot is a monotonic register, not an irreversible operation key.
// Only unchanged active identity and the exact real Resume/Ensure/Telemetry plan qualify.
fn telemetry_only(ticket:&Ticket,plan:&rules::Decision)->bool {
    use super::model::LocalMatchState;
    let Some(active)=&ticket.context.active else{return false;};
    if ticket.context.session.ended||plan.end_gameplay_session{return false;}
    if active.state==LocalMatchState::PostGamePending {
        return matches!(plan.actions.as_slice(),[Action::UpdateTelemetry{local_id}] if local_id==&active.local_id);
    }
    if active.state!=LocalMatchState::InProgress{return false;}
    let Some(parsed)=super::gsi::parse(&serde_json::to_value(&ticket.snapshot).unwrap())else{return false;};
    if (parsed.match_id.is_some()&&parsed.match_id!=active.match_id)||parsed.team_name.as_deref()!=Some(&active.player_team){return false;}
    matches!(plan.actions.as_slice(),[Action::Resume{local_id,game_match_id,hero_id},Action::EnsureMatch{..},Action::UpdateCurrentTelemetry]
        if local_id==&active.local_id&&game_match_id==&parsed.match_id&&Some(*hero_id)==parsed.hero_id)
}
fn check_update_bytes(c:&Connection,table:&str,column:&str,key_column:&str,key:&str,size:usize,limit:&str)->Result<()> {
    let fits:bool=sql(c.query_row(&format!("SELECT (SELECT bytes FROM pc_tx_usage WHERE kind=?1)-coalesce((SELECT length(CAST({column} AS BLOB)) FROM {table} WHERE {key_column}=?2),0)+?3<=(SELECT {limit} FROM pc_tx_limits WHERE id=1)"),params![table,key,size as u64],|r|r.get(0)))?;
    if !fits{return Err("safety_quota_exhausted".into());}Ok(())
}
fn verify_telemetry_slot(c:&Connection,req:&Request,ticket:&Ticket)->Result<()> {
    let record=super::transaction_authorization::load(c)?;
    let companion_dota_domain::ownership::Phase::Active(lease)=record.phase else{return Err("ownership_fenced".into());};
    let active=ticket.context.active.as_ref().ok_or("missing_match")?;
    if req.ticket!=format!("telemetry:{}:{}",lease.epoch,active.local_id)||record.session.as_deref()!=Some(&ticket.context.session.local_id){return Err("telemetry_scope_mismatch".into());}
    let status:Option<String>=sql(c.query_row("SELECT status FROM pc_tx_ledger WHERE operation_key=?1",[&req.operation_key],|r|r.get(0)).optional())?;
    if status.as_deref().is_some_and(|s|s!="completed"){return Err("telemetry_commit_unconfirmed".into());}
    let prior:Option<(String,String,String)>=sql(c.query_row("SELECT status,receipt,checksum FROM pc_tx_ledger JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&req.operation_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
    if status.is_some()&&prior.is_none(){return Err("receipt_corrupt".into());}
    if let Some((status,doc,checksum))=prior {
        if status!="completed"||doc.len()>32768||hash(&doc)!=checksum{return Err("telemetry_commit_unconfirmed".into());}
        let receipt:Receipt=serde_json::from_str(&doc).map_err(|_|"receipt_corrupt")?;
        if receipt.after.as_ref().is_none_or(|p|p.epoch>ticket.preconditions.epoch)||receipt.current_match.as_ref().is_none_or(|m|m.local_id!=active.local_id){return Err("stale_telemetry_precondition".into());}
    }
    Ok(())
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
    receipt.session=Some(SessionReceipt{local_id:after_session.local_id,ended_at:after_session.ended_at.clone(),streamed:after_session.is_streamed,rating_current:after_session.rating_current,disposition:if before_session.ended_at!=after_session.ended_at{Disposition::Applied}else{Disposition::Skipped},diagnostic_revision:revision(tx,"local_sessions",session)?});
    receipt.current_match=current.as_ref().map(|a|state(tx,a)).transpose()?;
    receipt.current_context=current.as_ref().map(detector::match_context);
    receipt.after=Some(preconditions(tx,session)?);receipt.outbox=outbox(tx,session,&touched)?;Ok(())
}
#[cfg(test)]
pub mod tests;
#[cfg(test)]
mod bridge;
#[cfg(test)]
mod fixture;
#[cfg(test)]
use fixture::FixtureAdapter;

pub mod live_effects;

pub mod external_lifecycle;
