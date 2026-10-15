//! The worker's existing SQLite coordinator, not a second writer or a SQL RPC API.
use companion_dota_storage::local_runtime::{self as db,host_execution::{Adapter,ExecutionGrant},transaction_authorization as ownership,transaction_schema,store};
use companion_dota_domain::{ownership::Lease,match_execution::{PackageBinding,Receipt},contracts::ReplayGsi};
use companion_plugin_protocol::{ProcessGrant,SupervisedProcess};
use rusqlite::Connection;
use std::path::{Path,PathBuf};

pub struct Grant {pub package:PackageBinding,pub executable:PathBuf,pub lease:Lease,pub session:Option<String>,pub capabilities:Vec<String>}
impl ProcessGrant for Grant {
 fn binding(&self)->&PackageBinding{&self.package}
 fn executable(&self)->&Path{&self.executable}
 fn permits(&self,cap:&str)->bool{self.capabilities.iter().any(|c|c==cap)}
}
impl ExecutionGrant for Grant {
 fn lease(&self)->Lease{self.lease}
 fn session(&self)->Option<&str>{self.session.as_deref()}
}
pub struct History {connection:Connection,adapter:Adapter,#[cfg_attr(not(windows),allow(dead_code))] backup:PathBuf,grant:Option<Grant>}
impl History {
 /// Called only by manual Prepare. Existing backups and safety tables are kept.
 pub fn prepare(root:&Path)->Result<Self,String> {
  let path=root.join("local-runtime.sqlite3");let backup=root.join("local-runtime.pre-external.sqlite3");
  if path.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()){return Err("history_path_invalid".into());}
  let fresh=!path.exists();let mut c=Connection::open(&path).map_err(|_|"history_open_failed")?;
  c.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"history_open_failed")?;
  c.pragma_update(None,"foreign_keys",true).map_err(|_|"history_open_failed")?;
  if fresh {db::schema::migrate(&c).map_err(|_|"history_schema_failed")?;}
  // Existing schemas are verified, never silently upgraded or reset here.
  transaction_schema::migrate(&mut c,&backup)?;
  transaction_schema::activation_preflight(&c,&backup)?;
  let adapter=Adapter::attach(&mut c)?;
  Ok(Self{connection:c,adapter,backup,grant:None})
 }
 #[cfg(windows)]
 pub fn activate(&mut self,process:&SupervisedProcess,package:PackageBinding,capabilities:Vec<String>)->Result<(),String> {
  if self.grant.is_some(){return Err("already_active".into());}
  transaction_schema::activation_preflight(&self.connection,&self.backup)?;
  if !capabilities.iter().any(|c|c==companion_dota_domain::match_execution::MATCH_EXECUTION_CAPABILITY){return Err("capability_denied".into());}
  let executable=std::env::current_exe().map_err(|_|"executable_unavailable")?;
  let (lease,session)=ownership::activate_worker(&mut self.connection,process,&package)?;
  self.grant=Some(Grant{package,executable,lease,session,capabilities});Ok(())
 }
 #[cfg(not(windows))]
 pub fn activate(&mut self,_process:&SupervisedProcess,_package:PackageBinding,_capabilities:Vec<String>)->Result<(),String>{Err("native_supervision_unsupported".into())}
 pub fn drain(&mut self)->Result<(),String> {
  if let Some(g)=self.grant.as_ref(){ownership::drain_worker(&mut self.connection,g.lease,&g.package)?;}
  self.grant=None;Ok(())
 }
 pub fn frame(&mut self,snapshot:ReplayGsi,now:chrono::DateTime<chrono::Utc>,sequence:u64)->Result<Option<Receipt>,String> {
  let g=self.grant.as_mut().ok_or("worker_inactive")?;
  let outcome=self.adapter.external_lifecycle(&mut self.connection,g,None,Some(&snapshot),now,false)?;
  g.session=outcome.session;
  if g.session.is_none(){return Ok(None);}
  let Some(prepared)=self.adapter.prepare_plugin_operation(&mut self.connection,g,snapshot,now,sequence)?else{return Ok(None);};
  // The rolling telemetry slot is intentionally reused only after its prior
  // committed receipt; transitions retain their stable, persisted ticket UUID.
  let key=if prepared.ticket.starts_with("telemetry:"){prepared.ticket.clone()}else{format!("match:{}:{}",g.lease.epoch,prepared.ticket)};
  let request=prepared.core_request(&key,&format!("gsi:{sequence}"))?;
  let response=self.adapter.execute_plugin(&mut self.connection,g,&request)?;
  if response.status!=companion_dota_domain::effects::Status::Completed{return Err("match_result_unconfirmed".into());}
  Ok(response.receipt)
 }
 pub fn summary(&self)->db::summary::LocalSessionSummary {db::summary::get(&self.connection)}
 pub fn quota(&self)->Result<db::host_execution::live_effects::Quota,String>{db::host_execution::live_effects::quota(&self.connection)}
 pub fn session(&self)->Option<&str>{self.grant.as_ref().and_then(|g|g.session.as_deref())}
 pub fn epoch(&self)->Option<u64>{self.grant.as_ref().map(|g|g.lease.epoch)}
 pub fn active(&self)->bool{self.grant.is_some()}
 pub fn existing_session(&self)->Result<Option<String>,String>{
  Ok(store::find_active_match_anywhere(&self.connection).map_err(|_|"history_read_failed")?.map(|m|m.session_local_id)
   .or(store::find_open_session(&self.connection).map_err(|_|"history_read_failed")?.map(|s|s.local_id)))
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn manual_preparation_has_no_fake_session_retains_verified_backup_and_denies_second_writer() {
  let root=tempfile::tempdir().unwrap();
  assert!(!root.path().join("local-runtime.sqlite3").exists());
  let history=History::prepare(root.path()).unwrap();
  assert!(!history.active());assert_eq!(history.epoch(),None);assert!(history.existing_session().unwrap().is_none());
  assert!(!history.summary().has_session);assert_eq!(history.quota().unwrap().unknown,0);
  let backup_path=root.path().join("local-runtime.pre-external.sqlite3");let backup=std::fs::read(&backup_path).unwrap();
  assert!(matches!(History::prepare(root.path()),Err(error) if error=="second_coordinator_denied"));
  assert_eq!(std::fs::read(&backup_path).unwrap(),backup);
  drop(history);
  let reopened=History::prepare(root.path()).unwrap();
  assert!(!reopened.active());assert!(reopened.existing_session().unwrap().is_none());
  assert_eq!(std::fs::read(&backup_path).unwrap(),backup);
  let count:i64=reopened.connection.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get(0)).unwrap();assert_eq!(count,0);
 }
 #[test]
 fn corrupt_or_incompatible_history_is_never_replaced_or_backed_up_as_valid() {
  for corrupt in [true,false] {
   let root=tempfile::tempdir().unwrap();let path=root.path().join("local-runtime.sqlite3");
   if corrupt{std::fs::write(&path,b"not a SQLite database").unwrap();}
   else {let c=Connection::open(&path).unwrap();db::schema::migrate(&c).unwrap();c.pragma_update(None,"user_version",999).unwrap();}
   let before=std::fs::read(&path).unwrap();assert!(History::prepare(root.path()).is_err());
   assert_eq!(std::fs::read(&path).unwrap(),before);
   assert!(!root.path().join("local-runtime.pre-external.sqlite3").exists());
  }
 }
 #[cfg(not(windows))]
 #[test] fn unsupported_native_supervision_cannot_be_forged_from_a_uuid() {
  assert!(matches!(SupervisedProcess::current(&uuid::Uuid::new_v4().to_string()),Err(error) if error=="native_supervision_unsupported"));
 }
}
