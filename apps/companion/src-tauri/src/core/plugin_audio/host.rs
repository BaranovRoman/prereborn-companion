//! Shared host audio implementation; the native adapter supplies only emit.
use super::store;
use companion_plugin_protocol::{audio::{Token,Status,Fence},playback::PlaybackRegistry,runtime::ProcessBinding,ProcessGrant};
use std::{io::Read,path::Path,sync::Mutex,time::{Duration,SystemTime,UNIX_EPOCH}};
use base64::{engine::general_purpose::STANDARD as BASE64,Engine};

pub(crate) struct HostAudio{registry:PlaybackRegistry,ledger:Mutex<store::Store>}
#[derive(serde::Serialize,Clone)]
#[serde(rename_all="camelCase")]
pub(crate) struct Payload{playback:Token,event_id:String,base64:String,mime:&'static str,volume:u8,correlation_id:String,emitted_at_ms:u64}
impl HostAudio{
 pub(crate) fn open(path:&Path)->Result<Self,String>{Ok(Self{registry:Default::default(),ledger:Mutex::new(store::Store::open(path)?)})}
 fn locked(&self)->Result<std::sync::MutexGuard<'_,store::Store>,String>{self.ledger.lock().map_err(|_|"transport_store_poisoned".into())}
 pub(crate) fn reserve_process(&self,process:&ProcessBinding)->Result<store::ProcessRecord,String>{self.locked()?.reserve_process(process)}
 pub(crate) fn process_ready(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.process_ready(process,epoch)}
 pub(crate) fn process_draining(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.process_draining(process,epoch)}
 pub(crate) fn process_after_native_exit(&self,process:&ProcessBinding,epoch:u64)->Result<(),String>{self.locked()?.process_after_native_exit(process,epoch)}
 pub(crate) fn process(&self,plugin:&str)->Result<Option<store::ProcessRecord>,String>{self.locked()?.process(plugin)}
 pub(crate) fn play(&self,pin:&impl ProcessGrant,process:&ProcessBinding,epoch:u64,context:Option<&str>,root:&Path,key:&str,file:&str,volume:u8,deadline:u64,emit:impl FnOnce(&Payload)->Result<(),String>)->Result<store::Receipt,String>{
  let action=store::Action::Sound{asset_file:file.into(),volume};
  if !pin.permits(action.permission())||pin.binding()!=&process.package{return Err("capability_denied".into());}
  // A retry returns its committed receipt even if the asset has since gone.
  let mut ledger=self.locked()?;
  ledger.authorize(process,epoch)?;
  if let Some(receipt)=ledger.lookup(&process.package.id,key)?{
   if receipt.process!=process.into()||receipt.action!=action||receipt.playback.as_ref().is_none_or(|t|!t.matches_context(epoch,context)){return Err("idempotency_conflict".into());}return Ok(receipt);
  }
  if ledger.uncertain()?{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let now=now_ms();if deadline<=now||deadline-now>30000{return Err("sound_deadline_expired".into());}
  let (bytes,mime)=read_asset(root,file)?;
  let token=self.registry.admit(Some(epoch),context)?;
  let admission=match ledger.admit(process,key,action,Some(token.clone())){
   Ok(a)=>a,Err(e)=>{let _=self.registry.ack(token,Status::Cancelled);return Err(e);},
  };
  if !admission.fresh{let _=self.registry.ack(token,Status::Cancelled);return Ok(admission.receipt);}
  let qualified=format!("{}/{}",process.package.id,key);
  // Receipt/token is committed before native emit; ACK cannot free the registry
  // until its durable state is committed. Never wait for WebView under this lock.
  self.registry.bind(&token,&qualified)?;
  let payload=Payload{playback:token.clone(),event_id:key.into(),base64:BASE64.encode(bytes),mime,volume,correlation_id:key.into(),emitted_at_ms:now};
  if let Err(error)=emit(&payload){ledger.audio_ack(&process.package.id,key,&token,Status::Unknown)?;self.registry.ack(token,Status::Unknown)?;return Err(error);}
  Ok(admission.receipt)
 }
 pub(crate) fn owns(&self,token:&Token)->bool{matches!(self.registry.durable_key(token),Ok(Some(_)))}
 pub(crate) fn ack(&self,token:Token,status:Status)->Result<(),String>{
  let mut ledger=self.locked()?;
  let qualified=self.registry.durable_key(&token)?.ok_or("audio_not_bound")?;
  let (plugin,key)=qualified.split_once('/').ok_or("audio_not_bound")?;
  ledger.audio_ack(plugin,key,&token,status)?;self.registry.ack(token,status)
 }
 pub(crate) fn fence(&self,emit:impl FnOnce(Fence)->Result<(),String>)->Result<(),String>{
  let request=self.registry.begin()?;emit(request)?;
  self.registry.wait(Duration::from_secs(2))?;
  let quota=self.locked()?.quota()?;if quota.unknown!=0||quota.pending!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}Ok(())
 }
 pub(crate) fn confirm(&self,request:&Fence,stopped:bool)->Result<(),String>{self.registry.confirm(request,stopped)}
 pub(crate) fn reopen(&self)->Result<(),String>{self.registry.reopen()}
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
  fn permits(&self,cap:&str)->bool{self.allowed&&cap=="audio.play"}
 }
 fn pin()->(Pin,ProcessBinding){
  let binding=companion_plugin_protocol::PackageBinding{id:"example".into(),version:"1.0.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)};
  (Pin{binding:binding.clone(),allowed:true},ProcessBinding{generation:uuid::Uuid::new_v4().to_string(),package:binding})
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
  let token=receipt.playback.unwrap();assert_eq!(receipt.status,Status::Unknown);assert!(token.scope.session.is_none());
  audio.ack(token.clone(),Status::Playing).unwrap();std::fs::remove_file(root.path().join("jump.wav")).unwrap();
  let saved=audio.play(&pin,&process,epoch,None,root.path(),"sound:1","jump.wav",63,0,|_|panic!("duplicate was emitted")).unwrap();assert_eq!(saved.status,Status::Playing);
  let mut stale=token.clone();stale.scope.epoch=6;assert!(audio.ack(stale,Status::Completed).is_err());
  audio.ack(token,Status::Completed).unwrap();
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
  audio.fence(|request|{assert_eq!(request.playback_ids,vec![token.id.clone()]);audio.ack(token.clone(),Status::Cancelled)?;audio.confirm(&request,true)}).unwrap();
  assert!(audio.ack(token,Status::Playing).is_err());audio.reopen().unwrap();assert_eq!(audio.locked().unwrap().quota().unwrap().unknown,0);
 }
}
