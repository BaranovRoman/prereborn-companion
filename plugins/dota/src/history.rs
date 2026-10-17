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
 /// A later session's open of storage that a manual Prepare already migrated:
 /// the same verification as Prepare, never a migration, never a new file.
 pub fn open_prepared(root:&Path)->Result<Option<Self>,String> {
  let path=root.join("local-runtime.sqlite3");
  if !path.is_file()||!root.join("local-runtime.pre-external.sqlite3").is_file(){return Ok(None);}
  let probe=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY|rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_|"history_open_failed")?;
  probe.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"history_open_failed")?;
  if !transaction_schema::namespace_prepared(&probe)?{return Ok(None);}
  drop(probe);Self::prepare(root).map(Some)
 }
 #[cfg(windows)]
 pub fn activate(&mut self,process:&SupervisedProcess,package:PackageBinding,capabilities:Vec<String>)->Result<(),String> {
  if self.grant.is_some(){return Err("already_active".into());}
  transaction_schema::activation_preflight(&self.connection,&self.backup)?;
  if !capabilities.iter().any(|c|c==companion_dota_domain::match_execution::MATCH_EXECUTION_CAPABILITY){return Err("capability_denied".into());}
  let executable=std::env::current_exe().map_err(|_|"executable_unavailable")?;
  let (lease,session)=ownership::activate_worker(&mut self.connection,process,&package)?;
  self.grant=Some(Grant{package,executable,lease,session,capabilities});
  if self.grant.as_ref().unwrap().permits("backend.access"){
   if let Err(error)=self.adapter.initialize_sync(&mut self.connection,self.grant.as_ref().unwrap()){
    return Err(match self.drain(){Ok(())=>error,Err(drain)=>format!("{error}; drain: {drain}")});
   }
  }Ok(())
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
 /// The same serialized writer handles idle watchdog/OBS lifecycle ticks and
 /// GSI frames. No cached snapshot is used to bootstrap a gameplay session.
 pub fn tick(&mut self,streaming:Option<bool>,now:chrono::DateTime<chrono::Utc>,sweep:bool)->Result<Option<bool>,String>{
  let g=self.grant.as_mut().ok_or("worker_inactive")?;
  let outcome=self.adapter.external_lifecycle(&mut self.connection,g,streaming,None,now,sweep)?;
  g.session=outcome.session;
  Ok(outcome.stream_ended)
 }
 pub fn edit_context(&self)->Result<serde_json::Value,String>{
  let revision:u64=self.connection.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)).map_err(|_|"history_read_failed")?;
  Ok(serde_json::json!({"revision":revision,"session":self.session(),"active":self.active()}))
 }
 pub fn refresh_account(&mut self,mode:Option<&str>,rating:Option<i64>)->Result<(),String>{
  let grant=self.grant.as_ref().ok_or("worker_inactive")?;self.adapter.refresh_account(&mut self.connection,grant,mode,rating)
 }
 pub fn expire_quiz_geometry(&mut self,current:Option<&str>)->Result<(),String>{
  let grant=self.grant.as_ref().ok_or("worker_inactive")?;self.adapter.expire_quiz_geometry(&mut self.connection,grant,current,chrono::Utc::now())
 }
 pub fn pending_sync(&mut self)->Result<Option<db::sync::OutboxRow>,String>{
  let grant=self.grant.as_ref().ok_or("worker_inactive")?;self.adapter.pending_sync(&mut self.connection,grant,chrono::Utc::now())
 }
 pub fn corrections_since(&mut self)->Result<String,String>{
  let grant=self.grant.as_ref().ok_or("worker_inactive")?;self.adapter.corrections_since(&mut self.connection,grant)
 }
 pub fn apply_corrections(&mut self,since:&str,batch:&[db::sync::Correction])->Result<(),String>{
  let grant=self.grant.as_ref().ok_or("worker_inactive")?;self.adapter.apply_corrections(&mut self.connection,grant,since,batch)
 }
 pub fn settle_sync(&mut self,row:&db::sync::OutboxRow,delivery:&str)->Result<(),String>{
  let grant=self.grant.as_ref().ok_or("worker_inactive")?;self.adapter.settle_sync(&mut self.connection,grant,row,delivery,chrono::Utc::now())
 }
 pub fn edit(&mut self,request:db::host_execution::manual::EditRequest)->Result<db::host_execution::manual::EditReceipt,String>{
  let grant=self.grant.as_mut().ok_or("worker_inactive")?;
  let receipt=self.adapter.manual_edit(&mut self.connection,grant,&request,chrono::Utc::now())?;
  // A recovered receipt describes its original commit. It cannot roll current
  // context back to an earlier session: reread the actual durable owner binding.
  grant.session=ownership::runtime_session(&self.connection,grant.lease,Some(&grant.package))?;
  Ok(receipt)
 }
 pub fn session_ended(&self)->Result<bool,String>{
  let Some(id)=self.session()else{return Ok(false);};
  Ok(store::find_session(&self.connection,id).map_err(|_|"history_read_failed")?.ok_or("session_missing")?.ended_at.is_some())
 }
 pub fn hero_stats(&self,hero_id:i64)->Result<db::summary::HeroLocalStats,String>{
  if !(1..=2048).contains(&hero_id){return Err("invalid_hero_id".into());}
  let stats=store::hero_local_stats(&self.connection,hero_id,10).map_err(|_|"history_read_failed")?;
  Ok(db::summary::HeroLocalStats{matches:stats.matches,wins:stats.wins,losses:stats.losses,avg_kills:stats.avg_kills,avg_deaths:stats.avg_deaths,avg_assists:stats.avg_assists,recent_results:stats.recent_results})
 }
 pub fn summary(&self)->Result<db::summary::LocalSessionSummary,String> {db::summary::try_get(&self.connection).map_err(|_|"history_read_failed".into())}
 pub fn sync_status(&self)->Result<db::sync::SyncOutboxStatus,String>{db::sync::outbox_status(&self.connection).map_err(|_|"history_read_failed".into())}
 pub fn confirm_prepared(&self)->Result<(),String>{transaction_schema::activation_preflight(&self.connection,&self.backup)}
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
 /// Upgrade rehearsal: 0.5.94's Prepare is the same schema/transaction_schema
 /// code (byte-identical DDL), so this is the on-disk state 0.2.0 meets.
 #[test]fn a_history_prepared_by_0594_keeps_matches_files_and_the_original_backup_after_update(){
  use db::model::{RankedMode,MatchResult};
  let root=tempfile::tempdir().unwrap();let path=root.path().join("local-runtime.sqlite3");
  let at=|n:i64|chrono::DateTime::from_timestamp(1_760_000_000+n,0).unwrap();
  {let mut c=rusqlite::Connection::open(&path).unwrap();db::schema::migrate(&c).unwrap();store::set_current_rating(&mut c,4200).unwrap();
   let session=store::ensure_gameplay_session(&mut c,at(0)).unwrap().local_id;store::create_match(&c,&session,Some("7700"),105,"radiant",RankedMode::Ranked,at(1)).unwrap();
   let matched=store::find_active_match(&c,&session).unwrap().unwrap().local_id;store::finalize_match(&mut c,&matched,&session,RankedMode::Ranked,MatchResult::Win,"high",at(2)).unwrap();}
  std::fs::create_dir(root.path().join("sounds")).unwrap();
  let files=[("game-sounds-config.json",b"{\"user\":true}".to_vec()),("sounds/blast-off.wav",b"RIFF user audio".to_vec()),("overlay-layout.json",b"{\"version\":5}".to_vec())];
  for(name,bytes)in &files{std::fs::write(root.path().join(name),bytes).unwrap();}
  let rows=|c:&rusqlite::Connection|->Vec<String>{["local_sessions","local_matches"].iter().flat_map(|t|{let mut s=c.prepare(&format!("SELECT * FROM {t} ORDER BY rowid")).unwrap();let n=s.column_count();
   s.query_map([],|r|Ok((0..n).map(|i|format!("{:?}",r.get_ref(i).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(Result::unwrap).collect::<Vec<_>>()}).collect()};
  let before=rows(&rusqlite::Connection::open(&path).unwrap());assert_eq!(before.len(),2);
  // 0.5.94 manual Prepare.
  drop(History::prepare(root.path()).unwrap());
  let backup=std::fs::read(root.path().join("local-runtime.pre-external.sqlite3")).unwrap();
  // 0.2.0 after the signed update: manual Prepare again, nothing activated.
  let history=History::prepare(root.path()).unwrap();
  assert_eq!(std::fs::read(root.path().join("local-runtime.pre-external.sqlite3")).unwrap(),backup,"the first verified backup is never replaced");
  assert_eq!(rows(&history.connection),before);assert!(!history.active());assert!(history.session().is_none());
  let stats=history.hero_stats(105).unwrap();assert_eq!((stats.matches,stats.wins,stats.losses),(1,1,0));
  for(name,bytes)in &files{assert_eq!(&std::fs::read(root.path().join(name)).unwrap(),bytes,"{name}");}
 }
 #[test]fn a_later_session_reopens_only_already_prepared_storage_without_migrating(){
  let root=tempfile::tempdir().unwrap();assert!(History::open_prepared(root.path()).unwrap().is_none());assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
  {let c=rusqlite::Connection::open(root.path().join("local-runtime.sqlite3")).unwrap();db::schema::migrate(&c).unwrap();}
  std::fs::write(root.path().join("local-runtime.pre-external.sqlite3"),b"unrelated").unwrap();
  assert!(History::open_prepared(root.path()).unwrap().is_none(),"an unprepared legacy schema is never migrated implicitly");
  let c=rusqlite::Connection::open(root.path().join("local-runtime.sqlite3")).unwrap();assert!(!transaction_schema::namespace_prepared(&c).unwrap());drop(c);
  std::fs::remove_file(root.path().join("local-runtime.pre-external.sqlite3")).unwrap();
  drop(History::prepare(root.path()).unwrap());let backup=std::fs::read(root.path().join("local-runtime.pre-external.sqlite3")).unwrap();
  let reopened=History::open_prepared(root.path()).unwrap().unwrap();assert!(!reopened.active());
  assert_eq!(std::fs::read(root.path().join("local-runtime.pre-external.sqlite3")).unwrap(),backup);
  drop(reopened);std::fs::write(root.path().join("local-runtime.pre-external.sqlite3"),b"damaged").unwrap();
  assert!(History::open_prepared(root.path()).is_err(),"a damaged backup still fails verification");
 }
 #[test]fn hero_history_read_is_bounded_and_does_not_disguise_storage_failure_as_zero_matches(){
  let root=tempfile::tempdir().unwrap();let history=History::prepare(root.path()).unwrap();
  assert_eq!(history.hero_stats(105).unwrap().matches,0);assert_eq!(history.hero_stats(0).unwrap_err(),"invalid_hero_id");assert_eq!(history.hero_stats(2049).unwrap_err(),"invalid_hero_id");
  history.connection.execute("DROP TABLE local_matches",[]).unwrap();assert_eq!(history.hero_stats(105).unwrap_err(),"history_read_failed");assert!(!history.active());
 }
 #[test]
 fn manual_preparation_has_no_fake_session_retains_verified_backup_and_denies_second_writer() {
  let root=tempfile::tempdir().unwrap();
  assert!(!root.path().join("local-runtime.sqlite3").exists());
  let history=History::prepare(root.path()).unwrap();
  assert!(!history.active());assert_eq!(history.epoch(),None);assert!(history.existing_session().unwrap().is_none());
  assert!(!history.summary().unwrap().has_session);assert_eq!(history.quota().unwrap().unknown,0);
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
