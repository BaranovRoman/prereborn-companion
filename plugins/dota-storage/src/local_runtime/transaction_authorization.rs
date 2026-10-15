//! Same-DB durable ownership. No bootstrap/GSI switching and no package activation.
use rusqlite::{Connection,TransactionBehavior,params};
use serde::{Serialize,Deserialize};
use companion_dota_domain::{ownership::{Ownership,Phase,Lease,Owner},match_execution::{PackageBinding,Request}};
use super::host_execution::{Result,sql,encode,hash,Ticket};
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {pub phase:Phase,pub session:Option<String>,pub package:Option<PackageBinding>,#[serde(default,skip_serializing_if="Option::is_none")] process:Option<ProcessRecord>}
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessRecord {generation:String,pid:Option<u32>,stopped:bool,package:PackageBinding,#[serde(default,skip_serializing_if="Option::is_none")] supervision:Option<String>}

pub fn install(c:&Connection)->Result<()> {
    sql(c.execute_batch("CREATE TABLE pc_tx_owner(id INTEGER PRIMARY KEY CHECK(id=1),doc TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64));"))?;
    save(c,&Record{phase:Ownership::default().phase(),session:None,package:None,process:None})
}
pub fn load(c:&Connection)->Result<Record> {
    let (doc,checksum):(Option<String>,String)=sql(c.query_row("SELECT CASE WHEN length(CAST(doc AS BLOB))<=2048 THEN doc ELSE NULL END,checksum FROM pc_tx_owner WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let doc=doc.ok_or("ownership_corrupt")?;if hash(&doc)!=checksum{return Err("ownership_corrupt".into());}
    let record:Record=serde_json::from_str(&doc).map_err(|_|"ownership_corrupt")?;
    if record.process.as_ref().is_some_and(|p|uuid::Uuid::parse_str(&p.generation).is_err()||p.pid==Some(0)||p.supervision.as_deref().is_some_and(|v|v!="windows-job-list-v1")){return Err("process_identity_corrupt".into());}Ownership::restore(record.phase).map_err(str::to_string)?;
    if record.session.as_ref().is_some_and(|s|s.is_empty()||s.len()>128)||record.package.as_ref().into_iter().chain(record.process.as_ref().map(|p|&p.package)).any(|p|p.id!="dota2"||p.version.is_empty()||p.version.len()>240||[&p.executable_hash,&p.manifest_hash].iter().any(|h|h.len()!=64||!h.bytes().all(|b|b.is_ascii_hexdigit()))){return Err("ownership_corrupt".into());}Ok(record)
}
fn save(c:&Connection,r:&Record)->Result<()> {
    Ownership::restore(r.phase).map_err(str::to_string)?;let doc=encode(r)?;if doc.len()>2048{return Err("ownership_too_large".into());}
    sql(c.execute("INSERT INTO pc_tx_owner VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc,checksum=excluded.checksum",params![doc,hash(&doc)]))?;Ok(())
}
fn change<T>(c:&mut Connection,f:impl FnOnce(&Connection,&mut Record,&mut Ownership)->Result<T>)->Result<T> {
    let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;let mut record=load(&tx)?;let mut ownership=Ownership::restore(record.phase).map_err(str::to_string)?;
    let result=f(&tx,&mut record,&mut ownership)?;record.phase=ownership.phase();save(&tx,&record)?;sql(tx.commit())?;Ok(result)
}
pub fn uncertain_restart(c:&mut Connection)->Result<()> {change(c,|_,_,o|{o.uncertain_restart();Ok(())})}
pub fn phase(c:&Connection)->Result<Phase>{Ok(load(c)?.phase)}
pub fn session_bound(c:&Connection)->Result<bool>{Ok(load(c)?.session.is_some())}
// Called only by the explicit core recovery action AFTER process/audio/OBS fencing.
// Keeps every receipt and advances the epoch; never restores a history backup.
pub fn recover_builtin_after_fence(c:&mut Connection)->Result<Lease> {
 change(c,|tx,r,o|{
  if super::host_execution::live_effects::quota(tx)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let Phase::Draining{old,..}=r.phase else{return Err("recovery_requires_draining".into());};
  if (old.owner==Owner::External&&r.process.is_none())||r.process.as_ref().is_some_and(|p|!p.stopped){return Err("previous_process_stop_unproven".into());}
  *o=Ownership::restore(Phase::Draining{old,target:Owner::BuiltIn}).map_err(str::to_string)?;
  let lease=o.confirm_fenced(old).map_err(str::to_string)?;r.package=None;r.session=None;Ok(lease)
 })
}
pub fn begin(c:&mut Connection,lease:Lease,target:Owner,session:&str,package:Option<PackageBinding>)->Result<()> {
    if session.is_empty()||session.len()>128{return Err("session_mismatch".into());}
    if target==Owner::External&&package.is_none(){return Err("package_binding_required".into());}
    change(c,|_tx,r,o|{o.begin(lease,target).map_err(str::to_string)?;r.session=Some(session.into());r.package=package;Ok(())})
}
pub fn cold_eligible(c:&Connection)->Result<()> {
 if sql(super::store::find_active_match_anywhere(c))?.is_some()||sql(super::store::find_open_session(c))?.is_some(){return Err("cold_state_changed".into());}Ok(())
}
pub fn begin_cold(c:&mut Connection,lease:Lease,target:Owner,package:Option<PackageBinding>)->Result<()> {
 if target==Owner::External&&package.is_none(){return Err("package_binding_required".into());}
 change(c,|tx,r,o|{
  cold_eligible(tx)?;
  // Fallback may enter Draining with Unknown, but the existing confirmation
  // path still refuses BuiltIn takeover until explicit reconciliation.
  if target==Owner::External&&super::host_execution::live_effects::quota(tx)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}
  if target==Owner::BuiltIn&&r.session.is_some(){return Err("execution_scope_mismatch".into());}
  o.begin(lease,target).map_err(str::to_string)?;r.session=None;r.package=package;Ok(())
 })
}
pub fn authorize_unbound(c:&Connection,lease:Lease,package:Option<&PackageBinding>)->Result<()> {
 if runtime_session(c,lease,package)?.is_some(){return Err("execution_scope_mismatch".into());}Ok(())
}
pub fn runtime_session(c:&Connection,lease:Lease,package:Option<&PackageBinding>)->Result<Option<String>> {
 let r=load(c)?;Ownership::restore(r.phase).map_err(str::to_string)?.authorize(lease).map_err(|_|"ownership_fenced")?;
 if lease.owner!=Owner::External||package.is_none()||r.package.as_ref()!=package||r.process.as_ref().is_none_or(|p|p.stopped||p.package!=*package.unwrap()){return Err("execution_scope_mismatch".into());}Ok(r.session)
}
pub fn bind_cold_session_in(c:&Connection,lease:Lease,package:Option<&PackageBinding>,session:&str)->Result<()> {
 authorize_unbound(c,lease,package)?;
 if sql(super::store::find_session(c,session))?.is_none(){return Err("session_mismatch".into());}
 let mut r=load(c)?;r.session=Some(session.into());save(c,&r)
}
pub fn confirm_fenced(c:&mut Connection,old:Lease)->Result<Lease> {change(c,|_,r,o|{if (old.owner==Owner::External&&r.process.as_ref().is_none_or(|p|!p.stopped))||(matches!(r.phase,Phase::Draining{target:Owner::BuiltIn,..})&&r.process.as_ref().is_some_and(|p|!p.stopped)){return Err("previous_process_stop_unproven".into());}o.confirm_fenced(old).map_err(str::to_string)})}
pub fn crash_fenced(c:&mut Connection,old:Lease)->Result<()> {change(c,|_,r,o|{if (old.owner==Owner::External&&r.process.is_none())||r.process.as_ref().is_some_and(|p|!p.stopped){return Err("previous_process_stop_unproven".into());}o.crash_fenced(old).map_err(str::to_string)})}
pub fn recover(c:&mut Connection,owner:Owner)->Result<Lease> {change(c,|_,r,o|{if r.process.as_ref().is_some_and(|p|!p.stopped){return Err("previous_process_stop_unproven".into());}if owner==Owner::External&&r.package.is_none(){return Err("package_binding_required".into());}let lease=o.recover(owner).map_err(str::to_string)?;if owner==Owner::BuiltIn{r.package=None;}Ok(lease)})}
pub fn bind_builtin_session(c:&mut Connection,lease:Lease,session:&str)->Result<()> {change(c,|tx,r,o|{o.authorize(lease).map_err(str::to_string)?;if lease.owner!=Owner::BuiltIn||super::store::find_session(tx,session).map_err(|_|"storage_unavailable")?.is_none(){return Err("session_mismatch".into());}r.session=Some(session.into());r.package=None;Ok(())})}
pub fn rollback_builtin_in(c:&Connection)->Result<Lease> {
    let mut r=load(c)?;if r.process.as_ref().is_some_and(|p|!p.stopped){return Err("previous_process_stop_unproven".into());}let mut o=Ownership::restore(r.phase).map_err(str::to_string)?;
    match r.phase {Phase::Active(l) if l.owner==Owner::External=>o.begin(l,Owner::BuiltIn).map_err(str::to_string)?,Phase::Active(_)=>o.uncertain_restart(),Phase::Draining{target:Owner::BuiltIn,..}=>(),_=>return Err("rollback_requires_builtin_fence".into())}
    let Phase::Draining{old,..}=o.phase()else{return Err("rollback_requires_fence".into());};let next=o.confirm_fenced(old).map_err(str::to_string)?;
    r.phase=o.phase();r.package=None;save(c,&r)?;Ok(next)
}
pub fn authorize_scope(c:&Connection,lease:Lease,session:&str,package:Option<&PackageBinding>)->Result<()> {
    let record=load(c)?;Ownership::restore(record.phase).map_err(str::to_string)?.authorize(lease).map_err(|_|"ownership_fenced")?;
    if record.session.as_deref()!=Some(session)||record.package.as_ref()!=package{return Err("execution_scope_mismatch".into());}Ok(())
}
pub fn authorize(c:&Connection,lease:Lease,session:&str,package:Option<&PackageBinding>,request:&Request)->Result<()> {
    authorize_scope(c,lease,session,package)?;
    let (doc,checksum):(Option<String>,String)=sql(c.query_row("SELECT CASE WHEN length(CAST(doc AS BLOB))<=16384 THEN doc ELSE NULL END,checksum FROM pc_tx_ticket WHERE id=?1",[&request.ticket],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let doc=doc.ok_or("context_corrupt")?;if hash(&doc)!=checksum||request.binding!=checksum{return Err("context_corrupt".into());}
    let ticket:Ticket=serde_json::from_str(&doc).map_err(|_|"context_corrupt")?;
    if ticket.context.session.local_id!=session{return Err("session_mismatch".into());}Ok(())
}

// The journal is written before spawn. PID is diagnostic, NEVER an exit proof.
// Original Runtime handles or explicit generation-job recovery can confirm stop.
// The supervision marker is committed BEFORE atomic Windows job-list spawn.
pub fn process_starting(c:&mut Connection,lease:Lease,package:&PackageBinding,generation:&str)->Result<()> {
 if uuid::Uuid::parse_str(generation).is_err(){return Err("invalid_process_generation".into());}
 change(c,|_,r,_|{
  if !matches!(r.phase,Phase::Draining{old,target:Owner::External} if old.epoch.checked_add(1)==Some(lease.epoch))||r.package.as_ref()!=Some(package)||r.process.as_ref().is_some_and(|p|!p.stopped){return Err("process_start_fenced".into());}
  r.process=Some(ProcessRecord{generation:generation.into(),pid:None,stopped:false,package:package.clone(),supervision:if cfg!(windows){Some("windows-job-list-v1".into())}else{None}});Ok(())
 })
}
pub fn process_spawned(c:&mut Connection,generation:&str,pid:u32)->Result<()> {change(c,|_,r,_|{
 let p=r.process.as_mut().ok_or("process_journal_missing")?;
 if p.generation!=generation||p.stopped||p.pid.is_some()||pid==0{return Err("process_identity_mismatch".into());}p.pid=Some(pid);Ok(())
})}
pub fn process_stopped(c:&mut Connection,generation:&str)->Result<()> {change(c,|_,r,_|{
 let p=r.process.as_mut().ok_or("process_journal_missing")?;
 if p.generation!=generation{return Err("process_identity_mismatch".into());}p.stopped=true;Ok(())
})}
pub fn process_restart_fence(c:&Connection)->Result<()> {
 let record=load(c)?;
 if record.process.as_ref().is_some_and(|p|!p.stopped)||(record.process.is_none()&&matches!(record.phase,Phase::Active(Lease{owner:Owner::External,..})|Phase::Draining{old:Lease{owner:Owner::External,..},..})){return Err("previous_process_stop_unproven".into());}Ok(())
}

pub fn rebind_session_in(c:&Connection,lease:Lease,old:&str,package:Option<&PackageBinding>,resolved:&str)->Result<()> {
 authorize_scope(c,lease,old,package)?;
 if old==resolved{return Ok(());}
 if super::store::find_session(c,resolved).map_err(|_|"storage_unavailable")?.is_none(){return Err("session_mismatch".into());}
 let mut record=load(c)?;record.session=Some(resolved.into());save(c,&record)
}

// Read under history lock; perform OS fencing OUTSIDE it; then process_stopped exact generation.
// Missing / legacy marker cannot authorize a recovery based on job absence.
#[cfg(windows)]
pub fn pending_windows_generation(c:&Connection)->Result<String> {
 let r=load(c)?;let p=r.process.ok_or("process_journal_missing")?;
 if p.stopped||p.supervision.as_deref()!=Some("windows-job-list-v1"){return Err("process_fence_unproven".into());}
 Ok(p.generation)
}

#[cfg(test)]
mod supervision_tests {
 use super::*;
 fn starting()->(Connection,String,Lease) {
  let mut c=Connection::open_in_memory().unwrap();install(&c).unwrap();
  let Phase::Active(old)=phase(&c).unwrap()else{panic!()};
  let next=Lease{owner:Owner::External,epoch:old.epoch+1};
  let package=PackageBinding{id:"dota2".into(),version:"0.1.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)};
  begin(&mut c,old,Owner::External,"session",Some(package.clone())).unwrap();
  let generation=uuid::Uuid::new_v4().to_string();process_starting(&mut c,next,&package,&generation).unwrap();(c,generation,old)
 }
 #[test] fn journal_precedes_spawn_and_never_uses_pid_as_stop_proof(){
  let(mut c,generation,old)=starting();assert!(process_restart_fence(&c).is_err());
  process_spawned(&mut c,&generation,12345).unwrap();assert!(process_restart_fence(&c).is_err());
  assert!(confirm_fenced(&mut c,old).is_ok()); // ready-process transition, not a restart takeover
  uncertain_restart(&mut c).unwrap();assert!(recover(&mut c,Owner::BuiltIn).is_err());
  assert!(process_stopped(&mut c,&uuid::Uuid::new_v4().to_string()).is_err());
  process_stopped(&mut c,&generation).unwrap();process_restart_fence(&c).unwrap();
 }
 #[test] fn journal_roundtrip_and_unknown_supervisor_fail_closed(){
  let(c,_,_)=starting();let mut record=load(&c).unwrap();
  let expected=if cfg!(windows){Some("windows-job-list-v1")}else{None};assert_eq!(record.process.as_ref().unwrap().supervision.as_deref(),expected);
  record.process.as_mut().unwrap().supervision=Some("untrusted-pid-proof".into());save(&c,&record).unwrap();
  assert_eq!(load(&c).err().unwrap(),"process_identity_corrupt");
 }
 #[test] fn journal_reopen_and_legacy_marker_preserve_uncertainty(){
  let(c,generation,_)=starting();let root=tempfile::tempdir().unwrap();let path=root.path().join("journal.sqlite3");
  let disk=Connection::open(&path).unwrap();install(&disk).unwrap();let mut r=load(&c).unwrap();save(&disk,&r).unwrap();drop(disk);
  let disk=Connection::open(&path).unwrap();assert_eq!(load(&disk).unwrap().process.as_ref().unwrap().generation,generation);
  assert!(process_restart_fence(&disk).is_err());
  // Old journals have no atomic-spawn evidence and must remain fenced.
  r.process.as_mut().unwrap().supervision=None;save(&disk,&r).unwrap();assert!(process_restart_fence(&disk).is_err());
  #[cfg(windows)] assert!(pending_windows_generation(&disk).is_err());
 }
 #[cfg(windows)]
 #[test] fn pre_spawn_recovery_is_explicit_and_keeps_draining(){
  let(mut c,generation,_)=starting();assert_eq!(pending_windows_generation(&c).unwrap(),generation);
  companion_plugin_protocol::windows::fence_generation(&generation).unwrap();
  process_stopped(&mut c,&generation).unwrap();assert!(matches!(phase(&c).unwrap(),Phase::Draining{..}));
  // Native process proof alone does not admit BuiltIn or prove frontend/OBS fences.
  process_restart_fence(&c).unwrap();
 }
}

#[cfg(test)]
mod manual_recovery_tests {
 use super::*;
 fn prepared()->(super::super::host_execution::Fixture,Connection) {
  let(f,_,_)=super::super::host_execution::Fixture::seeded().unwrap();let mut c=f.connect().unwrap();
  super::super::transaction_schema::migrate(&mut c,&f.root.path().join("backup.sqlite3")).unwrap();(f,c)
 }
 #[test] fn explicit_recovery_requires_stopped_generation_and_advances_epoch() {
  let(_f,mut c)=prepared();let Phase::Active(old)=phase(&c).unwrap()else{panic!()};
  let package=PackageBinding{id:"dota2".into(),version:"0.1.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)};
  begin(&mut c,old,Owner::External,"session",Some(package.clone())).unwrap();
  let generation=uuid::Uuid::new_v4().to_string();
  process_starting(&mut c,Lease{owner:Owner::External,epoch:old.epoch+1},&package,&generation).unwrap();
  assert_eq!(recover_builtin_after_fence(&mut c).unwrap_err(),"previous_process_stop_unproven");
  process_stopped(&mut c,&generation).unwrap();let next=recover_builtin_after_fence(&mut c).unwrap();
  assert_eq!(next,Lease{owner:Owner::BuiltIn,epoch:old.epoch+1});assert_eq!(phase(&c).unwrap(),Phase::Active(next));
  assert!(recover_builtin_after_fence(&mut c).is_err());uncertain_restart(&mut c).unwrap();
  assert_eq!(recover_builtin_after_fence(&mut c).unwrap().epoch,next.epoch+1);
 }
 #[test] fn unknown_blocks_manual_recovery_without_deleting_the_key() {
  let(_f,mut c)=prepared();uncertain_restart(&mut c).unwrap();
  c.execute("INSERT INTO pc_tx_ledger VALUES('effect:unknown',?1,'unknown')",["a".repeat(64)]).unwrap();
  assert_eq!(recover_builtin_after_fence(&mut c).unwrap_err(),"unknown_effects_require_explicit_reconciliation");
  assert!(matches!(phase(&c).unwrap(),Phase::Draining{..}));
  assert_eq!(c.query_row("SELECT status FROM pc_tx_ledger WHERE operation_key='effect:unknown'",[],|r|r.get::<_,String>(0)).unwrap(),"unknown");
 }
}
