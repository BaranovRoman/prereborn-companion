//! Commands of the installed Dota executable. Paths and package grants come
//! from the verified host launch, never from an iframe command or a GSI payload.
use crate::{gsi::server::Listener,history::History,sounds::{config, pipeline::Pipeline}};
use companion_plugin_protocol::{PackageBinding,SupervisedProcess};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{io::Read,path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Launch {
 data_root:PathBuf,
 generation:String,
 package:PackageBinding,
 capabilities:Vec<String>,
}
impl Launch {
 pub fn parse(text:&str)->Result<Self,String>{
  if text.len()>8192{return Err("launch_too_large".into());}
  let mut launch:Self=serde_json::from_str(text).map_err(|_|"invalid_launch")?;
  if !launch.data_root.is_absolute()||launch.data_root.symlink_metadata().map_err(|_|"data_root_unavailable")?.file_type().is_symlink(){return Err("invalid_data_root".into());}
  launch.data_root=launch.data_root.canonicalize().map_err(|_|"data_root_unavailable")?;
  if !launch.data_root.is_dir(){return Err("invalid_data_root".into());}
  if uuid::Uuid::parse_str(&launch.generation).is_err(){return Err("invalid_process_generation".into());}
  if launch.package.id!="dota2"||launch.package.version!=env!("CARGO_PKG_VERSION")
   ||[&launch.package.executable_hash,&launch.package.manifest_hash].iter().any(|h|h.len()!=64||!h.bytes().all(|b|b.is_ascii_hexdigit())){return Err("package_identity_mismatch".into());}
  if launch.capabilities.len()>8||launch.capabilities.iter().any(|c|!matches!(c.as_str(),"ui"|"data.legacy"|"data.private"|"audio.play"|"obs.scene"|"overlay.publish"|"backend.access")){return Err("capability_denied".into());}
  let executable=std::env::current_exe().map_err(|_|"executable_unavailable")?;
  let mut file=std::fs::File::open(executable).map_err(|_|"executable_unavailable")?;
  let mut hash=Sha256::new();let mut block=[0;65536];
  loop {let n=file.read(&mut block).map_err(|_|"executable_unavailable")?;if n==0{break;}hash.update(&block[..n]);}
  if format!("{:x}",hash.finalize())!=launch.package.executable_hash.to_ascii_lowercase(){return Err("executable_hash_mismatch".into());}
  Ok(launch)
 }
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct SoundIntent {operation_key:String,asset_file:String,volume:u8,deadline_ms:u64,context:Option<String>}

pub struct Worker {
 launch:Launch, history:Option<History>, listener:Option<Listener>, pipeline:Pipeline,
 last_error:Option<String>, processed:u64, last_sequence:Option<u64>, last_analysis:Option<Value>,last_gsi:Option<Value>,last_receipt:Option<companion_dota_domain::match_execution::Receipt>,
}
impl Worker {
 pub fn new(launch:Launch)->Self{Self{launch,history:None,listener:None,pipeline:Default::default(),last_error:None,processed:0,last_sequence:None,last_analysis:None,last_gsi:None,last_receipt:None}}
 pub fn status(&self)->Value{
  let history=self.history.as_ref();let active=history.is_some_and(History::active);
  json!({"prepared":history.is_some(),"active":active,"awaitingSession":active&&history.and_then(History::session).is_none(),
   "session":history.and_then(History::session),"epoch":history.and_then(History::epoch),"lastError":self.last_error,
   "gsi":self.listener.as_ref().map(|l|json!(l.status())).or(self.last_gsi.clone()),"processed":self.processed,"lastSequence":self.last_sequence,"analysis":self.last_analysis,
   "receipt":self.last_receipt})
 }
 /// Commands are serialized by the existing stdio loop: one coordinator, one
 /// listener, and no duplicate preparation even when the UI repeats a request.
 pub fn command(&mut self,name:&str,args:Value)->Result<Value,String>{
  let result=if name.starts_with("host."){
   crate::ui::empty(args).and_then(|_|self.command_inner(name))
  }else if !self.launch.capabilities.iter().any(|c|c=="ui"){Err("capability_denied".into())}
  else if name=="status"{crate::ui::empty(args).map(|_|self.status())}
  else if !self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){Err("capability_denied".into())}
  else{crate::ui::command(&self.launch.data_root,name,args)};
  if let Err(error)=&result{self.last_error=Some(error.clone());}
  result
 }
 fn command_inner(&mut self,name:&str)->Result<Value,String>{
  match name {
   "host.prepare"=>{
    if !self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){return Err("capability_denied".into());}
    if self.history.is_none(){self.history=Some(History::prepare(&self.launch.data_root)?);}
    Ok(self.status())
   },
   "host.activate"=>{
    if self.history.as_ref().is_some_and(History::active){return Err("already_active".into());}
    if self.history.is_none(){return Err("not_prepared".into());}
    config::load_verified(&self.launch.data_root.join("game-sounds-config.json"))?;
    let proof=SupervisedProcess::current(&self.launch.generation)?;
    // Bind closed admission before durable activation. Never consume cached GSI.
    let listener=Listener::bind()?;
    let mut permissions=vec![companion_dota_domain::match_execution::MATCH_EXECUTION_CAPABILITY.to_string()];
    for (host,internal) in [("audio.play","dota.sound.play"),("obs.scene","dota.obs.scene"),("overlay.publish","dota.overlay.update")]{if self.launch.capabilities.iter().any(|c|c==host){permissions.push(internal.into());}}
    self.history.as_mut().unwrap().activate(&proof,self.launch.package.clone(),permissions)?;
    if let Err(error)=listener.start_admission(){let _=self.history.as_mut().unwrap().drain();return Err(error);}
    self.pipeline.reset();self.listener=Some(listener);self.last_error=None;
    Ok(self.status())
   },
   "host.stop"=>{self.stop()?;Ok(self.status())},
   "host.poll"=>self.poll(),
   "host.status"=>Ok(self.status()),
   _=>Err("unsupported_worker_command".into()),
  }
 }
 pub fn stop(&mut self)->Result<(),String>{
  if let Some(listener)=self.listener.take(){self.last_gsi=Some(json!(listener.status()));}
  self.pipeline.reset();
  if let Some(history)=self.history.as_mut(){history.drain()?;}
  Ok(())
 }
 fn poll(&mut self)->Result<Value,String>{
  if let Some(listener)=self.listener.as_ref().filter(|l|l.failed()||l.status().rejected>0){
   let code=listener.status().last_error.unwrap_or("gsi_admission_failed").to_string();self.stop()?;return Err(code);
  }
  let result=self.frames();
  if result.is_err(){self.stop()?;}
  result
 }
 fn frames(&mut self)->Result<Value,String>{
  let mut sounds=Vec::new();
  // Bounded work per IPC command; the HTTP producer never waits for this loop.
  for _ in 0..8 {
   let Some(frame)=self.listener.as_ref().and_then(Listener::next)else{break;};
   let settings=config::load_verified(&self.launch.data_root.join("game-sounds-config.json"))?;
   let raw=serde_json::to_value(&frame.snapshot).map_err(|_|"projection_serialization_failed")?;
   let result=self.pipeline.frame(&raw,frame.sequence,frame.observed_at_ms,Default::default(),&settings,&self.launch.data_root.join("sounds"))?;
   if !result.sounds.is_empty()&&!self.launch.capabilities.iter().any(|c|c=="audio.play"){return Err("capability_denied".into());}
   let now=chrono::DateTime::from_timestamp_millis(i64::try_from(frame.observed_at_ms).map_err(|_|"gsi_time_invalid")?).ok_or("gsi_time_invalid")?;
   if let Some(receipt)=self.history.as_mut().ok_or("not_prepared")?.frame(frame.snapshot,now,frame.sequence)?{self.last_receipt=Some(receipt);}
   if sounds.len()+result.sounds.len()>32{return Err("sound_batch_exhausted".into());}
   for (index,sound) in result.sounds.into_iter().enumerate(){
    sounds.push(SoundIntent{operation_key:format!("sound:{}:{}:{index}",self.launch.generation,frame.sequence),asset_file:sound.asset.file_name,volume:sound.volume,deadline_ms:frame.observed_at_ms.saturating_add(2000),context:self.history.as_ref().and_then(History::session).map(str::to_string)});
   }
   self.last_analysis=Some(serde_json::to_value(result.analysis).map_err(|_|"analysis_serialization_failed")?);
   self.processed=self.processed.checked_add(1).ok_or("gsi_sequence_exhausted")?;self.last_sequence=Some(frame.sequence);
  }
  // These are intents, never playback receipts. The core must admit each one
  // durably and authenticate the frontend ACK before declaring playback done.
  Ok(json!({"status":self.status(),"soundIntents":sounds}))
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 fn worker(root:&std::path::Path)->Worker {
  Worker::new(Launch{data_root:root.into(),generation:uuid::Uuid::new_v4().to_string(),package:PackageBinding{id:"dota2".into(),version:env!("CARGO_PKG_VERSION").into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)},capabilities:vec!["data.legacy".into()]})
 }
 #[test]
 fn opening_and_polling_do_not_prepare_or_activate_and_manual_prepare_is_idempotent(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());
  assert_eq!(worker.command("host.status",Value::Null).unwrap()["prepared"],false);
  assert_eq!(worker.command("host.poll",Value::Null).unwrap()["soundIntents"],json!([]));
  assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
  assert_eq!(worker.command("host.activate",Value::Null).unwrap_err(),"not_prepared");
  worker.command("host.prepare",Value::Null).unwrap();
  let path=root.path().join("local-runtime.pre-external.sqlite3");let before=std::fs::read(&path).unwrap();
  worker.command("host.prepare",Value::Null).unwrap();assert_eq!(std::fs::read(path).unwrap(),before);
  assert_eq!(worker.status()["active"],false);assert_eq!(worker.status()["session"],Value::Null);
  assert_eq!(worker.command("host.prepare",json!({"dataRoot":"elsewhere"})).unwrap_err(),"unexpected_command_payload");
 }
 #[cfg(not(windows))]
 #[test]
 fn native_proof_failure_stays_visible_and_does_not_start_listener_or_write_owner(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.command("host.prepare",Value::Null).unwrap();
  assert_eq!(worker.command("host.activate",Value::Null).unwrap_err(),"native_supervision_unsupported");
  assert_eq!(worker.status()["lastError"],"native_supervision_unsupported");assert_eq!(worker.status()["gsi"],Value::Null);
  assert_eq!(worker.status()["active"],false);assert_eq!(worker.status()["epoch"],Value::Null);
 }
}
