//! Bounded, process-scoped frontend playback tracking; no game or TTS decisions.
use std::{collections::HashMap,sync::{Mutex,Condvar},time::{Duration,Instant}};
use crate::audio::{Scope,Token,Status,Fence};
struct Inner { scope:Scope, blocked:bool, pending:HashMap<String,(Token,Status)>, fence:Option<(Fence,Option<bool>)>, durable:HashMap<String,String> }
pub struct PlaybackRegistry { inner:Mutex<Inner>, changed:Condvar }
impl Default for PlaybackRegistry {
 fn default()->Self {Self{inner:Mutex::new(Inner{scope:Scope{instance:uuid::Uuid::new_v4().to_string(),generation:1,epoch:1,session:None},blocked:false,pending:HashMap::new(),fence:None,durable:HashMap::new()}),changed:Condvar::new()}}
}
impl PlaybackRegistry {
 pub fn admit(&self,epoch:Option<u64>,session:Option<&str>)->Result<Token,String> {
  if session.is_some_and(|s|s.is_empty()||s.len()>128)||epoch.is_some_and(|epoch|epoch==0){return Err("invalid_audio_scope".into());}
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  if i.blocked||i.pending.len()>=64{return Err("game_audio_closed_or_full".into());}
  let mut scope=i.scope.clone();if let Some(epoch)=epoch{scope.epoch=epoch;}scope.session=session.map(str::to_string);
  let token=Token{id:uuid::Uuid::new_v4().to_string(),scope};i.pending.insert(token.id.clone(),(token.clone(),Status::Queued));Ok(token)
 }
 pub fn bind(&self,token:&Token,key:&str)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  if i.blocked||i.pending.get(&token.id).map(|(t,_)|t)!=Some(token)||i.durable.contains_key(&token.id){return Err("audio_binding_denied".into());}
  i.durable.insert(token.id.clone(),key.into());Ok(())
 }
 pub fn durable_key(&self,token:&Token)->Result<Option<String>,String> {
  let i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  if i.pending.get(&token.id).map(|(t,_)|t)!=Some(token){return Err("playback_scope_mismatch".into());}
  Ok(i.durable.get(&token.id).cloned())
 }
 pub fn ack(&self,token:Token,status:Status)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  let (expected,previous)=i.pending.get_mut(&token.id).ok_or("unknown_playback")?;
  if expected!=&token{return Err("playback_scope_mismatch".into());}
  if matches!(*previous,Status::Completed|Status::Cancelled)||(*previous==Status::Unknown&&!matches!(status,Status::Completed|Status::Cancelled)){return Err("playback_terminal".into());}
  *previous=status;
  // Terminal receipts need no replayable admission: this is a bounded transport tracker,
  // not the durable effect ledger. Duplicate/stale frontend ACKs cannot execute anything.
  if matches!(status,Status::Completed|Status::Cancelled){i.pending.remove(&token.id);i.durable.remove(&token.id);}
  self.changed.notify_all();Ok(())
 }
 pub fn accepts(&self,token:&Token)->bool {self.inner.lock().is_ok_and(|i|!i.blocked&&i.pending.contains_key(&token.id)&&token.scope.instance==i.scope.instance&&token.scope.generation==i.scope.generation)}
 pub fn begin(&self)->Result<Fence,String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;i.blocked=true;
  let request=Fence{instance:i.scope.instance.clone(),generation:i.scope.generation,request_id:uuid::Uuid::new_v4().to_string(),playback_ids:i.pending.keys().cloned().collect()};i.fence=Some((request.clone(),None));Ok(request)
 }
 pub fn confirm(&self,request:&Fence,stopped:bool)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  let (expected,result)=i.fence.as_mut().ok_or("unsolicited_audio_fence")?;
  if expected.instance!=request.instance||expected.generation!=request.generation||expected.request_id!=request.request_id||expected.playback_ids!=request.playback_ids||result.is_some(){return Err("stale_audio_fence".into());}
  *result=Some(stopped);self.changed.notify_all();Ok(())
 }
 pub fn wait(&self,timeout:Duration)->Result<(),String> {
  let until=Instant::now()+timeout;let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  loop {match i.fence.as_ref().and_then(|(_,r)|*r){Some(true) if i.durable.is_empty()=>{i.pending.clear();return Ok(());},Some(true)=>(),Some(false)=>return Err("game_audio_stop_unconfirmed".into()),None=>()}
   let remaining=until.saturating_duration_since(Instant::now());if remaining.is_zero(){return Err("frontend_audio_fence_timeout".into());}
   i=self.changed.wait_timeout(i,remaining).map_err(|_|"audio_state_poisoned")?.0;
  }
 }
 pub fn reopen(&self)->Result<(),String> {
  let mut i=self.inner.lock().map_err(|_|"audio_state_poisoned")?;
  if !i.pending.is_empty()||!matches!(i.fence,Some((_,Some(true)))){return Err("game_audio_not_fenced".into());}
  i.scope.generation=i.scope.generation.checked_add(1).ok_or("audio_generation_exhausted")?;i.blocked=false;i.fence=None;Ok(())
 }
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn emitted_cancel_is_not_proof_and_late_reads_are_fenced() {
  let audio=PlaybackRegistry::default();let token=audio.admit(None,None).unwrap();let request=audio.begin().unwrap();
  assert!(!audio.accepts(&token));assert!(audio.admit(None,None).is_err());assert!(audio.wait(Duration::from_millis(1)).is_err());assert!(audio.reopen().is_err());
  let mut wrong=request.clone();wrong.request_id="wrong".into();assert!(audio.confirm(&wrong,true).is_err());
  audio.confirm(&request,true).unwrap();audio.wait(Duration::from_millis(1)).unwrap();audio.reopen().unwrap();assert!(!audio.accepts(&token));assert!(audio.ack(token,Status::Playing).is_err());
  assert_eq!(audio.admit(None,None).unwrap().scope.generation,2);
 }
 #[test]
 fn unknown_failed_frontend_and_quota_fail_closed() {
  let audio=PlaybackRegistry::default();let token=audio.admit(None,None).unwrap();audio.ack(token,Status::Unknown).unwrap();
  let request=audio.begin().unwrap();audio.confirm(&request,false).unwrap();assert!(audio.wait(Duration::from_millis(1)).is_err());assert!(audio.reopen().is_err());
  let audio=PlaybackRegistry::default();for _ in 0..64{audio.admit(None,None).unwrap();}assert!(audio.admit(None,None).is_err());
 }
}
#[cfg(test)]
mod durable_fence_tests {
 use super::*;
 #[test]
 fn fence_waits_for_durable_terminal_ack_and_rejects_other_instance_or_session() {
  let audio=std::sync::Arc::new(PlaybackRegistry::default());let token=audio.admit(Some(5),Some("session")).unwrap();audio.bind(&token,"effect:operation").unwrap();
  let mut forged=token.clone();forged.scope.session=Some("other".into());assert!(audio.durable_key(&forged).is_err());forged=token.clone();forged.scope.instance="other".into();assert!(audio.durable_key(&forged).is_err());
  let request=audio.begin().unwrap();audio.confirm(&request,true).unwrap();assert!(audio.wait(Duration::from_millis(1)).is_err());
  audio.ack(token,Status::Cancelled).unwrap();audio.wait(Duration::from_millis(1)).unwrap();audio.reopen().unwrap();
 }
}
