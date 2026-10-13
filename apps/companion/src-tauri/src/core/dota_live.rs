//! Single admission gate for the existing listener. Default startup never opens safety storage.
//! The developer entrypoint remains closed until frontend audio and all legacy writers can fence.
use std::{collections::VecDeque,sync::{Arc,Mutex,Condvar,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use companion_dota_domain::{ownership::{Owner,Lease},contracts::ReplayGsi};
use serde::Serialize;
const CAPACITY:usize=8;
#[derive(Clone,Copy,Debug,PartialEq,Serialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum Mode {BuiltIn,Draining,External,Fallback}
struct Inner {overlay:Option<companion_dota_domain::broadcast_state::BroadcastState>,mode:Mode,lease:Option<Lease>,in_flight:usize,sequence:u64,queue:VecDeque<Frame>,lost:u64,error:Option<String>}
struct Shared {inner:Mutex<Inner>,drained:Condvar,transition:Mutex<()>,gap:AtomicBool}
#[derive(Clone)]
pub(crate) struct LiveDota(Arc<Shared>);
pub(crate) struct Admission {shared:Arc<Shared>}
impl Admission {pub(crate) fn fork(&self)->Admission{let mut i=self.shared.inner.lock().unwrap();i.in_flight+=1;Admission{shared:self.shared.clone()}}}
impl Drop for Admission {fn drop(&mut self){let mut i=self.shared.inner.lock().unwrap();i.in_flight-=1;self.shared.drained.notify_all();}}
pub(crate) struct Frame {pub(crate) snapshot:ReplayGsi,pub(crate) context:companion_dota_domain::contracts::ReplayContext,pub(crate) sequence:u64,pub(crate) at:chrono::DateTime<chrono::Utc>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Status {mode:Mode,epoch:Option<u64>,queued:usize,in_flight:usize,lost:u64,error:Option<String>,activation_blocker:&'static str}
impl Default for LiveDota {
 fn default()->Self {Self(Arc::new(Shared{inner:Mutex::new(Inner{overlay:None,mode:Mode::BuiltIn,lease:None,in_flight:0,sequence:0,queue:VecDeque::with_capacity(CAPACITY),lost:0,error:None}),drained:Condvar::new(),transition:Mutex::new(()),gap:AtomicBool::new(false)}))}
}
impl LiveDota {
 pub(crate) fn storage_open_failed(&self,path:&std::path::Path) {
  // Keep the existing unmigrated mirror-failure behavior; never infer BuiltIn after a safety attempt.
  if !known_safety_attempt(path){return;}
  let mut i=self.0.inner.lock().unwrap();i.mode=Mode::Draining;i.error=Some("storage_unavailable_requires_explicit_fence".into());
 }
 pub(crate) fn observe_storage(&self,c:&rusqlite::Connection) {
  // Read only. No automatic migration, recovery epoch, process start or backup restoration.
  let result=(||->Result<Option<Lease>,String>{
   let present:i64=c.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc_tx_%'",[],|r|r.get(0)).map_err(|_|"storage_unavailable")?;
   if present==0 {
    if c.path().is_some_and(|p|known_safety_attempt(std::path::Path::new(p))){return Err("safety_namespace_missing_requires_explicit_fence".into());}
    return Ok(None);
   }
   crate::local_runtime::transaction_schema::validate(c)?;
   match crate::local_runtime::transaction_authorization::phase(c)? {
    companion_dota_domain::ownership::Phase::Active(l) if l.owner==Owner::BuiltIn=>Ok(Some(l)),
    _=>Err("explicit_restart_fence_required".into()),
   }
  })();
  let mut i=self.0.inner.lock().unwrap();match result{Ok(lease)=>i.lease=lease,Err(error)=>{i.mode=Mode::Draining;i.error=Some(error);}}
 }
 pub(crate) fn resolve_overlay(&self,legacy:companion_dota_domain::broadcast_state::BroadcastState)->companion_dota_domain::broadcast_state::BroadcastState {
  use companion_dota_domain::broadcast_state::BroadcastState;
  let Ok(mut i)=self.0.inner.lock()else{return BroadcastState::BetweenMatches;};
  if i.mode==Mode::BuiltIn {i.overlay=Some(legacy);legacy}else{i.overlay.unwrap_or(BroadcastState::BetweenMatches)}
 }
 pub(crate) fn publish_overlay(&self,lease:Lease,state:companion_dota_domain::broadcast_state::BroadcastState)->Result<(),String>{let mut i=self.0.inner.lock().map_err(|_|"admission_poisoned")?;if i.mode!=Mode::External||i.lease!=Some(lease){return Err("ownership_fenced".into());}i.overlay=Some(state);Ok(())}
 pub(crate) fn status(&self)->Status {let i=self.0.inner.lock().unwrap();Status{mode:i.mode,epoch:i.lease.map(|l|l.epoch),queued:i.queue.len(),in_flight:i.in_flight,lost:i.lost,error:i.error.clone(),activation_blocker:"frontend_audio_and_legacy_writers_not_fenced"}}
 pub(crate) fn builtin(&self)->Option<Admission> {let mut i=self.0.inner.lock().ok()?;if i.mode!=Mode::BuiltIn{return None;}i.in_flight+=1;Some(Admission{shared:self.0.clone()})}
 pub(crate) fn external(&self,lease:Lease)->Result<Admission,String> {let mut i=self.0.inner.lock().map_err(|_|"admission_poisoned")?;if i.mode!=Mode::External||i.lease!=Some(lease){return Err("ownership_fenced".into());}i.in_flight+=1;Ok(Admission{shared:self.0.clone()})}
 #[cfg(test)]
 pub(crate) fn enqueue(&self,raw:&serde_json::Value) {self.enqueue_with_context(raw,Default::default());}
 pub(crate) fn enqueue_with_context(&self,raw:&serde_json::Value,context:companion_dota_domain::contracts::ReplayContext) {
  // Projection and try-lock never wait for plugin IO or the history coordinator.
  let snapshot=super::dota_observer::project(raw);
  let Ok(mut i)=self.0.inner.try_lock() else{self.0.gap.store(true,Ordering::SeqCst);return;};if i.mode!=Mode::External{return;}
  if i.queue.len()==CAPACITY||snapshot.is_err()||i.sequence==u64::MAX {
   i.lost=i.lost.saturating_add(1);i.queue.clear();i.mode=Mode::Fallback;i.error=Some("snapshot_gap_requires_fenced_fallback".into());self.0.drained.notify_all();return;
  }
  i.sequence+=1;let sequence=i.sequence;i.queue.push_back(Frame{snapshot:snapshot.unwrap(),context,sequence,at:chrono::Utc::now()});
 }
 pub(crate) fn next(&self)->Option<Frame>{let mut i=self.0.inner.lock().ok()?;
  if self.0.gap.swap(false,Ordering::SeqCst){i.mode=Mode::Fallback;i.queue.clear();i.lost=i.lost.saturating_add(1);i.error=Some("snapshot_gap_requires_fenced_fallback".into());}
  if i.mode!=Mode::External{return None;}i.queue.pop_front()}
 pub(crate) fn failed(&self,lease:Lease,reason:&str){let mut i=self.0.inner.lock().unwrap();
  if i.lease!=Some(lease)||!matches!(i.mode,Mode::External|Mode::Fallback){return;}
  // Never expose arbitrary plugin error messages or snapshots through diagnostics.
  let code=["safety_quota_exhausted","effect_result_unknown","match_result_unconfirmed","ownership_fenced","process_crashed","core_shutdown"].into_iter().find(|c|reason.contains(c))
      .unwrap_or(if reason.contains("timeout"){"ipc_timeout"}else{"plugin_failed"});
  i.mode=Mode::Fallback;i.queue.clear();i.error=Some(code.into());
 }
 // Private to the core: callers supply existing durable functions and concrete fencing actions.
 // No history/process mutex is held while waiting for admitted work.
 pub(crate) fn switch(&self,old:Lease,target:Owner,timeout:Duration,
     begin:impl FnOnce()->Result<(),String>,fence:impl FnOnce()->Result<(),String>,
     confirm:impl FnOnce()->Result<Lease,String>,ready:impl FnOnce(Lease)->Result<(),String>)->Result<Lease,String> {
  let _transition=self.0.transition.lock().map_err(|_|"transition_poisoned")?;
  let deadline=Instant::now()+timeout;
  let mut i=self.0.inner.lock().map_err(|_|"admission_poisoned")?;
  if i.lease.is_some_and(|lease|lease!=old)||target==old.owner||!matches!(i.mode,Mode::BuiltIn|Mode::External|Mode::Fallback){return Err("invalid_handover".into());}
  i.mode=Mode::Draining;i.queue.clear();
  while i.in_flight>0 {
   let remaining=deadline.saturating_duration_since(Instant::now());
   if remaining.is_zero(){i.error=Some("drain_timeout".into());return Err("drain_timeout".into());}
   i=self.0.drained.wait_timeout(i,remaining).map_err(|_|"admission_poisoned")?.0;
  }
  drop(i);
  let result:Result<Lease,String>=(||{begin()?;fence()?;
   // Handshake while durable ownership is still Draining: new process cannot execute.
   let expected=Lease{owner:target,epoch:old.epoch.checked_add(1).ok_or("epoch_exhausted")?};ready(expected)?;
   let lease=confirm()?;if lease!=expected{return Err("invalid_fence_receipt".into());}Ok(lease)})();
  let mut i=self.0.inner.lock().map_err(|_|"admission_poisoned")?;
  match result {Ok(lease)=>{self.0.gap.store(false,Ordering::SeqCst);i.lease=Some(lease);i.mode=if target==Owner::BuiltIn{Mode::BuiltIn}else{Mode::External};i.error=None;Ok(lease)},Err(e)=>{i.error=Some(e.clone());Err(e)}}
 }
}
// No CLI flag, Tauri command, registry restore or updater calls this entrypoint.
// Check storage read-only first; never attach/migrate as a side effect of a refused activation.
pub(crate) fn developer_activation_preflight(conn:&rusqlite::Connection,backup:&std::path::Path)->Result<(),String> {
 crate::local_runtime::transaction_schema::activation_preflight(conn,backup)?;
 Err("frontend_audio_and_legacy_writers_not_fenced".into())
}

#[cfg(test)]
mod tests {
 use super::*;use std::sync::atomic::{AtomicUsize,Ordering};
 #[test]
 fn switch_roundtrip_drains_all_admissions_and_never_overlaps() {
  let gate=LiveDota::default();let old=Lease{owner:Owner::BuiltIn,epoch:1};let held=gate.builtin().unwrap();
  let g=gate.clone();let fences=Arc::new(AtomicUsize::new(0));let f=fences.clone();
  let thread=std::thread::spawn(move||g.switch(old,Owner::External,Duration::from_secs(1),||Ok(()),||{f.fetch_add(1,Ordering::SeqCst);Ok(())},||Ok(Lease{owner:Owner::External,epoch:2}),|_|Ok(())));
  while gate.status().mode!=Mode::Draining{std::thread::yield_now();}
  assert!(gate.builtin().is_none());assert_eq!(fences.load(Ordering::SeqCst),0);drop(held);let external=thread.join().unwrap().unwrap();
  assert!(gate.builtin().is_none());assert!(gate.external(old).is_err());drop(gate.external(external).unwrap());
  let restored=gate.switch(external,Owner::BuiltIn,Duration::from_secs(1),||Ok(()),||Ok(()),||Ok(Lease{owner:Owner::BuiltIn,epoch:3}),|_|Ok(())).unwrap();
  assert_eq!(restored.epoch,3);assert!(gate.builtin().is_some());assert!(gate.external(external).is_err());
 }
 #[test]
 fn unproven_fence_timeout_and_queue_overflow_fail_closed() {
  let gate=LiveDota::default();let old=Lease{owner:Owner::BuiltIn,epoch:1};
  assert!(gate.switch(old,Owner::External,Duration::from_millis(10),||Ok(()),||Err("audio_unfenced".into()),||panic!("new owner"),|_|panic!()).is_err());assert!(gate.builtin().is_none());
  let gate=LiveDota::default();let held=gate.builtin().unwrap();assert!(gate.switch(old,Owner::External,Duration::from_millis(1),||panic!(),||panic!(),||panic!(),|_|panic!()).is_err());drop(held);assert!(gate.builtin().is_none());
  let gate=LiveDota::default();gate.switch(old,Owner::External,Duration::from_secs(1),||Ok(()),||Ok(()),||Ok(Lease{owner:Owner::External,epoch:2}),|_|Ok(())).unwrap();
  for _ in 0..9{gate.enqueue(&serde_json::json!({}));}assert_eq!(gate.status().mode,Mode::Fallback);assert_eq!(gate.status().queued,0);assert!(gate.builtin().is_none());
 }
}

mod ipc;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct SafetyStatus {runtime:Status,quota:Option<crate::local_runtime::host_execution::live_effects::Quota>,storage_error:Option<String>}
#[tauri::command]
pub(crate) fn dota_runtime_safety_status(app:tauri::AppHandle)->SafetyStatus {
 use tauri::Manager;
 let runtime=app.state::<LiveDota>().status();
 let history=app.state::<crate::local_runtime::LocalRuntimeState>();
 let result=history.try_lock().map_err(str::to_string).and_then(|c|crate::local_runtime::host_execution::live_effects::quota(c.as_ref().ok_or("local_runtime_unavailable")?));
 match result {Ok(quota)=>SafetyStatus{runtime,quota:Some(quota),storage_error:None},Err(e)=>SafetyStatus{runtime,quota:None,storage_error:Some(e)}}
}

#[cfg(test)]
mod overlay_fencing_tests {
 use super::*;use companion_dota_domain::broadcast_state::BroadcastState;
 #[test]
 fn draining_and_fallback_cannot_publish_raw_gsi_or_stale_overlay_effects() {
  let gate=LiveDota::default();let builtin=Lease{owner:Owner::BuiltIn,epoch:1};
  assert_eq!(gate.resolve_overlay(BroadcastState::Gameplay),BroadcastState::Gameplay);
  let external=gate.switch(builtin,Owner::External,Duration::from_secs(1),||Ok(()),||Ok(()),||Ok(Lease{owner:Owner::External,epoch:2}),|_|Ok(())).unwrap();
  assert_eq!(gate.resolve_overlay(BroadcastState::Draft),BroadcastState::Gameplay);
  gate.publish_overlay(external,BroadcastState::BetweenMatches).unwrap();gate.failed(external,"process_crashed");
  assert_eq!(gate.resolve_overlay(BroadcastState::Draft),BroadcastState::BetweenMatches);assert!(gate.publish_overlay(external,BroadcastState::Draft).is_err());
  assert!(gate.switch(external,Owner::BuiltIn,Duration::from_secs(1),||Ok(()),||Err("unfenced".into()),||panic!(),|_|panic!()).is_err());
  assert_eq!(gate.resolve_overlay(BroadcastState::Gameplay),BroadcastState::BetweenMatches);
 }
}

fn known_safety_attempt(path:&std::path::Path)->bool {
 let canonical=std::fs::canonicalize(path).unwrap_or_else(|_|path.into());
 match canonical.with_extension("sqlite3.transaction-coordinator.lock").symlink_metadata(){
  Ok(_)=>true,Err(e)=>e.kind()!=std::io::ErrorKind::NotFound,
 }
}
#[cfg(test)]
mod storage_fencing_tests {
 use super::*;
 #[test]
 fn missing_safety_storage_cannot_implicitly_restore_builtin_after_restart() {
  let root=tempfile::tempdir().unwrap();let path=root.path().join("history.sqlite3");
  let legacy=LiveDota::default();legacy.storage_open_failed(&path);assert!(legacy.builtin().is_some());
  std::fs::write(path.with_extension("sqlite3.transaction-coordinator.lock"),b"").unwrap();
  let restart=LiveDota::default();restart.storage_open_failed(&path);assert!(restart.builtin().is_none());assert_eq!(restart.status().mode,Mode::Draining);
  let c=rusqlite::Connection::open(&path).unwrap();let missing_namespace=LiveDota::default();missing_namespace.observe_storage(&c);assert!(missing_namespace.builtin().is_none());
 }
}
