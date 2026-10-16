//! Host transport receipts only. No game types, rules, history tables or SQL RPC.
//! This DB does not claim atomicity with a worker's private history transaction.
use companion_plugin_protocol::{audio::{Token,Status},runtime::ProcessBinding};
use rusqlite::{Connection,OptionalExtension,TransactionBehavior,params};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{fs::{File,OpenOptions},path::Path,time::Duration};
type Result<T>=std::result::Result<T,String>;
const LIMIT:u64=10000;
const BYTE_LIMIT:u64=32*1024*1024;
const SCHEMA:&str="CREATE TABLE transport_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO transport_meta VALUES(1,1);
CREATE TABLE transport_effects(plugin TEXT NOT NULL,operation_key TEXT NOT NULL,identity TEXT NOT NULL CHECK(length(identity)=64),receipt TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64),PRIMARY KEY(plugin,operation_key));
CREATE UNIQUE INDEX transport_playback ON transport_effects(json_extract(receipt,'$.playback.id')) WHERE json_extract(receipt,'$.playback.id') IS NOT NULL;
CREATE TABLE transport_processes(plugin TEXT PRIMARY KEY,record TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64));";
fn sql<T>(r:rusqlite::Result<T>)->Result<T>{r.map_err(|_|"transport_storage_failed".into())}
fn encode<T:Serialize>(v:&T)->Result<String>{serde_json::to_string(v).map_err(|_|"transport_encode_failed".into())}
fn hash(s:&str)->String{format!("{:x}",Sha256::digest(s.as_bytes()))}
fn key(s:&str)->bool{!s.is_empty()&&s.len()<=128&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_:".contains(&b)||b==b'.')}
fn package(p:&companion_plugin_protocol::PackageBinding)->bool{
 !p.id.is_empty()&&p.id.len()<=64&&p.id.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'-')
 &&!p.version.is_empty()&&p.version.len()<=240&&[&p.manifest_hash,&p.executable_hash].iter().all(|h|h.len()==64&&h.bytes().all(|b|b.is_ascii_hexdigit()))
}
fn identity(receipt:&Receipt)->Result<String>{Ok(hash(&encode(&(&receipt.process,&receipt.action,receipt.playback.as_ref().map(|t|&t.scope)))?))}

