//! Shared host audio implementation; the native adapter supplies only emit.
use super::store;
use companion_plugin_protocol::{audio::{Token,Status,Fence},playback::PlaybackRegistry,runtime::ProcessBinding,ProcessGrant};
use std::{collections::BTreeMap,io::Read,path::Path,sync::{Arc,Mutex},time::{Duration,SystemTime,UNIX_EPOCH}};
use base64::{engine::general_purpose::STANDARD as BASE64,Engine};

pub(crate) struct HostAudio{registries:Mutex<BTreeMap<String,Arc<PlaybackRegistry>>>,ledger:Mutex<store::Store>}
#[derive(serde::Serialize,Clone)]
#[serde(rename_all="camelCase")]
pub(crate) struct Payload{playback:Token,event_id:String,base64:String,mime:&'static str,volume:u8,correlation_id:String,emitted_at_ms:u64,#[serde(skip_serializing_if="Option::is_none")]speech:Option<String>}
impl HostAudio{
 pub(crate) fn open(path:&Path)->Result<Self,String>{Ok(Self{registries:Default::default(),ledger:Mutex::new(store::Store::open(path)?)})}
 fn locked(&self)->Result<std::sync::MutexGuard<'_,store::Store>,String>{self.ledger.lock().map_err(|_|"transport_store_poisoned".into())}
 pub(crate) fn reserve_process(&self,process:&ProcessBinding)->Result<store::ProcessRecord,String>{self.locked()?.reserve_process(process)}
 pub(crate) fn process_ready(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.process_ready(process,epoch)}
 pub(crate) fn process_draining(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.process_draining(process,epoch)}
 pub(crate) fn process_after_native_exit(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.process_after_native_exit(process,epoch)}
 pub(crate) fn process(&self,plugin:&str)->Result<Option<store::ProcessRecord>,String>{self.locked()?.process(plugin)}
 pub(crate) fn receipt(&self,plugin:&str,key:&str)->Result<Option<store::Receipt>,String>{self.locked()?.lookup(plugin,key)}
 pub(crate) fn locked_authorize(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.authorize(process,epoch)}
 fn registry(&self,plugin:&str)->Result<Arc<PlaybackRegistry>,String>{
  let mut registries=self.registries.lock().map_err(|_|"audio_state_poisoned")?;
  if !registries.contains_key(plugin)&&registries.len()>=128{return Err("audio_scope_quota".into());}
  Ok(registries.entry(plugin.into()).or_default().clone())
 }
 fn binding(&self,token:&Token)->Result<(Arc<PlaybackRegistry>,String),String>{
  let registries:Vec<_>=self.registries.lock().map_err(|_|"audio_state_poisoned")?.values().cloned().collect();
  for registry in registries{if let Ok(Some(key))=registry.durable_key(token){return Ok((registry,key));}}Err("playback_scope_mismatch".into())
 }
 pub(crate) fn play(&self,pin:&impl ProcessGrant,process:&ProcessBinding,epoch:u64,context:Option<&str>,root:&Path,key:&str,file:&str,volume:u8,deadline:u64,emit:impl FnOnce(&Payload)->Result<(),String>)->Result<store::Receipt,String>{
  let action=store::Action::Sound{asset_file:file.into(),volume};
  if !pin.permits(action.permission())||pin.binding()!=&process.package{return Err("capability_denied".into());}
  // A retry returns its committed receipt even if the asset has since gone.
  let mut ledger=self.locked()?;
  ledger.authorize(process,epoch)?;
  if let Some(receipt)=ledger.lookup(&process.package.id,key)?{
   if receipt.process!=process.into()||receipt.action!=action||receipt.playback.as_ref().is_none_or(|t|!t.matches_context(epoch,context)){return Err("idempotency_conflict".into());}return Ok(receipt);
  }
  if ledger.uncertain_for(&process.package.id)?{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let quota=ledger.quota()?;if quota.unknown+quota.pending>=64{return Err("transport_pending_full".into());}
  let now=now_ms();if deadline>now.saturating_add(30000){return Err("invalid_sound_deadline".into());}
  let expired=deadline<=now;
  let asset=if expired{None}else{Some(read_asset(root,file)?)};
  let registry=self.registry(&process.package.id)?;let token=registry.admit(Some(epoch),context)?;
  let admission=match ledger.admit(process,key,action,Some(token.clone())){
   Ok(a)=>a,Err(e)=>{let _=registry.ack(token,Status::Cancelled);return Err(e);},
  };
  if !admission.fresh{let _=registry.ack(token,Status::Cancelled);return Ok(admission.receipt);}
  let qualified=format!("{}/{}",process.package.id,key);
  // Receipt/token is committed before native emit; ACK cannot free the registry
  // until its durable state is committed. Never wait for WebView under this lock.
  registry.bind(&token,&qualified)?;
  if expired{
   // This action is definitively cancelled BEFORE any native emit. Keep its
   // durable key so a delayed retry cannot turn a stale cue into playback.
   let receipt=ledger.audio_ack(&process.package.id,key,&token,Status::Cancelled)?;
   registry.ack(token,Status::Cancelled)?;return Ok(receipt);
  }
  let (bytes,mime)=asset.ok_or("audio_asset_unavailable")?;
  let payload=Payload{playback:token.clone(),event_id:key.into(),base64:BASE64.encode(bytes),mime,volume,correlation_id:key.into(),emitted_at_ms:now,speech:None};
  if let Err(error)=emit(&payload){ledger.audio_ack(&process.package.id,key,&token,Status::Unknown)?;registry.ack(token,Status::Unknown)?;return Err(error);}
  Ok(admission.receipt)
 }
 pub(crate) fn owns(&self,token:&Token)->bool{self.binding(token).is_ok()}
 /// Bounded plugin voice notification, independent of the Twitch TTS queue.
 /// The WebView synthesizes only after this admission and owns its cancellation
 /// token throughout synthesis and playback; emit is never playback completion.
 pub(crate) fn speak(&self,pin:&impl ProcessGrant,process:&ProcessBinding,epoch:u64,context:Option<&str>,key:&str,text:&str,volume:u8,deadline:u64,emit:impl FnOnce(&Payload)->Result<(),String>)->Result<store::Receipt,String>{
  let action=store::Action::Speech{text:text.into(),volume};
  if !pin.permits(action.permission())||pin.binding()!=&process.package{return Err("capability_denied".into());}
  let mut ledger=self.locked()?;ledger.authorize(process,epoch)?;
  if let Some(receipt)=ledger.lookup(&process.package.id,key)?{if receipt.process!=process.into()||receipt.action!=action||receipt.playback.as_ref().is_none_or(|t|!t.matches_context(epoch,context)){return Err("idempotency_conflict".into());}return Ok(receipt);}
  if ledger.uncertain_for(&process.package.id)?{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let quota=ledger.quota()?;if quota.unknown+quota.pending>=64{return Err("transport_pending_full".into());}
  let now=now_ms();if deadline>now.saturating_add(30000){return Err("invalid_sound_deadline".into());}
  let registry=self.registry(&process.package.id)?;let token=registry.admit(Some(epoch),context)?;
  let admission=match ledger.admit(process,key,action,Some(token.clone())){Ok(a)=>a,Err(error)=>{let _=registry.ack(token,Status::Cancelled);return Err(error);}};
  if !admission.fresh{let _=registry.ack(token,Status::Cancelled);return Ok(admission.receipt);}
  registry.bind(&token,&format!("{}/{}",process.package.id,key))?;
  if deadline<=now{let receipt=ledger.audio_ack(&process.package.id,key,&token,Status::Cancelled)?;registry.ack(token,Status::Cancelled)?;return Ok(receipt);}
  let payload=Payload{playback:token.clone(),event_id:key.into(),base64:String::new(),mime:"audio/wav",volume,correlation_id:key.into(),emitted_at_ms:now,speech:Some(text.into())};
  if let Err(error)=emit(&payload){ledger.audio_ack(&process.package.id,key,&token,Status::Unknown)?;registry.ack(token,Status::Unknown)?;return Err(error);}Ok(admission.receipt)
 }
 /// IO runs without the ledger mutex. The process command lock serializes
 /// this call with stop/reconfigure. A saved Unknown is observation-only.
 pub(crate) fn scene(&self,pin:&impl ProcessGrant,process:&ProcessBinding,epoch:u64,key:&str,name:&str,execute:impl FnOnce(bool)->Result<Status,String>)->Result<store::Receipt,String>{
  let action=store::Action::Scene{name:name.into()};
  if !pin.permits(action.permission())||pin.binding()!=&process.package{return Err("capability_denied".into());}
  let admission={let mut ledger=self.locked()?;ledger.authorize(process,epoch)?;
   if let Some(receipt)=ledger.lookup(&process.package.id,key)?{
    if receipt.process!=process.into()||receipt.action!=action{return Err("idempotency_conflict".into());}
    if matches!(receipt.status,Status::Completed|Status::Cancelled){return Ok(receipt);}
    store::Admission{fresh:false,receipt}
   }else{
    if ledger.uncertain_for(&process.package.id)?{return Err("unknown_effects_require_explicit_reconciliation".into());}
    ledger.admit(process,key,action,None)?
   }
  };
  let status=execute(admission.fresh).unwrap_or(Status::Unknown);
  self.locked()?.scene_result(process,epoch,key,status)
 }
 pub(crate) fn ack(&self,token:Token,status:Status)->Result<(),String>{
  let mut ledger=self.locked()?;
  let (registry,qualified)=self.binding(&token)?;
  let (plugin,key)=qualified.split_once('/').ok_or("audio_not_bound")?;
  ledger.audio_ack(plugin,key,&token,status)?;registry.ack(token,status)
 }
 pub(crate) fn fence(&self,plugin:&str,emit:impl FnOnce(Fence)->Result<(),String>)->Result<(),String>{
  let registry=self.registries.lock().map_err(|_|"audio_state_poisoned")?.get(plugin).cloned();
  if let Some(registry)=registry{let request=registry.begin()?;emit(request)?;registry.wait(Duration::from_secs(2))?;}
  let quota=self.locked()?.quota_for(plugin)?;if quota.unknown!=0||quota.pending!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}Ok(())
 }
 pub(crate) fn confirm(&self,request:&Fence,stopped:bool)->Result<(),String>{
  let registries:Vec<_>=self.registries.lock().map_err(|_|"audio_state_poisoned")?.values().cloned().collect();
  for registry in registries{if registry.confirm(request,stopped).is_ok(){return Ok(());}}Err("stale_audio_fence".into())
 }
 pub(crate) fn reopen(&self,plugin:&str)->Result<(),String>{
  let registry=self.registries.lock().map_err(|_|"audio_state_poisoned")?.get(plugin).cloned();if let Some(registry)=registry{registry.reopen()?;}Ok(())
 }
}
fn now_ms()->u64{SystemTime::now().duration_since(UNIX_EPOCH).map(|t|t.as_millis().min(u128::from(u64::MAX)) as u64).unwrap_or(0)}
fn read_asset(root:&Path,file:&str)->Result<(Vec<u8>,&'static str),String>{
 companion_plugin_manager::safe_path(file)?;
 if file.contains('/'){return Err("invalid_audio_asset".into());}
 let mime=match Path::new(file).extension().and_then(|s|s.to_str()){Some("wav")=>"audio/wav",Some("mp3")=>"audio/mpeg",Some("ogg")=>"audio/ogg",_=>return Err("invalid_audio_asset".into())};
 let root=root.canonicalize().map_err(|_|"audio_asset_unavailable")?;let path=root.join(file);
 let meta=path.symlink_metadata().map_err(|_|"audio_asset_unavailable")?;
 if meta.file_type().is_symlink()||!meta.is_file()||meta.len()>5*1024*1024{return Err("invalid_audio_asset".into());}
 let canonical=path.canonicalize().map_err(|_|"audio_asset_unavailable")?;if !canonical.starts_with(&root){return Err("invalid_audio_asset".into());}
 let mut bytes=Vec::new();std::fs::File::open(canonical).map_err(|_|"audio_asset_unavailable")?.take(5*1024*1024+1).read_to_end(&mut bytes).map_err(|_|"audio_asset_unavailable")?;
 if bytes.len()>5*1024*1024{return Err("invalid_audio_asset".into());}Ok((bytes,mime))
}
#[cfg(test)]
mod tests{
 use super::*;
 struct Pin{binding:companion_plugin_protocol::PackageBinding,allowed:bool}
 impl ProcessGrant for Pin{
  fn binding(&self)->&companion_plugin_protocol::PackageBinding{&self.binding}
  fn executable(&self)->&Path{Path::new("verified-by-manager")}
  fn permits(&self,cap:&str)->bool{self.allowed&&matches!(cap,"audio.play"|"obs.scene")}
 }
 fn pin()->(Pin,ProcessBinding){
  let binding=companion_plugin_protocol::PackageBinding{id:"example".into(),version:"1.0.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)};
  (Pin{binding:binding.clone(),allowed:true},ProcessBinding{generation:uuid::Uuid::new_v4().to_string(),package:binding})
 }
 #[test]
 fn plugin_voice_notification_requires_durable_admission_and_real_cancellation_or_completion(){
  let root=tempfile::tempdir().unwrap();let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let(pin,process)=pin();let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  let receipt=audio.speak(&pin,&process,epoch,None,"speech:1","bounded notification",80,now_ms()+2000,|payload|{assert_eq!(payload.speech.as_deref(),Some("bounded notification"));assert!(payload.base64.is_empty());Ok(())}).unwrap();
  assert_eq!(receipt.status,Status::Unknown);let token=receipt.playback.unwrap();audio.ack(token.clone(),Status::Queued).unwrap();audio.ack(token,Status::Cancelled).unwrap();
  assert_eq!(audio.speak(&pin,&process,epoch,None,"speech:1","bounded notification",80,now_ms()+2000,|_|panic!("repeated notification")).unwrap().status,Status::Cancelled);
  assert!(audio.speak(&pin,&process,epoch,None,"speech:1","changed text",80,now_ms()+2000,|_|panic!("payload conflict")).is_err());
  assert!(audio.speak(&pin,&process,epoch,None,"speech:oversized",&"x".repeat(257),80,now_ms()+2000,|_|panic!("invalid speech")).is_err());
 }
 #[test]
 fn uncertain_scene_is_observation_only_on_retry_and_actual_truth_is_required_before_new_effects(){
  let root=tempfile::tempdir().unwrap();let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let (pin,process)=pin();
  let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  let cancelled=audio.scene(&pin,&process,epoch,"scene:offline","Gameplay",|may_write|{assert!(may_write);Ok(Status::Cancelled)}).unwrap();assert_eq!(cancelled.status,Status::Cancelled);
  let first=audio.scene(&pin,&process,epoch,"scene:1","Gameplay",|may_write|{assert!(may_write);assert_eq!(audio.receipt("example","scene:1")?.unwrap().status,Status::Unknown);Ok(Status::Unknown)}).unwrap();
  assert_eq!(first.status,Status::Unknown);assert!(first.uncertain);
  assert!(audio.scene(&pin,&process,epoch,"scene:2","Draft",|_|panic!("new write after Unknown")).is_err());
  let second=audio.scene(&pin,&process,epoch,"scene:1","Gameplay",|may_write|{assert!(!may_write);Err("authoritative probe unavailable".into())}).unwrap();assert_eq!(second.status,Status::Unknown);
  assert!(audio.scene(&pin,&process,epoch,"scene:1","Gameplay",|may_write|{assert!(!may_write);Ok(Status::Cancelled)}).is_err());
  assert!(audio.scene(&pin,&process,epoch+1,"scene:1","Gameplay",|_|panic!("stale epoch")).is_err());
  assert!(audio.scene(&pin,&process,epoch,"scene:1","Other",|_|panic!("payload conflict")).is_err());
  let reconciled=audio.scene(&pin,&process,epoch,"scene:1","Gameplay",|may_write|{assert!(!may_write);Ok(Status::Completed)}).unwrap();assert_eq!(reconciled.status,Status::Completed);
  assert_eq!(audio.scene(&pin,&process,epoch,"scene:1","Gameplay",|_|panic!("completed re-executed")).unwrap().status,Status::Completed);
  assert_eq!(audio.scene(&pin,&process,epoch,"scene:2","Draft",|may_write|{assert!(may_write);Ok(Status::Completed)}).unwrap().status,Status::Completed);
 }
 #[test]
 fn actual_transport_commits_before_emit_preserves_receipt_after_asset_removal_and_requires_frontend_completion(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("transport.sqlite3");std::fs::write(root.path().join("jump.wav"),b"RIFFtestWAVE").unwrap();
  let audio=HostAudio::open(&path).unwrap();let (pin,process)=pin();
  let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  let receipt=audio.play(&pin,&process,epoch,None,root.path(),"sound:1","jump.wav",63,now_ms()+2000,|payload|{
   let c=rusqlite::Connection::open(&path).unwrap();let doc:String=c.query_row("SELECT receipt FROM transport_effects WHERE operation_key='sound:1'",[],|r|r.get(0)).unwrap();
   let committed:store::Receipt=serde_json::from_str(&doc).unwrap();assert_eq!(committed.playback.as_ref(),Some(&payload.playback));assert_eq!(committed.status,Status::Unknown);
   assert_eq!(payload.volume,63);assert_eq!(BASE64.decode(&payload.base64).unwrap(),b"RIFFtestWAVE");Ok(())
  }).unwrap();
  assert_eq!(audio.receipt("example","sound:1").unwrap().unwrap().status,Status::Unknown);
  assert!(audio.receipt("other-plugin","sound:1").unwrap().is_none());
  let token=receipt.playback.unwrap();assert_eq!(receipt.status,Status::Unknown);assert!(token.scope.session.is_none());
  audio.ack(token.clone(),Status::Playing).unwrap();std::fs::remove_file(root.path().join("jump.wav")).unwrap();
  let saved=audio.play(&pin,&process,epoch,None,root.path(),"sound:1","jump.wav",63,0,|_|panic!("duplicate was emitted")).unwrap();assert_eq!(saved.status,Status::Playing);
  let mut stale=token.clone();stale.scope.epoch=6;assert!(audio.ack(stale,Status::Completed).is_err());
  audio.ack(token,Status::Completed).unwrap();
  assert_eq!(audio.receipt("example","sound:1").unwrap().unwrap().status,Status::Completed);
  assert_eq!(audio.play(&pin,&process,epoch,None,root.path(),"sound:1","jump.wav",63,0,|_|panic!("completed operation was emitted")).unwrap().status,Status::Completed);
 }
 #[test]
 fn emit_failure_blocks_future_effects_and_capability_and_package_mismatch_cannot_play(){
  let root=tempfile::tempdir().unwrap();std::fs::write(root.path().join("jump.wav"),b"RIFFtestWAVE").unwrap();let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let (mut pin,process)=pin();
  let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  pin.allowed=false;assert_eq!(audio.play(&pin,&process,5,None,root.path(),"sound:1","jump.wav",70,now_ms()+2000,|_|panic!("ungranted emit")).unwrap_err(),"capability_denied");
  pin.allowed=true;let mut wrong=process.clone();wrong.package.version="2.0.0".into();assert_eq!(audio.play(&pin,&wrong,5,None,root.path(),"sound:1","jump.wav",70,now_ms()+2000,|_|panic!("unbound emit")).unwrap_err(),"capability_denied");
  assert_eq!(audio.play(&pin,&process,epoch,None,root.path(),"sound:1","jump.wav",70,now_ms()+2000,|_|Err("frontend_audio_emit_failed".into())).unwrap_err(),"frontend_audio_emit_failed");
  assert_eq!(audio.play(&pin,&process,epoch,None,root.path(),"sound:2","jump.wav",70,now_ms()+2000,|_|panic!("Unknown was ignored")).unwrap_err(),"unknown_effects_require_explicit_reconciliation");
  assert_eq!(audio.locked().unwrap().quota().unwrap().unknown,1);
 }
 #[test]
 fn fence_can_commit_frontend_cancellation_without_holding_the_ledger_or_waiting_under_it(){
  let root=tempfile::tempdir().unwrap();std::fs::write(root.path().join("jump.wav"),b"RIFFtestWAVE").unwrap();let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let (pin,process)=pin();
  let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  let receipt=audio.play(&pin,&process,epoch,None,root.path(),"sound:1","jump.wav",70,now_ms()+2000,|_|Ok(())).unwrap();let token=receipt.playback.unwrap();
  audio.ack(token.clone(),Status::Playing).unwrap();audio.process_draining(&process,epoch).unwrap();
  audio.fence("example",|request|{assert_eq!(request.playback_ids,vec![token.id.clone()]);audio.ack(token.clone(),Status::Cancelled)?;audio.confirm(&request,true)}).unwrap();
  assert!(audio.ack(token,Status::Playing).is_err());audio.reopen("example").unwrap();assert_eq!(audio.locked().unwrap().quota().unwrap().unknown,0);
 }
 #[test]
 fn one_plugins_fence_does_not_cancel_another_plugins_pending_playback(){
  let root=tempfile::tempdir().unwrap();std::fs::write(root.path().join("jump.wav"),b"RIFFtestWAVE").unwrap();let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let (first,first_process)=pin();let (mut other,mut other_process)=pin();
  other.binding.id="other".into();other_process.package=other.binding.clone();
  for process in [&first_process,&other_process]{let epoch=audio.reserve_process(process).unwrap().epoch;audio.process_ready(process,epoch).unwrap();}
  let one=audio.play(&first,&first_process,1,None,root.path(),"sound:1","jump.wav",70,now_ms()+2000,|_|Ok(())).unwrap().playback.unwrap();
  let two=audio.play(&other,&other_process,1,None,root.path(),"sound:1","jump.wav",70,now_ms()+2000,|_|Ok(())).unwrap().playback.unwrap();
  audio.ack(one.clone(),Status::Playing).unwrap();audio.ack(two.clone(),Status::Playing).unwrap();
  audio.fence("example",|request|{assert_eq!(request.playback_ids,vec![one.id.clone()]);audio.ack(one.clone(),Status::Cancelled)?;audio.confirm(&request,true)}).unwrap();
  assert!(audio.owns(&two));assert_eq!(audio.locked().unwrap().lookup("other","sound:1").unwrap().unwrap().status,Status::Playing);
  audio.ack(two,Status::Completed).unwrap();
 }
 #[test]
 fn a_new_committed_context_requires_cancellation_of_the_old_playback_and_fences_its_late_ack(){
  let root=tempfile::tempdir().unwrap();std::fs::write(root.path().join("jump.wav"),b"RIFFtestWAVE").unwrap();
  let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let(pin,process)=pin();let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  let old=audio.play(&pin,&process,epoch,None,root.path(),"sound:demo","jump.wav",70,now_ms()+2000,|_|Ok(())).unwrap().playback.unwrap();audio.ack(old.clone(),Status::Playing).unwrap();
  audio.fence("example",|fence|{assert_eq!(fence.playback_ids,vec![old.id.clone()]);audio.ack(old.clone(),Status::Cancelled)?;audio.confirm(&fence,true)}).unwrap();audio.reopen("example").unwrap();
  let new=audio.play(&pin,&process,epoch,Some("real-session"),root.path(),"sound:match","jump.wav",70,now_ms()+2000,|_|Ok(())).unwrap().playback.unwrap();
  assert_ne!(old.scope.generation,new.scope.generation);assert!(new.matches_context(epoch,Some("real-session")));
  assert!(audio.ack(old.clone(),Status::Playing).is_err());assert_eq!(audio.receipt("example","sound:demo").unwrap().unwrap().status,Status::Cancelled);
  audio.ack(new,Status::Completed).unwrap();
 }
 #[test]
 fn an_expired_cue_is_durably_cancelled_without_emit_and_cannot_play_on_a_later_retry(){
  let root=tempfile::tempdir().unwrap();let audio=HostAudio::open(&root.path().join("transport.sqlite3")).unwrap();let(pin,process)=pin();let epoch=audio.reserve_process(&process).unwrap().epoch;audio.process_ready(&process,epoch).unwrap();
  let receipt=audio.play(&pin,&process,epoch,None,root.path(),"sound:late","jump.wav",63,0,|_|panic!("expired cue emitted")).unwrap();assert_eq!(receipt.status,Status::Cancelled);
  let retry=audio.play(&pin,&process,epoch,None,root.path(),"sound:late","jump.wav",63,now_ms()+2000,|_|panic!("expired cue replayed")).unwrap();assert_eq!(retry.status,Status::Cancelled);
  assert_eq!(audio.receipt("example","sound:late").unwrap().unwrap().status,Status::Cancelled);
 }
}
