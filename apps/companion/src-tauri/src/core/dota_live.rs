//! Single admission gate for the existing listener. Default startup never opens safety storage.
//! Manual Windows handover uses the existing coordinator and real process/audio/OBS fences.
use std::{collections::VecDeque,sync::{Arc,Mutex,Condvar,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use companion_dota_domain::{ownership::{Owner,Lease},contracts::ReplayGsi};
use serde::Serialize;
const CAPACITY:usize=8;
const ACTIVATION_BLOCKER:&str="external_runtime_requires_windows_native_fences";
#[derive(Clone,Copy,Debug,PartialEq,Serialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum Mode {BuiltIn,Draining,External,Fallback}
struct Inner {obs_revision:u64,overlay:Option<companion_dota_domain::broadcast_state::BroadcastState>,mode:Mode,lease:Option<Lease>,in_flight:usize,sequence:u64,queue:VecDeque<Frame>,lost:u64,error:Option<String>}
struct Shared {inner:Mutex<Inner>,drained:Condvar,transition:Mutex<()>,gap:AtomicBool,preparation:Mutex<Option<Preparation>>}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Preparation {attempt:String,stage:&'static str,status:&'static str,error_code:Option<String>,started_at:String,finished_at:Option<String>}
#[derive(Clone)]
pub(crate) struct LiveDota(Arc<Shared>);
pub(crate) struct Admission {shared:Arc<Shared>}
impl Admission {pub(crate) fn fork(&self)->Admission{let mut i=self.shared.inner.lock().unwrap();i.in_flight+=1;Admission{shared:self.shared.clone()}}}
impl Drop for Admission {fn drop(&mut self){let mut i=self.shared.inner.lock().unwrap();i.in_flight-=1;self.shared.drained.notify_all();}}
pub(crate) struct Frame {pub(crate) snapshot:ReplayGsi,pub(crate) context:companion_dota_domain::contracts::ReplayContext,pub(crate) sequence:u64,pub(crate) at:chrono::DateTime<chrono::Utc>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Status {mode:Mode,epoch:Option<u64>,queued:usize,in_flight:usize,lost:u64,error:Option<String>,activation_blocker:Option<&'static str>}
impl Default for LiveDota {
 fn default()->Self {Self(Arc::new(Shared{inner:Mutex::new(Inner{obs_revision:0,overlay:None,mode:Mode::BuiltIn,lease:None,in_flight:0,sequence:0,queue:VecDeque::with_capacity(CAPACITY),lost:0,error:None}),drained:Condvar::new(),transition:Mutex::new(()),gap:AtomicBool::new(false),preparation:Mutex::new(None)}))}
}
impl LiveDota {
 fn begin_preparation(&self)->Result<String,String> {
  let mut last=self.0.preparation.lock().map_err(|_|"prepare_diagnostics_unavailable")?;
  if last.as_ref().is_some_and(|p|p.status=="pending"){return Err("prepare_in_progress".into());}
  let attempt=uuid::Uuid::new_v4().to_string();
  *last=Some(Preparation{attempt:attempt.clone(),stage:"native_received",status:"pending",error_code:None,started_at:chrono::Utc::now().to_rfc3339(),finished_at:None});Ok(attempt)
 }
 fn preparation(&self)->Option<Preparation>{self.0.preparation.lock().ok()?.clone()}
 fn preparation_stage(&self,app:&tauri::AppHandle,stage:&'static str) {
  let snapshot={let Ok(mut last)=self.0.preparation.lock()else{return;};let Some(p)=last.as_mut().filter(|p|p.status=="pending")else{return;};p.stage=stage;p.clone()};
  log_preparation(app,&snapshot);
 }
 fn finish_preparation(&self,attempt:&str,result:&Result<(),String>)->Option<Preparation> {
  let mut last=self.0.preparation.lock().ok()?;let p=last.as_mut().filter(|p|p.attempt==attempt&&p.status=="pending")?;
  p.status=if result.is_ok(){p.stage="completed";"succeeded"}else{"failed"};
  p.error_code=result.as_ref().err().map(|e|if e.len()<=128&&!e.is_empty()&&e.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'){e.clone()}else{"prepare_native_error".into()});
  p.finished_at=Some(chrono::Utc::now().to_rfc3339());Some(p.clone())
 }
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
   crate::local_runtime::transaction_authorization::process_restart_fence(c)?;
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
 pub(crate) fn status(&self)->Status {let i=self.0.inner.lock().unwrap();Status{mode:i.mode,epoch:i.lease.map(|l|l.epoch),queued:i.queue.len(),in_flight:i.in_flight,lost:i.lost,error:i.error.clone(),activation_blocker:if cfg!(windows){None}else{Some(ACTIVATION_BLOCKER)}}}
 pub(crate) fn request_obs_reconciliation(&self){if let Ok(mut i)=self.0.inner.lock(){if i.mode==Mode::External{i.obs_revision=i.obs_revision.saturating_add(1);}}}
 pub(crate) fn obs_frame(&self,lease:Lease,snapshot:ReplayGsi,context:companion_dota_domain::contracts::ReplayContext)->Option<Frame> {
  let mut i=self.0.inner.lock().ok()?;if i.mode!=Mode::External||i.lease!=Some(lease)||!i.queue.is_empty(){return None;}
  i.sequence=i.sequence.checked_add(1)?;Some(Frame{snapshot,context,sequence:i.sequence,at:chrono::Utc::now()})
 }
 pub(crate) fn core_writer(&self)->Result<Admission,String> {
  let mut i=self.0.inner.lock().map_err(|_|"admission_poisoned")?;if !matches!(i.mode,Mode::BuiltIn|Mode::External){return Err("ownership_fenced".into());}
  i.in_flight+=1;Ok(Admission{shared:self.0.clone()})
 }
 pub(crate) fn obs_revision(&self)->u64{self.0.inner.lock().map(|i|i.obs_revision).unwrap_or(u64::MAX)}
 pub(crate) fn lease(&self)->Option<Lease>{self.0.inner.lock().ok().and_then(|i|i.lease)}
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
 #[cfg(test)]
 pub(crate) fn next(&self)->Option<Frame>{self.next_for(self.lease()?)}
 pub(crate) fn next_for(&self,lease:Lease)->Option<Frame>{let mut i=self.0.inner.lock().ok()?;
  if i.lease!=Some(lease){return None;}
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
  if i.lease.is_some_and(|lease|lease!=old)||target==old.owner||!matches!(i.mode,Mode::BuiltIn|Mode::External|Mode::Fallback|Mode::Draining){return Err("invalid_handover".into());}
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
// Read-only preflight; normal startup/registry/updater never invokes manual activation.
pub(crate) fn developer_activation_preflight(conn:&rusqlite::Connection,backup:&std::path::Path)->Result<(),String> {
 crate::local_runtime::transaction_schema::activation_preflight(conn,backup)?;
 beta_capacity_preflight(conn)?;
 if !cfg!(windows){return Err(ACTIVATION_BLOCKER.into());}Ok(())
}

// Measured 8h model plus headroom; limits are NOT raised and keys are never evicted.
pub(crate) fn beta_capacity_preflight(c:&rusqlite::Connection)->Result<(),String> {
 let q=crate::local_runtime::host_execution::live_effects::quota(c)?;
 if q.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}
 if q.remaining_operations<6000||q.remaining_tickets<256||q.remaining_receipt_bytes<8*1024*1024||q.remaining_ticket_bytes<1024*1024||q.remaining_revision_identities<256{return Err("eight_hour_beta_capacity_unavailable".into());}Ok(())
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
 #[test]
 fn retired_consumer_cannot_take_frames_of_a_new_epoch() {
  let gate=LiveDota::default();let old=Lease{owner:Owner::BuiltIn,epoch:1};let external=Lease{owner:Owner::External,epoch:2};
  gate.switch(old,Owner::External,Duration::from_secs(1),||Ok(()),||Ok(()),||Ok(external),|_|Ok(())).unwrap();
  gate.enqueue(&serde_json::json!({}));
  assert!(gate.next_for(Lease{owner:Owner::External,epoch:1}).is_none());assert_eq!(gate.status().queued,1);
  assert_eq!(gate.next_for(external).unwrap().sequence,1);
 }
}

mod ipc;

fn log_preparation(app:&tauri::AppHandle,p:&Preparation) {
 crate::storage::append_rolling_log(app,&preparation_line(p));
}
fn preparation_line(p:&Preparation)->String{format!("Dota Prepare attempt={} stage={} status={} code={}",p.attempt,p.stage,p.status,p.error_code.as_deref().unwrap_or("none"))}

// Main-window manual action only. Ordinary startup/registry restore never invokes it.
#[tauri::command]
pub(crate) async fn dota_runtime_action(window:tauri::WebviewWindow,action:String,confirmed:bool)->Result<(),String> {
 use tauri::Manager;
 if window.label()!="main"{return Err("dota_runtime_window_denied".into());}
 let app=window.app_handle().clone();
 let attempt=if action=="prepare"{
  let gate=app.state::<LiveDota>();
  let id=match gate.begin_preparation(){Ok(id)=>id,Err(code)=>{crate::storage::append_rolling_log(&app,&format!("Dota Prepare admission rejected code={code}"));return Err(code);}};
  gate.preparation_stage(&app,"native_received");Some(id)
 }else{None};
 let worker_app=app.clone();
 let result=if !cfg!(windows){Err(ACTIVATION_BLOCKER.into())}else if !confirmed{Err("manual_dota_confirmation_required".into())}else{
  tauri::async_runtime::spawn_blocking(move||{
   let manager=worker_app.state::<crate::core::plugin_manager::PluginManager>();
   manager.live_transition(||{
    if action=="prepare"{worker_app.state::<LiveDota>().preparation_stage(&worker_app,"manager_admitted");}
    manual_action(&worker_app,&action)
   })
  }).await.unwrap_or_else(|_|Err("dota_transition_task_failed".into()))
 };
 if let Some(id)=attempt{if let Some(p)=app.state::<LiveDota>().finish_preparation(&id,&result){log_preparation(&app,&p);}}
 result
}

fn manual_action(app:&tauri::AppHandle,action:&str)->Result<(),String> {
 use tauri::Manager;
 use crate::local_runtime::{LocalRuntimeState,transaction_authorization as auth};
 let gate=app.state::<LiveDota>();let history=app.state::<LocalRuntimeState>();
 let manager=app.state::<crate::core::plugin_manager::PluginManager>();
 let audio=app.state::<crate::game_sounds::audio_fence::AudioFence>();
 let backup=app.path().app_data_dir().map_err(|_|"app_data_unavailable")?.join("local-runtime.pre-external.sqlite3");
 const CAPS:&[&str]=&["dota.match.execute","dota.sound.play","dota.obs.scene","dota.overlay.update"];
 match action {
  "prepare"|"recover"=>{
   if action=="prepare" {
    gate.preparation_stage(app,"session_lookup");
    let session=history.preparation_session()?.ok_or("builtin_session_required")?;
    gate.preparation_stage(app,"session_checked");
    gate.preparation_stage(app,"package_check");
    manager.match_execution_grant(CAPS,&session,Lease{owner:Owner::External,epoch:gate.lease().map_or(2,|l|l.epoch.saturating_add(1))})?;
    gate.preparation_stage(app,"package_verified");
   }
   let _transition=gate.0.transition.lock().map_err(|_|"transition_poisoned")?;
   let deadline=Instant::now()+Duration::from_secs(5);
   let mut inner=gate.0.inner.lock().map_err(|_|"admission_poisoned")?;
   if !matches!(inner.mode,Mode::BuiltIn|Mode::Draining){return Err("stop_external_before_preparation".into());}
   inner.mode=Mode::Draining;inner.queue.clear();
   if action=="prepare"{gate.preparation_stage(app,"draining");}
   while inner.in_flight>0 {
    let remaining=deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero(){return Err("drain_timeout".into());}
    inner=gate.0.drained.wait_timeout(inner,remaining).map_err(|_|"admission_poisoned")?.0;
   }
   drop(inner);
   let result:Result<(),String>=(||{
    if action=="prepare"{gate.preparation_stage(app,"audio_fence");}
    audio.fence(app)?;
    if action=="prepare"{gate.preparation_stage(app,"obs_fence");}
    crate::obs::fence_external_handover(app)?;
    if action=="prepare" {
     gate.preparation_stage(app,"schema_check");
     let migrated={let c=history.try_lock().map_err(str::to_string)?;c.as_ref().ok_or("local_runtime_unavailable")?.query_row("SELECT count(*) FROM sqlite_master WHERE name='pc_tx_meta'",[],|r|r.get::<_,i64>(0)).map_err(|_|"storage_unavailable")?!=0};
     gate.preparation_stage(app,"backup");
     if !migrated{history.migrate_transactions(&backup)?;}
     gate.preparation_stage(app,"preflight");
    }
    history.with_transaction_adapter(|_,c|{crate::local_runtime::transaction_schema::activation_preflight(c,&backup)?;Ok(())})?;
    // Journal absence is safe only if no External generation was ever admitted.
    let pending=history.with_transaction_adapter(|_,c|auth::process_restart_fence(c));
    if pending.is_err(){
     #[cfg(windows)]
     {
      ipc::fence_previous_windows_process_locked(&history,&gate)?;
     }
     #[cfg(not(windows))]
     {return Err(ACTIVATION_BLOCKER.into());}
    }
    let lease=history.with_transaction_adapter(|_,c|{
     match auth::phase(c)? {
      companion_dota_domain::ownership::Phase::Active(l) if l.owner==Owner::BuiltIn=>Ok(l),
      companion_dota_domain::ownership::Phase::Draining{..}=>auth::recover_builtin_after_fence(c),
      _=>Err("recovery_requires_draining".into()),
     }
    })?;
    crate::dota::reset_after_external_fence(app)?;audio.reopen()?;
    manager.clear_live_dota(lease)?;
    let mut inner=gate.0.inner.lock().map_err(|_|"admission_poisoned")?;
    inner.lease=Some(lease);inner.mode=Mode::BuiltIn;inner.error=None;gate.0.gap.store(false,Ordering::SeqCst);Ok(())
   })();
   if let Err(e)=&result{gate.0.inner.lock().map_err(|_|"admission_poisoned")?.error=Some(e.clone());}
   result
  },
  "enable"=>{
   if gate.status().mode!=Mode::BuiltIn{return Err("ownership_not_builtin".into());}
   {let c=history.try_lock().map_err(str::to_string)?;developer_activation_preflight(c.as_ref().ok_or("local_runtime_unavailable")?,&backup)?;}
   let session=history.audio_session().ok_or("builtin_session_required")?;
   let process=ipc::handover_external(&manager,&history,&gate,&session,&backup,CAPS,||{
    audio.fence(app)?;crate::obs::fence_external_handover(app)?;audio.reopen()
   })?;
   manager.mark_live_dota(gate.lease().ok_or("ownership_not_external")?)?;process.consume(app.clone());Ok(())
  },
  "disable"=>{
   {let mut inner=gate.0.inner.lock().map_err(|_|"admission_poisoned")?;
    if inner.mode==Mode::BuiltIn{return Ok(());}
    if inner.lease.is_none_or(|l|l.owner!=Owner::External){return Err("explicit_builtin_recovery_required".into());}
    inner.mode=Mode::Fallback;inner.queue.clear();}
   let until=Instant::now()+Duration::from_secs(15);
   loop {if gate.status().mode==Mode::BuiltIn{return Ok(());}
    if Instant::now()>=until{return Err(gate.status().error.unwrap_or("fallback_pending".into()));}std::thread::sleep(Duration::from_millis(50));}
  },
  _=>Err("unknown_dota_action".into()),
 }
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct SafetyStatus {runtime:Status,quota:Option<crate::local_runtime::host_execution::live_effects::Quota>,storage_error:Option<String>,preparation:Option<Preparation>}
#[tauri::command]
pub(crate) fn dota_runtime_safety_status(app:tauri::AppHandle)->SafetyStatus {
 use tauri::Manager;
 let runtime=app.state::<LiveDota>().status();
 let preparation=app.state::<LiveDota>().preparation();
 let history=app.state::<crate::local_runtime::LocalRuntimeState>();
 let result=history.try_lock().map_err(str::to_string).and_then(|c|crate::local_runtime::host_execution::live_effects::quota(c.as_ref().ok_or("local_runtime_unavailable")?));
 match result {Ok(quota)=>SafetyStatus{runtime,quota:Some(quota),storage_error:None,preparation},Err(e)=>SafetyStatus{runtime,quota:None,storage_error:Some(e),preparation}}
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
mod prepare_diagnostics {
 use super::*;
 #[test] fn records_early_failure_without_changing_builtin_or_allowing_concurrent_prepare() {
  let gate=LiveDota::default();let id=gate.begin_preparation().unwrap();
  assert_eq!(gate.begin_preparation().unwrap_err(),"prepare_in_progress");
  assert_eq!(gate.preparation().unwrap().attempt,id);
  let failure=gate.finish_preparation(&id,&Err("history_busy".into())).unwrap();
  assert_eq!(failure.stage,"native_received");assert_eq!(failure.status,"failed");assert_eq!(failure.error_code.as_deref(),Some("history_busy"));
  assert!(failure.finished_at.is_some());assert_eq!(gate.status().mode,Mode::BuiltIn);assert!(gate.lease().is_none());
  assert_eq!(gate.preparation().unwrap().error_code,failure.error_code);
  let retry=gate.begin_preparation().unwrap();assert_ne!(retry,id);
  assert!(gate.finish_preparation(&id,&Ok(())).is_none());
  let success=gate.finish_preparation(&retry,&Ok(())).unwrap();assert_eq!(success.stage,"completed");assert_eq!(success.status,"succeeded");
 }
 #[test] fn log_contains_only_attempt_stage_status_and_safe_error_code() {
  let gate=LiveDota::default();let id=gate.begin_preparation().unwrap();
  let p=gate.finish_preparation(&id,&Err("secret/password SQL /personal/path".into())).unwrap();
  let line=preparation_line(&p);assert!(line.contains("code=prepare_native_error"));assert!(!line.contains("secret"));assert!(!line.contains("SQL"));
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