#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum Action {
 Sound{asset_file:String,volume:u8},
 Speech{text:String,volume:u8},
 Scene{name:String},
}
impl Action {
 pub fn permission(&self)->&'static str{match self{Self::Sound{..}|Self::Speech{..}=>"audio.play",Self::Scene{..}=>"obs.scene"}}
 fn validate(&self)->Result<()>{
  match self {
   Self::Sound{asset_file,volume}=>{
    companion_plugin_manager::safe_path(asset_file)?;
    if asset_file.contains('/')||*volume>100||!matches!(Path::new(asset_file).extension().and_then(|s|s.to_str()),Some("wav"|"mp3"|"ogg")){return Err("invalid_sound_intent".into());}
   },
   Self::Speech{text,volume}=>if text.is_empty()||text.len()>256||text.chars().any(char::is_control)||*volume>100{return Err("invalid_speech_intent".into());},
   Self::Scene{name}=>if name.is_empty()||name.len()>256||name.chars().any(char::is_control){return Err("invalid_scene_intent".into());},
  }Ok(())
 }
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Receipt {
 pub process:ProcessIdentity,pub operation_key:String,pub action:Action,
 pub playback:Option<Token>,pub status:Status,pub uncertain:bool,
}
// Persist the actual verified package and generation, not a PID or iframe label.
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ProcessIdentity {pub generation:String,pub package:companion_plugin_protocol::PackageBinding}
impl From<&ProcessBinding> for ProcessIdentity{fn from(p:&ProcessBinding)->Self{Self{generation:p.generation.clone(),package:p.package.clone()}}}
#[derive(Clone,Copy,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="snake_case")]
pub enum ProcessPhase{Starting,Running,Draining,Stopped}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ProcessRecord{pub process:ProcessIdentity,pub epoch:u64,pub phase:ProcessPhase,supervision:String}
#[derive(Debug)]
pub struct Admission{pub fresh:bool,pub receipt:Receipt}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Quota{pub remaining_operations:u64,pub remaining_bytes:u64,pub unknown:u64,pub pending:u64}
pub struct Store{conn:Connection,_lock:File}
impl Store {
 pub fn open(path:&Path)->Result<Self>{
  if path.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()){return Err("transport_path_invalid".into());}
  let lock_path=path.with_extension("sqlite3.coordinator.lock");
  let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path).map_err(|_|"transport_lock_failed")?;
  lock.try_lock().map_err(|_|"second_transport_coordinator_denied")?;
  let fresh=!path.exists();let mut conn=sql(Connection::open(path))?;
  sql(conn.busy_timeout(Duration::from_millis(100)))?;
  let check:String=sql(conn.query_row("PRAGMA quick_check",[],|r|r.get(0)))?;if check!="ok"{return Err("transport_store_corrupt".into());}
  sql(conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;"))?;
  if fresh{let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;sql(tx.execute_batch(SCHEMA))?;sql(tx.commit())?;}
  Self::validate(&conn)?;
  Self::quota_in(&conn)?;
  let oversized:bool=sql(conn.query_row("SELECT EXISTS(SELECT 1 FROM transport_effects WHERE length(CAST(receipt AS BLOB))>4096)",[],|r|r.get(0)))?;
  if oversized{return Err("transport_receipt_corrupt".into());}
  // Host/WebView restart cannot confirm queued/playing audio or an OBS result.
  let mut store=Self{conn,_lock:lock};
  let tx=sql(store.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
  let rows={let mut statement=sql(tx.prepare("SELECT plugin,operation_key,CASE WHEN length(CAST(receipt AS BLOB))<=4096 THEN receipt ELSE NULL END,checksum,identity FROM transport_effects"))?;
   let rows=sql(statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))))?;sql(rows.collect::<rusqlite::Result<Vec<_>>>())?};
  for (plugin,key,doc,checksum,stored_identity) in rows {
   let mut receipt=Self::decode(&doc,&checksum)?;
   if receipt.process.package.id!=plugin||receipt.operation_key!=key||identity(&receipt)?!=stored_identity{return Err("transport_receipt_corrupt".into());}
   if matches!(receipt.status,Status::Unknown|Status::Queued|Status::Playing){receipt.status=Status::Unknown;receipt.uncertain=true;Self::write(&tx,&receipt)?;}
  }
  let process_rows={let mut statement=sql(tx.prepare("SELECT plugin,CASE WHEN length(CAST(record AS BLOB))<=2048 THEN record ELSE NULL END,checksum FROM transport_processes LIMIT 129"))?;
   let rows=sql(statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?))))?;sql(rows.collect::<rusqlite::Result<Vec<_>>>())?};
  if process_rows.len()>128{return Err("transport_process_quota_exhausted".into());}
  for (plugin,doc,checksum) in process_rows{
   let mut record=Self::decode_process(doc.as_deref().ok_or("transport_process_corrupt")?,&checksum)?;
   if record.process.package.id!=plugin{return Err("transport_process_corrupt".into());}
   if record.phase!=ProcessPhase::Stopped{record.phase=ProcessPhase::Draining;Self::write_process(&tx,&record)?;}
  }
  sql(tx.commit())?;Ok(store)
 }
 fn validate(c:&Connection)->Result<()>{
  let version:i64=sql(c.query_row("SELECT version FROM transport_meta WHERE id=1",[],|r|r.get(0)))?;if version!=1{return Err("transport_schema_incompatible".into());}
  let signature:Vec<(String,String)>={let mut s=sql(c.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"))?;let rows=sql(s.query_map([],|r|Ok((r.get(0)?,r.get(1)?))))?;sql(rows.collect())?};
  let reference=sql(Connection::open_in_memory())?;sql(reference.execute_batch(SCHEMA))?;
  let mut s=sql(reference.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"))?;let rows=sql(s.query_map([],|r|Ok((r.get(0)?,r.get(1)?))))?;let expected:Vec<(String,String)>=sql(rows.collect())?;
  if signature!=expected{return Err("transport_schema_incompatible".into());}Ok(())
 }
 fn decode(doc:&str,checksum:&str)->Result<Receipt>{
  if doc.len()>4096||hash(doc)!=checksum{return Err("transport_receipt_corrupt".into());}
  let receipt:Receipt=serde_json::from_str(doc).map_err(|_|"transport_receipt_corrupt")?;
  if !key(&receipt.operation_key)||!key(&receipt.process.package.id)||uuid::Uuid::parse_str(&receipt.process.generation).is_err(){return Err("transport_receipt_corrupt".into());}
  receipt.action.validate()?;
  if !package(&receipt.process.package){return Err("transport_receipt_corrupt".into());}
  if matches!(receipt.action,Action::Sound{..}|Action::Speech{..})!=receipt.playback.is_some(){return Err("transport_receipt_corrupt".into());}
  if receipt.playback.as_ref().is_some_and(|t|uuid::Uuid::parse_str(&t.id).is_err()||uuid::Uuid::parse_str(&t.scope.instance).is_err()||t.scope.generation==0||t.scope.epoch==0||t.scope.session.as_ref().is_some_and(|s|s.is_empty()||s.len()>128)){return Err("transport_receipt_corrupt".into());}
  Ok(receipt)
 }
 fn write(c:&Connection,receipt:&Receipt)->Result<()>{
  let doc=encode(receipt)?;if doc.len()>4096{return Err("transport_receipt_too_large".into());}
  let previous:u64=sql(c.query_row("SELECT length(CAST(receipt AS BLOB)) FROM transport_effects WHERE plugin=?1 AND operation_key=?2",params![receipt.process.package.id,receipt.operation_key],|r|r.get(0)))?;
  if (doc.len() as u64).saturating_sub(previous)>Self::quota_in(c)?.remaining_bytes{return Err("transport_quota_exhausted".into());}
  sql(c.execute("UPDATE transport_effects SET receipt=?3,checksum=?4 WHERE plugin=?1 AND operation_key=?2",params![receipt.process.package.id,receipt.operation_key,doc,hash(&doc)]))?;Ok(())
 }
 fn quota_in(c:&Connection)->Result<Quota>{
  let (n,bytes,unknown,pending):(u64,u64,u64,u64)=sql(c.query_row("SELECT count(*),coalesce(sum(length(CAST(receipt AS BLOB))),0),coalesce(sum(json_extract(receipt,'$.status')='unknown'),0),coalesce(sum(json_extract(receipt,'$.status') IN ('queued','playing')),0) FROM transport_effects",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))))?;
  if n>LIMIT||bytes>BYTE_LIMIT{return Err("transport_quota_invalid".into());}
  Ok(Quota{remaining_operations:LIMIT-n,remaining_bytes:BYTE_LIMIT-bytes,unknown,pending})
 }
 pub fn quota(&self)->Result<Quota>{Self::quota_in(&self.conn)}
 pub fn uncertain(&self)->Result<bool>{sql(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM transport_effects WHERE json_extract(receipt,'$.uncertain')=1 AND json_extract(receipt,'$.status') NOT IN ('completed','cancelled'))",[],|r|r.get(0)))}
 pub fn uncertain_for(&self,plugin:&str)->Result<bool>{sql(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM transport_effects WHERE plugin=?1 AND json_extract(receipt,'$.uncertain')=1 AND json_extract(receipt,'$.status') NOT IN ('completed','cancelled'))",[plugin],|r|r.get(0)))}
 pub fn quota_for(&self,plugin:&str)->Result<Quota>{
  let mut quota=self.quota()?;let (unknown,pending):(u64,u64)=sql(self.conn.query_row("SELECT coalesce(sum(json_extract(receipt,'$.status')='unknown'),0),coalesce(sum(json_extract(receipt,'$.status') IN ('queued','playing')),0) FROM transport_effects WHERE plugin=?1",[plugin],|r|Ok((r.get(0)?,r.get(1)?))))?;
  quota.unknown=unknown;quota.pending=pending;Ok(quota)
 }
 fn decode_process(doc:&str,checksum:&str)->Result<ProcessRecord>{
  if doc.len()>2048||hash(doc)!=checksum{return Err("transport_process_corrupt".into());}
  let record:ProcessRecord=serde_json::from_str(doc).map_err(|_|"transport_process_corrupt")?;
  if record.epoch==0||record.epoch>i64::MAX as u64||record.supervision!="windows-job-list-v1"||!package(&record.process.package)||uuid::Uuid::parse_str(&record.process.generation).is_err(){return Err("transport_process_corrupt".into());}Ok(record)
 }
 fn process_in(c:&Connection,plugin:&str)->Result<Option<ProcessRecord>>{
  let row:Option<(Option<String>,String)>=sql(c.query_row("SELECT CASE WHEN length(CAST(record AS BLOB))<=2048 THEN record ELSE NULL END,checksum FROM transport_processes WHERE plugin=?1",[plugin],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
  row.map(|(doc,checksum)|{
   let record=Self::decode_process(doc.as_deref().ok_or("transport_process_corrupt")?,&checksum)?;
   if record.process.package.id!=plugin{return Err("transport_process_corrupt".into());}Ok(record)
  }).transpose()
 }
 fn write_process(c:&Connection,record:&ProcessRecord)->Result<()>{
  let doc=encode(record)?;let checksum=hash(&doc);Self::decode_process(&doc,&checksum)?;
  sql(c.execute("INSERT INTO transport_processes VALUES(?1,?2,?3) ON CONFLICT(plugin) DO UPDATE SET record=excluded.record,checksum=excluded.checksum",params![record.process.package.id,doc,checksum]))?;Ok(())
 }
 pub fn process(&self,plugin:&str)->Result<Option<ProcessRecord>>{Self::process_in(&self.conn,plugin)}
 fn authorize_in(c:&Connection,process:&ProcessBinding,epoch:Option<u64>)->Result<()>{
  let record=Self::process_in(c,&process.package.id)?.ok_or("process_journal_missing")?;
  if record.phase!=ProcessPhase::Running||record.process!=process.into()||epoch.is_some_and(|e|e!=record.epoch){return Err("process_generation_fenced".into());}Ok(())
 }
 pub fn authorize(&self,process:&ProcessBinding,epoch:u64)->Result<()>{Self::authorize_in(&self.conn,process,Some(epoch))}
 /// Called before the OS spawn, with the exact generation passed to the native
 /// job-list supervisor. Reopen is never treated as an exit proof.
 pub fn reserve_process(&mut self,process:&ProcessBinding)->Result<ProcessRecord>{
  let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
  let previous=Self::process_in(&tx,&process.package.id)?;
  if previous.as_ref().is_some_and(|p|p.phase!=ProcessPhase::Stopped){return Err("previous_process_stop_unproven".into());}
  if previous.as_ref().is_some_and(|p|p.process.generation==process.generation){return Err("process_generation_reused".into());}
  let unresolved:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM transport_effects WHERE plugin=?1 AND json_extract(receipt,'$.status') NOT IN ('completed','cancelled'))",[&process.package.id],|r|r.get(0)))?;
  if unresolved{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let count:u64=sql(tx.query_row("SELECT count(*) FROM transport_processes",[],|r|r.get(0)))?;if previous.is_none()&&count>=128{return Err("transport_process_quota_exhausted".into());}
  let epoch=previous.map_or(Ok(1),|p|p.epoch.checked_add(1).filter(|n|*n<=i64::MAX as u64).ok_or("transport_epoch_exhausted"))?;
  let record=ProcessRecord{process:process.into(),epoch,phase:ProcessPhase::Starting,supervision:"windows-job-list-v1".into()};Self::write_process(&tx,&record)?;sql(tx.commit())?;Ok(record)
 }
 pub fn process_ready(&mut self,process:&ProcessBinding,epoch:u64)->Result<()>{self.process_transition(process,epoch,ProcessPhase::Running)}
 pub fn process_draining(&mut self,process:&ProcessBinding,epoch:u64)->Result<()>{self.process_transition(process,epoch,ProcessPhase::Draining)}
 /// Trusted native caller only, AFTER exact job/handle exit and transport fences.
 /// This function does not infer death from a PID, timeout or missing IPC reply.
 pub fn process_after_native_exit(&mut self,process:&ProcessBinding,epoch:u64)->Result<()>{self.process_transition(process,epoch,ProcessPhase::Stopped)}
 fn process_transition(&mut self,process:&ProcessBinding,epoch:u64,target:ProcessPhase)->Result<()>{
  let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;let mut record=Self::process_in(&tx,&process.package.id)?.ok_or("process_journal_missing")?;
  if record.process!=process.into()||record.epoch!=epoch{return Err("process_generation_fenced".into());}
  if target==ProcessPhase::Running&&record.phase!=ProcessPhase::Starting{return Err("process_not_starting".into());}
  if target==ProcessPhase::Draining&&record.phase==ProcessPhase::Stopped{return Err("process_already_stopped".into());}
  if target==ProcessPhase::Stopped&&!matches!(record.phase,ProcessPhase::Draining|ProcessPhase::Stopped){return Err("process_requires_draining".into());}
  record.phase=target;Self::write_process(&tx,&record)?;sql(tx.commit())
 }
 pub fn lookup(&self,plugin:&str,key:&str)->Result<Option<Receipt>>{
  let row:Option<(String,String,String)>=sql(self.conn.query_row("SELECT identity,CASE WHEN length(CAST(receipt AS BLOB))<=4096 THEN receipt ELSE NULL END,checksum FROM transport_effects WHERE plugin=?1 AND operation_key=?2",params![plugin,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
  row.map(|(stored,doc,checksum)|{
   let receipt=Self::decode(&doc,&checksum)?;
   if receipt.process.package.id!=plugin||receipt.operation_key!=key||identity(&receipt)?!=stored{return Err("transport_receipt_corrupt".into());}Ok(receipt)
  }).transpose()
 }
 pub fn admit(&mut self,process:&ProcessBinding,operation_key:&str,action:Action,playback:Option<Token>)->Result<Admission>{
  if !key(operation_key)||!key(&process.package.id)||uuid::Uuid::parse_str(&process.generation).is_err(){return Err("invalid_transport_identity".into());}
  action.validate()?;
  if matches!(action,Action::Sound{..}|Action::Speech{..})!=playback.is_some(){return Err("playback_identity_required".into());}
  let receipt=Receipt{process:process.into(),operation_key:operation_key.into(),action,playback,status:Status::Unknown,uncertain:false};
  Self::decode(&encode(&receipt)?,&hash(&encode(&receipt)?))?;
  let identity=identity(&receipt)?;
  let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
  Self::authorize_in(&tx,process,receipt.playback.as_ref().map(|t|t.scope.epoch))?;
  let row:Option<(String,String,String)>=sql(tx.query_row("SELECT identity,CASE WHEN length(CAST(receipt AS BLOB))<=4096 THEN receipt ELSE NULL END,checksum FROM transport_effects WHERE plugin=?1 AND operation_key=?2",params![process.package.id,operation_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
  if let Some((stored,doc,checksum))=row{
   if stored!=identity{return Err("idempotency_conflict".into());}
   let receipt=Self::decode(&doc,&checksum)?;
   if receipt.process!=ProcessIdentity::from(process)||receipt.operation_key!=operation_key||self::identity(&receipt)?!=stored{return Err("transport_receipt_corrupt".into());}
   sql(tx.commit())?;return Ok(Admission{fresh:false,receipt});
  }
  let doc=encode(&receipt)?;if doc.len()>4096{return Err("transport_receipt_too_large".into());}
  let quota=Self::quota_in(&tx)?;if quota.remaining_operations==0||doc.len() as u64>quota.remaining_bytes{return Err("transport_quota_exhausted".into());}
  sql(tx.execute("INSERT INTO transport_effects VALUES(?1,?2,?3,?4,?5)",params![process.package.id,operation_key,identity,doc,hash(&doc)]))?;
  sql(tx.commit())?;Ok(Admission{fresh:true,receipt})
 }
 pub fn scene_result(&mut self,process:&ProcessBinding,epoch:u64,key:&str,status:Status)->Result<Receipt>{
  if !matches!(status,Status::Completed|Status::Cancelled|Status::Unknown){return Err("scene_result_invalid".into());}
  let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::authorize_in(&tx,process,Some(epoch))?;
  let (doc,checksum):(String,String)=sql(tx.query_row("SELECT CASE WHEN length(CAST(receipt AS BLOB))<=4096 THEN receipt ELSE NULL END,checksum FROM transport_effects WHERE plugin=?1 AND operation_key=?2",params![process.package.id,key],|r|Ok((r.get(0)?,r.get(1)?))))?;
  let mut receipt=Self::decode(&doc,&checksum)?;
  if receipt.process!=process.into()||receipt.operation_key!=key||!matches!(receipt.action,Action::Scene{..})||receipt.playback.is_some(){return Err("scene_scope_mismatch".into());}
  if !matches!(receipt.status,Status::Completed|Status::Cancelled){if receipt.uncertain&&status==Status::Cancelled{return Err("uncertain_scene_not_cancelled".into());}receipt.status=status;receipt.uncertain=status==Status::Unknown;Self::write(&tx,&receipt)?;}
  sql(tx.commit())?;Ok(receipt)
 }
 pub fn audio_ack(&mut self,plugin:&str,key:&str,token:&Token,status:Status)->Result<Receipt>{
  let tx=sql(self.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
  let (doc,checksum):(String,String)=sql(tx.query_row("SELECT CASE WHEN length(CAST(receipt AS BLOB))<=4096 THEN receipt ELSE NULL END,checksum FROM transport_effects WHERE plugin=?1 AND operation_key=?2",params![plugin,key],|r|Ok((r.get(0)?,r.get(1)?))))?;
  let mut receipt=Self::decode(&doc,&checksum)?;
  if receipt.playback.as_ref()!=Some(token)||receipt.process.package.id!=plugin||receipt.operation_key!=key{return Err("playback_scope_mismatch".into());}
  if receipt.status!=status||(status==Status::Unknown&&!receipt.uncertain){
   if matches!(receipt.status,Status::Completed|Status::Cancelled)||(receipt.status==Status::Playing&&status==Status::Queued)||(receipt.uncertain&&matches!(status,Status::Queued|Status::Playing)){return Err("playback_terminal_or_regression".into());}
   if status==Status::Unknown{receipt.uncertain=true;}
   receipt.status=status;Self::write(&tx,&receipt)?;
  }
  sql(tx.commit())?;Ok(receipt)
 }
}

#[cfg(test)]
mod tests{
 use super::*;
 fn process()->ProcessBinding{ProcessBinding{generation:uuid::Uuid::new_v4().to_string(),package:companion_plugin_protocol::PackageBinding{id:"example".into(),version:"1.0.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)}}}
 fn action()->Action{Action::Sound{asset_file:"sound.wav".into(),volume:70}}
 fn activate(store:&mut Store,process:&ProcessBinding)->u64{let epoch=store.reserve_process(process).unwrap().epoch;store.process_ready(process,epoch).unwrap();epoch}
 #[test]
 fn emit_is_not_completion_and_reopen_keeps_unknown_and_duplicate_identity(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");let mut store=Store::open(&path).unwrap();let process=process();
  let epoch=activate(&mut store,&process);
  let registry=companion_plugin_protocol::playback::PlaybackRegistry::default();let token=registry.admit(Some(epoch),None).unwrap();
  assert!(store.admit(&process,"sound:1",action(),Some(token.clone())).unwrap().fresh);
  assert_eq!(store.quota().unwrap().unknown,1);
  assert!(!store.admit(&process,"sound:1",action(),Some(token.clone())).unwrap().fresh);
  assert_eq!(store.admit(&process,"sound:1",Action::Sound{asset_file:"different.wav".into(),volume:70},Some(token.clone())).unwrap_err(),"idempotency_conflict");
  store.audio_ack("example","sound:1",&token,Status::Playing).unwrap();drop(store);
  let mut store=Store::open(&path).unwrap();assert_eq!(store.lookup("example","sound:1").unwrap().unwrap().status,Status::Unknown);
  assert_eq!(store.admit(&process,"sound:1",action(),Some(token.clone())).unwrap_err(),"process_generation_fenced");
  let mut forged=token.clone();forged.scope.epoch+=1;assert!(store.audio_ack("example","sound:1",&forged,Status::Completed).is_err());
  store.audio_ack("example","sound:1",&token,Status::Cancelled).unwrap();assert_eq!(store.quota().unwrap().unknown,0);
  assert_eq!(store.lookup("example","sound:1").unwrap().unwrap().status,Status::Cancelled);
  assert!(store.audio_ack("example","sound:1",&token,Status::Playing).is_err());
 }
 #[test]
 fn no_parallel_writer_corrupt_store_or_unbounded_or_arbitrary_asset_is_admitted(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");let mut store=Store::open(&path).unwrap();assert!(matches!(Store::open(&path),Err(e) if e=="second_transport_coordinator_denied"));
  let registry=companion_plugin_protocol::playback::PlaybackRegistry::default();let token=registry.admit(Some(1),None).unwrap();
  assert!(store.admit(&process(),"sound:1",Action::Sound{asset_file:"../secret.wav".into(),volume:70},Some(token)).is_err());assert_eq!(store.quota().unwrap().remaining_operations,LIMIT);
  drop(store);let c=Connection::open(&path).unwrap();c.execute("UPDATE transport_meta SET version=999",[]).unwrap();drop(c);assert!(matches!(Store::open(&path),Err(e) if e=="transport_schema_incompatible"));
  let corrupt=root.path().join("corrupt.sqlite3");std::fs::write(&corrupt,b"broken").unwrap();assert!(Store::open(&corrupt).is_err());assert_eq!(std::fs::read(corrupt).unwrap(),b"broken");
 }
 #[test]
 fn confirmed_completion_is_durable_and_one_playback_cannot_represent_two_operations(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");let mut store=Store::open(&path).unwrap();let process=process();
  activate(&mut store,&process);
  let registry=companion_plugin_protocol::playback::PlaybackRegistry::default();let token=registry.admit(Some(1),Some("opaque-context")).unwrap();
  store.admit(&process,"sound:1",action(),Some(token.clone())).unwrap();
  assert!(store.admit(&process,"sound:2",action(),Some(token.clone())).is_err());assert_eq!(store.quota().unwrap().remaining_operations,LIMIT-1);
  store.audio_ack("example","sound:1",&token,Status::Queued).unwrap();store.audio_ack("example","sound:1",&token,Status::Playing).unwrap();
  assert!(store.audio_ack("example","sound:1",&token,Status::Queued).is_err());
  store.audio_ack("example","sound:1",&token,Status::Completed).unwrap();drop(store);
  let store=Store::open(&path).unwrap();assert_eq!(store.lookup("example","sound:1").unwrap().unwrap().status,Status::Completed);
 }
 #[test]
 fn frontend_unknown_cannot_regress_to_playing_and_corrupt_receipts_fail_closed(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");let mut store=Store::open(&path).unwrap();let process=process();
  activate(&mut store,&process);
  let token=companion_plugin_protocol::playback::PlaybackRegistry::default().admit(Some(1),None).unwrap();store.admit(&process,"sound:1",action(),Some(token.clone())).unwrap();
  store.audio_ack("example","sound:1",&token,Status::Unknown).unwrap();assert!(store.audio_ack("example","sound:1",&token,Status::Playing).is_err());
  let receipt=store.lookup("example","sound:1").unwrap().unwrap();assert!(receipt.uncertain);assert_eq!(receipt.status,Status::Unknown);
  store.conn.execute("UPDATE transport_effects SET receipt='{}'",[]).unwrap();drop(store);
  assert!(Store::open(&path).is_err());
 }
 #[test]
 fn journal_reopen_never_proves_exit_and_replacement_requires_draining_new_generation_and_epoch(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");let mut store=Store::open(&path).unwrap();let first=process();
  let reserved=store.reserve_process(&first).unwrap();assert_eq!(reserved.epoch,1);assert_eq!(reserved.phase,ProcessPhase::Starting);
  assert!(store.authorize(&first,1).is_err());assert!(store.process_after_native_exit(&first,1).is_err());drop(store);
  let mut store=Store::open(&path).unwrap();let record=store.process("example").unwrap().unwrap();assert_eq!(record.phase,ProcessPhase::Draining);assert_eq!(record.epoch,1);
  let second=process();assert_eq!(store.reserve_process(&second).unwrap_err(),"previous_process_stop_unproven");assert!(store.process_ready(&first,1).is_err());
  // State-machine test: only the native caller may make this transition after
  // real job/handle exit and audio/OBS fences. This test supplies no OS proof.
  store.process_after_native_exit(&first,1).unwrap();assert_eq!(store.reserve_process(&first).unwrap_err(),"process_generation_reused");
  let next=store.reserve_process(&second).unwrap();assert_eq!(next.epoch,2);store.process_ready(&second,2).unwrap();assert!(store.authorize(&second,2).is_ok());
  assert!(store.authorize(&first,1).is_err());assert!(store.authorize(&second,1).is_err());assert!(store.process_draining(&first,1).is_err());
  store.process_draining(&second,2).unwrap();assert!(store.authorize(&second,2).is_err());
  store.process_after_native_exit(&second,2).unwrap();drop(store);
  let mut store=Store::open(&path).unwrap();assert_eq!(store.process("example").unwrap().unwrap().phase,ProcessPhase::Stopped);
  assert_eq!(store.reserve_process(&process()).unwrap().epoch,3);
 }
 #[test]
 fn uncertain_effect_prevents_new_process_even_when_old_process_exit_is_recorded(){
  let root=tempfile::tempdir().unwrap();let mut store=Store::open(&root.path().join("transport.sqlite3")).unwrap();let first=process();let epoch=activate(&mut store,&first);
  let token=companion_plugin_protocol::playback::PlaybackRegistry::default().admit(Some(epoch),None).unwrap();store.admit(&first,"sound:1",action(),Some(token.clone())).unwrap();
  store.process_draining(&first,epoch).unwrap();store.process_after_native_exit(&first,epoch).unwrap();
  assert_eq!(store.reserve_process(&process()).unwrap_err(),"unknown_effects_require_explicit_reconciliation");assert_eq!(store.quota().unwrap().unknown,1);
  // An authenticated terminal playback ACK may settle an admitted operation
  // during Draining. It never authorizes another emission.
  store.audio_ack("example","sound:1",&token,Status::Cancelled).unwrap();
  assert_eq!(store.reserve_process(&process()).unwrap().epoch,2);
 }
 #[test]
 fn full_ledger_refuses_new_keys_but_preserves_all_existing_receipts_without_cleanup(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");let mut store=Store::open(&path).unwrap();let process=process();activate(&mut store,&process);
  // Seed a complete historical ledger in one fixture transaction, not 10,000
  // fsyncs. The production quota and admission paths below are unchanged.
  let action=Action::Scene{name:"Existing scene".into()};
  let mut receipt=Receipt{process:(&process).into(),operation_key:String::new(),action:action.clone(),playback:None,status:Status::Completed,uncertain:false};
  let identity=identity(&receipt).unwrap();let tx=store.conn.transaction().unwrap();
  for n in 0..LIMIT{receipt.operation_key=format!("scene:{n}");let doc=encode(&receipt).unwrap();tx.execute("INSERT INTO transport_effects VALUES(?1,?2,?3,?4,?5)",params![process.package.id,receipt.operation_key,identity,doc,hash(&doc)]).unwrap();}tx.commit().unwrap();
  assert_eq!(store.quota().unwrap().remaining_operations,0);assert_eq!(store.quota().unwrap().unknown,0);
  assert_eq!(store.admit(&process,"scene:new",action.clone(),None).unwrap_err(),"transport_quota_exhausted");
  let duplicate=store.admit(&process,"scene:0",action,None).unwrap();assert!(!duplicate.fresh);assert_eq!(duplicate.receipt.status,Status::Completed);drop(store);
  let store=Store::open(&path).unwrap();assert_eq!(store.quota().unwrap().remaining_operations,0);assert!(store.lookup("example","scene:9999").unwrap().is_some());
 }
}
