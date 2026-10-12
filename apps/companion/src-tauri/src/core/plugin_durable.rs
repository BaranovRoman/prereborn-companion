//! Separate plugin infrastructure DB. No GSI/bootstrap/effect dispatcher/history migrations.
use std::{collections::BTreeMap,path::Path,time::Duration};
use rusqlite::{Connection,Transaction,TransactionBehavior,OpenFlags};
use serde::{Serialize,Deserialize};
use sha2::{Digest,Sha256};
fn checksum(json:&str)->String {format!("{:x}",Sha256::digest(json.as_bytes()))}
use companion_dota_domain::{ownership::{Ownership,Phase,Lease,Owner},effects::{Ledger,Request,Capability,Status,Ack,Admission}};
type Result<T> = std::result::Result<T,String>;
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {phase:Phase,ledger:Ledger,acks:BTreeMap<String,Ack>}
impl Record {
 fn validate(&self)->Result<()> {
  Ownership::restore(self.phase).map_err(str::to_string)?;self.ledger.validate_stored().map_err(str::to_string)?;
  if self.acks.len()!=self.ledger.len() {return Err("corrupt_ack_ledger".into());}
  let epoch=match self.phase {Phase::Active(l)=>l.epoch,Phase::Draining{old,..}=>old.epoch,Phase::Vacant{epoch}=>epoch};
  for (key,ack) in &self.acks {
   if key!=&ack.idempotency_key || self.ledger.status(key)!=Some(ack.status) || ack.lease.epoch==0 || ack.lease.epoch>epoch || ack.correlation_id.is_empty() || ack.correlation_id.len()>128 {return Err("corrupt_ack_ledger".into());}
  } Ok(())
 }
}
pub struct DurableStore {conn:Connection}
impl DurableStore {
 pub fn open(path:&Path)->Result<Self> {
  let exists=path.exists();
  if !exists {std::fs::create_dir_all(path.parent().ok_or("invalid_store_path")?).map_err(|_|"store_directory_failed")?;}
  let flags=OpenFlags::SQLITE_OPEN_READ_WRITE | if exists {OpenFlags::empty()} else {OpenFlags::SQLITE_OPEN_CREATE};
  let mut conn=Connection::open_with_flags(path,flags).map_err(|_|"store_open_failed")?;
  conn.busy_timeout(Duration::from_millis(100)).map_err(|_|"store_busy_timeout")?;
  let integrity:String=conn.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(|_|"store_corrupt")?;
  if integrity!="ok" {return Err("store_corrupt".into());}
  // DELETE journal + retained exclusive connection lock: prevent simultaneous coordinators.
  // FULL ensures SQLite syncs commits; no hand-written file replacement or reset fallback.
  conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE;").map_err(|_|"store_locked")?;
  let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|"store_locked")?;
  if !exists {
   tx.execute_batch("CREATE TABLE plugin_control (id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64)); PRAGMA user_version=1;").map_err(|_|"store_schema_failed")?;
   let record=Record {phase:Ownership::default().phase(),ledger:Ledger::default(),acks:Default::default()};
   let json=serde_json::to_string(&record).map_err(|_|"store_encode_failed")?;
   tx.execute("INSERT INTO plugin_control VALUES(1,?1,?2)",rusqlite::params![json,checksum(&json)]).map_err(|_|"store_write_failed")?;
  } else {
   let version:i64=tx.query_row("PRAGMA user_version",[],|r|r.get(0)).map_err(|_|"store_corrupt")?;
   if version!=1 {return Err("store_version_invalid".into());}
   let mut record=Self::load(&tx)?;
   // Reopening is not proof of death/fencing. Keep the same epoch inactive until core proof.
   let mut owners=Ownership::restore(record.phase).map_err(str::to_string)?;
   owners.uncertain_restart();record.phase=owners.phase();
   record.ledger.uncertain_after_restart();
   for ack in record.acks.values_mut() {if ack.status==Status::Accepted {ack.status=Status::Unknown;}}
   Self::save(&tx,&record)?;
  }
  tx.commit().map_err(|_|"store_commit_failed")?;
  Ok(Self {conn})
 }
 fn load(tx:&Transaction<'_>)->Result<Record> {
  let size:i64=tx.query_row("SELECT length(CAST(record AS BLOB)) FROM plugin_control WHERE id=1",[],|r|r.get(0)).map_err(|_|"store_corrupt")?;
  if size>1024*1024 {return Err("store_record_too_large".into());}
  let json:String=tx.query_row("SELECT record FROM plugin_control WHERE id=1",[],|r|r.get(0)).map_err(|_|"store_corrupt")?;
  let expected:String=tx.query_row("SELECT checksum FROM plugin_control WHERE id=1",[],|r|r.get(0)).map_err(|_|"store_corrupt")?;
  if expected!=checksum(&json) {return Err("store_checksum_invalid".into());}
  let record:Record=serde_json::from_str(&json).map_err(|_|"store_corrupt")?;record.validate()?;Ok(record)
 }
 fn save(tx:&Transaction<'_>,record:&Record)->Result<()> {
  record.validate()?;
  let json=serde_json::to_string(record).map_err(|_|"store_encode_failed")?;
  if json.len()>1024*1024 {return Err("store_record_too_large".into());}
  tx.execute("UPDATE plugin_control SET record=?1,checksum=?2 WHERE id=1",rusqlite::params![json,checksum(&json)]).map_err(|_|"store_write_failed")?;Ok(())
 }
 fn transaction<T>(&mut self, f:impl FnOnce(&Transaction<'_>,&mut Record)->Result<T>)->Result<T> {
  let tx=self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|"store_locked")?;
  let mut record=Self::load(&tx)?;let result=f(&tx,&mut record)?;Self::save(&tx,&record)?;tx.commit().map_err(|_|"store_commit_failed")?;Ok(result)
 }
 pub fn phase(&mut self)->Result<Phase> {self.transaction(|_,r|Ok(r.phase))}
 pub fn begin(&mut self,lease:Lease,target:Owner)->Result<()> {self.transition(|o|o.begin(lease,target))}
 pub fn confirm_fenced(&mut self,lease:Lease)->Result<Lease> {self.transition(|o|o.confirm_fenced(lease))}
 pub fn crash_fenced(&mut self,lease:Lease)->Result<()> {self.transition(|o|o.crash_fenced(lease))}
 pub fn recover(&mut self,owner:Owner)->Result<Lease> {self.transition(|o|o.recover(owner))}
 fn transition<T>(&mut self,f:impl FnOnce(&mut Ownership)->std::result::Result<T,&'static str>)->Result<T> {
  self.transaction(|_,r|{let mut owners=Ownership::restore(r.phase).map_err(str::to_string)?;let result=f(&mut owners).map_err(str::to_string)?;r.phase=owners.phase();Ok(result)})
 }
 pub fn admit(&mut self,grants:&[Capability],req:&Request,now:u64)->Result<Admission> {self.admit_with(grants,req,now,|_|Ok(()))}
 // Trusted core-only hook. Future local match/outbox writes must use THIS transaction/DB.
 // Called only on fresh admission; never for duplicates. No remote side effects here.
 pub fn admit_with(&mut self,grants:&[Capability],req:&Request,now:u64,local_write:impl FnOnce(&Transaction<'_>)->Result<()>)->Result<Admission> {
  self.transaction(|tx,r|{
   let owners=Ownership::restore(r.phase).map_err(str::to_string)?;
   let admission=r.ledger.admit(&owners,grants,req,now).map_err(str::to_string)?;
   if !admission.duplicate {
    local_write(tx)?;
    r.acks.insert(req.idempotency_key.clone(),Ack {correlation_id:req.correlation_id.clone(),idempotency_key:req.idempotency_key.clone(),lease:req.lease,status:Status::Accepted});
   }
   Ok(admission)
  })
 }
 pub fn acknowledge(&mut self,req:&Request,status:Status)->Result<Ack> {
  self.transaction(|_,r|{let owners=Ownership::restore(r.phase).map_err(str::to_string)?;let ack=r.ledger.acknowledge(&owners,req,status).map_err(str::to_string)?;r.acks.insert(req.idempotency_key.clone(),ack.clone());Ok(ack)})
 }
 // Isolated prototype hooks: no IPC dispatch; caller must own this same transaction.
 #[cfg(test)]
 pub(super) fn inspect<T>(&mut self,f:impl FnOnce(&Transaction<'_>)->Result<T>)->Result<T> {self.transaction(|tx,_|f(tx))}
 #[cfg(test)]
 pub(super) fn settle_local(&mut self,grants:&[Capability],req:&Request,now:u64,write:impl FnOnce(&Transaction<'_>)->Result<Status>)->Result<Admission> {
  self.transaction(|tx,r| {
   let owners=Ownership::restore(r.phase).map_err(str::to_string)?;
   let mut admission=r.ledger.admit(&owners,grants,req,now).map_err(str::to_string)?;
   if !admission.duplicate {
    let status=write(tx)?;
    if !matches!(status,Status::Completed|Status::Rejected) {return Err("invalid_local_settlement".into());}
    let ack=r.ledger.acknowledge(&owners,req,status).map_err(str::to_string)?;
    r.acks.insert(req.idempotency_key.clone(),ack);admission.status=status;
   } Ok(admission)
  })
 }
 pub fn last_ack(&mut self,key:&str)->Result<Option<Ack>> {self.transaction(|_,r|Ok(r.acks.get(key).cloned()))}
}
#[cfg(test)] mod tests {
 use super::*; use companion_dota_domain::effects::Effect;
 fn lease(s:&mut DurableStore)->Lease {let Phase::Active(l)=s.phase().unwrap() else {panic!("not active")};l}
 fn req(lease:Lease)->Request {Request{api:1,lease,correlation_id:"corr".into(),idempotency_key:"operation".into(),deadline_ms:1000,effect:Effect::Sound{event_id:"item_tango".into()}}}
 #[test] fn reopen_draining_stale_epoch_and_exclusive_connection() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("infra.sqlite3");let mut store=DurableStore::open(&path).unwrap();let old=lease(&mut store);
  assert!(DurableStore::open(&path).is_err());store.begin(old,Owner::External).unwrap();drop(store);
  let mut store=DurableStore::open(&path).unwrap();assert!(matches!(store.phase().unwrap(),Phase::Draining{old:l,..} if l==old));
  assert!(store.admit(&[Capability::Sound],&req(old),0).is_err());assert!(store.recover(Owner::External).is_err());
  let new=store.confirm_fenced(old).unwrap();assert_eq!(new.epoch,2);drop(store);
  let mut store=DurableStore::open(&path).unwrap();assert!(store.admit(&[Capability::Sound],&req(new),0).is_err());
  let recovered=store.confirm_fenced(new).unwrap();assert_eq!(recovered.epoch,3);assert!(store.begin(old,Owner::BuiltIn).is_err());
 }
 #[test] fn duplicate_payload_conflict_unknown_and_ack_survive_restart() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("infra.sqlite3");let mut s=DurableStore::open(&path).unwrap();let mut r=req(lease(&mut s));
  assert!(!s.admit(&[Capability::Sound],&r,0).unwrap().duplicate);assert!(s.admit(&[Capability::Sound],&r,0).unwrap().duplicate);
  r.effect=Effect::Sound{event_id:"other".into()};assert_eq!(s.admit(&[Capability::Sound],&r,0).unwrap_err(),"idempotency_conflict");r.effect=Effect::Sound{event_id:"item_tango".into()};drop(s);
  let mut s=DurableStore::open(&path).unwrap();assert_eq!(s.last_ack("operation").unwrap().unwrap().status,Status::Unknown);
  r.lease=s.confirm_fenced(r.lease).unwrap();let admitted=s.admit(&[Capability::Sound],&r,1001).unwrap();assert!(admitted.duplicate);assert_eq!(admitted.status,Status::Unknown);
  s.acknowledge(&r,Status::Completed).unwrap();drop(s);
  let mut s=DurableStore::open(&path).unwrap();assert_eq!(s.last_ack("operation").unwrap().unwrap().status,Status::Completed);
 }
 #[test] fn local_write_and_admission_are_atomic_and_duplicates_skip_hook() {
  let dir=tempfile::tempdir().unwrap();let mut s=DurableStore::open(&dir.path().join("infra.sqlite3")).unwrap();let r=req(lease(&mut s));
  let failed=s.admit_with(&[Capability::Sound],&r,0,|tx|{tx.execute_batch("CREATE TABLE future_outbox(id INTEGER);").unwrap();Err("injected_crash".into())});assert!(failed.is_err());assert!(s.last_ack("operation").unwrap().is_none());
  assert_eq!(s.conn.query_row("SELECT count(*) FROM sqlite_master WHERE name='future_outbox'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
  s.admit_with(&[Capability::Sound],&r,0,|tx|{tx.execute_batch("CREATE TABLE future_outbox(id INTEGER); INSERT INTO future_outbox VALUES(1);").map_err(|e|e.to_string())}).unwrap();
  s.admit_with(&[Capability::Sound],&r,0,|_|panic!("duplicate executed hook")).unwrap();
  assert_eq!(s.conn.query_row("SELECT count(*) FROM future_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),1);
 }
 #[test] fn corrupt_physical_or_logical_store_fails_without_recreation() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("infra.sqlite3");std::fs::write(&path,b"not a database").unwrap();assert!(DurableStore::open(&path).is_err());assert_eq!(std::fs::read(&path).unwrap(),b"not a database");
  let path=dir.path().join("logical.sqlite3");drop(DurableStore::open(&path).unwrap());let c=Connection::open(&path).unwrap();c.execute("UPDATE plugin_control SET record='{}'",[]).unwrap();drop(c);assert!(DurableStore::open(&path).is_err());
 }
 #[test] fn confirmed_crash_stays_vacant_until_explicit_recovery() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("infra.sqlite3");let mut s=DurableStore::open(&path).unwrap();let l=lease(&mut s);s.crash_fenced(l).unwrap();drop(s);
  let mut s=DurableStore::open(&path).unwrap();assert!(matches!(s.phase().unwrap(),Phase::Vacant{epoch:1}));assert_eq!(s.recover(Owner::BuiltIn).unwrap().epoch,2);
 }
}

#[cfg(test)] mod crash_tests {
 use super::*;use companion_dota_domain::effects::Effect;
 #[test]
 #[ignore="child-process abrupt-exit fixture; invoked only by recovery test"]
 fn abrupt_exit_fixture() {
  let path=std::env::var_os("PREREBORN_DURABLE_CRASH_FIXTURE").expect("fixture path");let mut s=DurableStore::open(Path::new(&path)).unwrap();
  let Phase::Active(lease)=s.phase().unwrap() else {panic!()};
  let req=Request{api:1,lease,correlation_id:"crash".into(),idempotency_key:"crash-operation".into(),deadline_ms:1000,effect:Effect::Sound{event_id:"item_tango".into()}};
  s.admit(&[Capability::Sound],&req,0).unwrap();s.begin(lease,Owner::External).unwrap();
  // Crash with uncommitted corruption: the last committed phase/ledger must survive.
  s.conn.execute_batch("BEGIN IMMEDIATE; UPDATE plugin_control SET record='{}';").unwrap();
  std::process::exit(73);
 }
 #[test] fn abrupt_process_exit_recovers_committed_draining_and_unknown_without_advancing_owner() {
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("infra.sqlite3");
  let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","core::plugin_durable::crash_tests::abrupt_exit_fixture","--ignored"]).env("PREREBORN_DURABLE_CRASH_FIXTURE",&path).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap();assert_eq!(status.code(),Some(73));
  let mut s=DurableStore::open(&path).unwrap();assert!(matches!(s.phase().unwrap(),Phase::Draining{old:Lease{epoch:1,..},target:Owner::External}));
  assert_eq!(s.last_ack("crash-operation").unwrap().unwrap().status,Status::Unknown);
  assert!(s.recover(Owner::External).is_err());
 }
}
