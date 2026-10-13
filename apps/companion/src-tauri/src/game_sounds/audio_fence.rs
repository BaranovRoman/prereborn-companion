//! Game-only WebView playback receipts. No Twitch/TTS queue references.
use std::{collections::HashMap, sync::{Mutex, Condvar}, time::{Duration, Instant}};
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Manager, Emitter};
use companion_dota_domain::ownership::Lease;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Scope { instance:String, generation:u32, epoch:u64, session:Option<String> }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Token { id:String, scope:Scope }
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub(crate) enum Status { Queued, Playing, Completed, Cancelled, Unknown }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Fence { instance:String, generation:u32, request_id:String }
struct Inner { scope:Scope, blocked:bool, pending:HashMap<String,(Token,Status)>, fence:Option<(Fence,Option<bool>)> }
pub(crate) struct AudioFence { inner:Mutex<Inner>, changed:Condvar }
impl Default for AudioFence {
 fn default()->Self {Self{inner:Mutex::new(Inner{scope:Scope{instance:uuid::Uuid::new_v4().to_string(),generation:1,epoch:1,session:None},blocked:false,pending:HashMap::new(),fence:None}),changed:Condvar::new()}}
}
impl AudioFence {
 pub(crate) fn admit(&self,lease:Option<Lease>,session:Option<&str>)->Result<Token,String> {
  if session.is_some_and(|s|s.is_empty()||s.len()>128)||lease.is_some_and(|l|l.epoch==0){return Err("invalid_audio_scope".into());}
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  if i.blocked||i.pending.len()>=64{return Err("game_audio_closed_or_full".into());}
  let mut scope=i.scope.clone();if let Some(lease)=lease{scope.epoch=lease.epoch;}scope.session=session.map(str::to_string);
  let token=Token{id:uuid::Uuid::new_v4().to_string(),scope};i.pending.insert(token.id.clone(),(token.clone(),Status::Queued));Ok(token)
 }
 pub(crate) fn ack(&self,token:Token,status:Status)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  let (expected,previous)=i.pending.get_mut(&token.id).ok_or("unknown_playback")?;
  if expected!=&token{return Err("playback_scope_mismatch".into());}
  if matches!(*previous,Status::Completed|Status::Cancelled)||(*previous==Status::Unknown&&!matches!(status,Status::Completed|Status::Cancelled)){return Err("playback_terminal".into());}
  *previous=status;
  // Terminal receipts need no replayable admission: this is a bounded transport tracker,
  // not the durable effect ledger. Duplicate/stale frontend ACKs cannot execute anything.
  if matches!(status,Status::Completed|Status::Cancelled){i.pending.remove(&token.id);}
  self.changed.notify_all();Ok(())
 }
 pub(crate) fn accepts(&self,token:&Token)->bool {self.inner.lock().is_ok_and(|i|!i.blocked&&i.pending.contains_key(&token.id)&&token.scope.instance==i.scope.instance&&token.scope.generation==i.scope.generation)}
 fn begin(&self)->Result<Fence,String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;i.blocked=true;
  let request=Fence{instance:i.scope.instance.clone(),generation:i.scope.generation,request_id:uuid::Uuid::new_v4().to_string()};i.fence=Some((request.clone(),None));Ok(request)
 }
 fn confirm(&self,request:&Fence,stopped:bool)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  let (expected,result)=i.fence.as_mut().ok_or("unsolicited_audio_fence")?;
  if expected.instance!=request.instance||expected.generation!=request.generation||expected.request_id!=request.request_id||result.is_some(){return Err("stale_audio_fence".into());}
  *result=Some(stopped);self.changed.notify_all();Ok(())
 }
 fn wait(&self,timeout:Duration)->Result<(),String> {
  let until=Instant::now()+timeout;let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  loop {match i.fence.as_ref().and_then(|(_,r)|*r){Some(true)=>{i.pending.clear();return Ok(());},Some(false)=>return Err("game_audio_stop_unconfirmed".into()),None=>()}
   let remaining=until.saturating_duration_since(Instant::now());if remaining.is_zero(){return Err("frontend_audio_fence_timeout".into());}
   i=self.changed.wait_timeout(i,remaining).map_err(|_|"audio_state_poisoned")?.0;
  }
 }
 pub(crate) fn fence(&self,app:&AppHandle)->Result<(),String> {
  let request=self.begin()?;app.emit_to("main","game-audio-fence",request).map_err(|_|"frontend_audio_unavailable")?;
  self.wait(Duration::from_secs(2))
 }
 pub(crate) fn reopen(&self)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  if !i.pending.is_empty()||!matches!(i.fence,Some((_,Some(true)))){return Err("game_audio_not_fenced".into());}
  i.scope.generation=i.scope.generation.checked_add(1).ok_or("audio_generation_exhausted")?;i.blocked=false;i.fence=None;Ok(())
 }
}
pub(crate) fn builtin_token<R:tauri::Runtime>(app:&tauri::AppHandle<R>)->Result<Token,String> {
 let lease=app.try_state::<crate::core::dota_live::LiveDota>().and_then(|g|g.lease());
 let session=app.try_state::<crate::local_runtime::LocalRuntimeState>().and_then(|history|history.audio_session());
 app.state::<AudioFence>().admit(lease,session.as_deref())
}
#[tauri::command]
pub(crate) fn game_audio_ack(window:tauri::WebviewWindow,token:Token,status:Status)->Result<(),String> {
 if window.label()!="main"{return Err("game_audio_window_denied".into());}window.state::<AudioFence>().ack(token,status)
}
#[tauri::command]
pub(crate) fn game_audio_fence_ack(window:tauri::WebviewWindow,request:Fence,stopped:bool)->Result<(),String> {
 if window.label()!="main"{return Err("game_audio_window_denied".into());}window.state::<AudioFence>().confirm(&request,stopped)
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn emitted_cancel_is_not_proof_and_late_reads_are_fenced() {
  let audio=AudioFence::default();let token=audio.admit(None,None).unwrap();let request=audio.begin().unwrap();
  assert!(!audio.accepts(&token));assert!(audio.admit(None,None).is_err());assert!(audio.wait(Duration::from_millis(1)).is_err());assert!(audio.reopen().is_err());
  let mut wrong=request.clone();wrong.request_id="wrong".into();assert!(audio.confirm(&wrong,true).is_err());
  audio.confirm(&request,true).unwrap();audio.wait(Duration::from_millis(1)).unwrap();audio.reopen().unwrap();assert!(!audio.accepts(&token));assert!(audio.ack(token,Status::Playing).is_err());
  assert_eq!(audio.admit(None,None).unwrap().scope.generation,2);
 }
 #[test]
 fn unknown_failed_frontend_and_quota_fail_closed() {
  let audio=AudioFence::default();let token=audio.admit(None,None).unwrap();audio.ack(token,Status::Unknown).unwrap();
  let request=audio.begin().unwrap();audio.confirm(&request,false).unwrap();assert!(audio.wait(Duration::from_millis(1)).is_err());assert!(audio.reopen().is_err());
  let audio=AudioFence::default();for _ in 0..64{audio.admit(None,None).unwrap();}assert!(audio.admit(None,None).is_err());
 }
}
