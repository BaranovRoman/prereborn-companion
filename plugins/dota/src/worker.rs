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
pub struct SoundIntent {operation_key:String,asset_file:String,volume:u8,deadline_ms:u64,context:Option<String>,#[serde(skip_serializing_if="Option::is_none")]speech:Option<String>}
fn retain_context(sounds:&mut Vec<SoundIntent>,context:Option<&str>)->u64{
 let before=sounds.len();sounds.retain(|s|s.context.as_deref()==context);(before-sounds.len())as u64
}

#[derive(Default,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct PollContext{stream_observation:Option<companion_plugin_protocol::obs::StreamObservation>,scene_observation:Option<companion_plugin_protocol::obs::SceneObservation>,scene_receipt:Option<companion_plugin_protocol::obs::SceneReceipt>}

pub struct Worker {
 pending_backend:Option<companion_plugin_protocol::backend::Request>,
 launch:Launch, history:Option<History>, listener:Option<Listener>, pipeline:Pipeline,
 overlay:Option<crate::overlay::server::Server>,last_overlay_at:Option<std::time::Instant>,scene:companion_dota_domain::broadcast_state::BroadcastState,
 selected_directory:Option<PathBuf>,obs:crate::obs::Controller,reminder:companion_dota_domain::draft_reminder::Tracker,
 dropped_sound_intents:u64,audio_sequence:u64,speech_sequence:u64,
 last_lifecycle_at:Option<std::time::Instant>,last_watchdog_at:Option<std::time::Instant>,stream_ended:bool,streaming:Option<bool>,
 next_account_at:Option<std::time::Instant>,account_request_sequence:u64,account_failures:u32,backend_error:Option<String>,account:Option<Value>,
 next_sync_at:Option<std::time::Instant>,pending_sync:Option<companion_dota_storage::local_runtime::sync::OutboxRow>,
 backend_updates:u64,next_corrections_at:Option<std::time::Instant>,pending_corrections:Option<String>,
 detected_sounds:u64,planned_sounds:u64,last_sound_signal:Option<Value>,last_sound_operation:Option<String>,
 last_error:Option<String>, processed:u64, last_sequence:Option<u64>, last_analysis:Option<Value>,last_gsi:Option<Value>,last_receipt:Option<companion_dota_domain::match_execution::Receipt>,
}
impl Worker {
 pub fn new(launch:Launch)->Self{Self{pending_backend:None,launch,history:None,listener:None,pipeline:Default::default(),overlay:None,last_overlay_at:None,scene:companion_dota_domain::broadcast_state::BroadcastState::BetweenMatches,selected_directory:None,obs:Default::default(),reminder:Default::default(),dropped_sound_intents:0,audio_sequence:0,speech_sequence:0,last_lifecycle_at:None,last_watchdog_at:None,stream_ended:false,streaming:None,next_account_at:None,account_request_sequence:0,account_failures:0,backend_error:None,account:None,next_sync_at:None,pending_sync:None,backend_updates:0,next_corrections_at:None,pending_corrections:None,detected_sounds:0,planned_sounds:0,last_sound_signal:None,last_sound_operation:None,last_error:None,processed:0,last_sequence:None,last_analysis:None,last_gsi:None,last_receipt:None}}
 pub fn status(&self)->Value{
  let history=self.history.as_ref();let active=history.is_some_and(History::active);
  json!({"prepared":history.is_some(),"active":active,"awaitingSession":active&&history.and_then(History::session).is_none(),
   "session":history.and_then(History::session),"epoch":history.and_then(History::epoch),"lastError":self.last_error,"streaming":self.streaming,"streamEnded":self.stream_ended,"obsError":self.obs.error,"obsReceipt":self.obs.last_receipt,"backendError":self.backend_error,"backendUpdates":self.backend_updates,
   "gsi":self.listener.as_ref().map(|l|json!(l.status())).or(self.last_gsi.clone()),"processed":self.processed,"lastSequence":self.last_sequence,"analysis":self.last_analysis,
   "receipt":self.last_receipt,"context":self.effect_context(),"droppedSoundIntents":self.dropped_sound_intents,"detectedSounds":self.detected_sounds,"plannedSounds":self.planned_sounds,"lastSoundSignal":self.last_sound_signal,"lastSoundOperation":self.last_sound_operation,"overlay":self.overlay.as_ref().map(|s|json!({"running":!s.closed(),"clients":s.clients()}))})
 }
 fn effect_context(&self)->Option<String>{self.history.as_ref().and_then(History::session).map(|id|if self.stream_ended{format!("{id}:ended")}else{id.to_string()})}
 pub fn backend_request(&mut self)->Result<Option<companion_plugin_protocol::backend::Request>,String>{
  if let Some(request)=&self.pending_backend{return Ok(Some(request.clone()));}
  let next=self.next_backend_request()?;self.pending_backend=next.clone();Ok(next)
 }
 fn next_backend_request(&mut self)->Result<Option<companion_plugin_protocol::backend::Request>,String>{
  use companion_plugin_protocol::backend::Request;
  if !self.launch.capabilities.iter().any(|c|c=="backend.access")||!self.history.as_ref().is_some_and(History::active){return Ok(None);}
  if self.next_account_at.is_some_and(|at|at>std::time::Instant::now()){
   if self.backend_error.as_deref()==Some("account_not_connected"){return Ok(None);}
   if self.next_corrections_at.is_none_or(|at|at<=std::time::Instant::now()){
    if self.pending_corrections.is_some(){return Err("backend_request_in_flight".into());}
    let since=self.history.as_mut().unwrap().corrections_since()?;
    self.next_corrections_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(60));
    self.account_request_sequence=self.account_request_sequence.checked_add(1).ok_or("backend_sequence_exhausted")?;
    self.pending_corrections=Some(since.clone());
    return Ok(Some(Request{resource:"corrections".into(),operation_key:format!("corrections:{}:{}",self.launch.generation,self.account_request_sequence),query:[("since".into(),since)].into(),body:None}));
   }
   if self.next_sync_at.is_some_and(|at|at>std::time::Instant::now()){return Ok(None);}
   self.next_sync_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(2));
   if self.pending_sync.is_some(){return Err("backend_request_in_flight".into());}
   let Some(row)=self.history.as_mut().unwrap().pending_sync()?else{return Ok(None);};
   let payload:Value=match serde_json::from_str(&row.payload){Ok(value)=>value,Err(_)=>{self.history.as_mut().unwrap().settle_sync(&row,"rejected")?;self.backend_error=Some("outbox_payload_invalid".into());return Ok(None);}};
   let request=Request{resource:"sync-event".into(),operation_key:format!("sync:{}:{}",row.id,row.attempts),query:Default::default(),body:Some(json!({"eventId":row.id,"eventType":row.event_type,"payload":payload}))};
   request.validate()?;self.pending_sync=Some(row);return Ok(Some(request));
  }
  self.account_request_sequence=self.account_request_sequence.checked_add(1).ok_or("backend_sequence_exhausted")?;
  self.next_account_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(60));
  Ok(Some(companion_plugin_protocol::backend::Request{resource:"account".into(),operation_key:format!("account:{}:{}",self.launch.generation,self.account_request_sequence),query:Default::default(),body:None}))
 }
 pub fn backend_response(&mut self,request:&companion_plugin_protocol::backend::Request,response:companion_plugin_protocol::backend::Response)->Result<(),String>{
  if self.pending_backend.as_ref().and_then(|r|serde_json::to_value(r).ok())!=serde_json::to_value(request).ok(){return Err("backend_response_scope_mismatch".into());}
  if response.operation_key!=request.operation_key{return Err("backend_response_scope_mismatch".into());}
  if response.error.as_deref()==Some("backend_request_pending"){
   if response.status.is_some()||response.body.is_some(){return Err("invalid_backend_pending_response".into());}return Ok(());
  }
  self.pending_backend=None;
  if request.resource=="account"{self.account_response(request,response)?;self.backend_updates=self.backend_updates.checked_add(1).ok_or("backend_sequence_exhausted")?;return Ok(());}
  if request.resource=="corrections"{
   let since=self.pending_corrections.take().ok_or("backend_request_not_pending")?;
   if request.query.get("since")!=Some(&since){return Err("backend_response_scope_mismatch".into());}
   if response.error.is_none()&&response.status.is_some_and(|s|(200..300).contains(&s)){
    let batch=response.body.as_ref().and_then(|v|v.get("corrections")).cloned().and_then(|v|serde_json::from_value::<Vec<companion_dota_storage::local_runtime::sync::Correction>>(v).ok());
    if let Some(batch)=batch{self.history.as_mut().ok_or("not_prepared")?.apply_corrections(&since,&batch)?;self.backend_error=None;}else{self.backend_error=Some("backend_corrections_invalid".into());}
   }else{self.backend_error=Some(response.error.unwrap_or_else(||"backend_corrections_unavailable".into()));}
   self.backend_updates=self.backend_updates.checked_add(1).ok_or("backend_sequence_exhausted")?;return Ok(());
  }
  if request.resource!="sync-event"{return Err("backend_response_scope_mismatch".into());}
  let row=self.pending_sync.take().ok_or("backend_request_not_pending")?;
  if request.operation_key!=format!("sync:{}:{}",row.id,row.attempts){return Err("backend_response_scope_mismatch".into());}
  let delivery=if response.error.is_none()&&response.status.is_some_and(|s|(200..300).contains(&s)){"delivered"}
   else if response.status.is_some_and(|s|(400..500).contains(&s)){"rejected"}
   else if response.error.as_deref().is_some_and(|e|matches!(e,"account_not_connected"|"backend_client_unavailable"|"backend_resource_denied"|"account_state_unavailable")){"retryable"}else{"unknown"};
  self.history.as_mut().ok_or("not_prepared")?.settle_sync(&row,delivery)?;
  self.backend_updates=self.backend_updates.checked_add(1).ok_or("backend_sequence_exhausted")?;
  self.backend_error=if delivery=="delivered"{None}else{Some(format!("backend_sync_{delivery}"))};Ok(())
 }
 pub fn account_response(&mut self,request:&companion_plugin_protocol::backend::Request,response:companion_plugin_protocol::backend::Response)->Result<(),String>{
  if response.operation_key!=request.operation_key||request.resource!="account"||!self.launch.capabilities.iter().any(|c|c=="backend.access"){return Err("backend_response_scope_mismatch".into());}
  let error=if response.error.is_some(){response.error}else if !response.status.is_some_and(|s|(200..300).contains(&s)){Some("backend_http_rejected".into())}else{None};
  if let Some(error)=error{self.backend_unavailable(error);return Ok(());}
  let Some(account)=response.body.filter(|v|v.is_object()&&companion_plugin_protocol::backend::public_response(v))else{self.backend_unavailable("account_settings_invalid".into());return Ok(());};
  let mode=account.get("gameMode").and_then(Value::as_str);let rating=account.get("currentMmr").and_then(Value::as_i64);
  if mode.is_some_and(|m|!matches!(m,"ranked"|"unranked"))||rating.is_some_and(|r|!(0..=30000).contains(&r)){self.backend_unavailable("account_settings_invalid".into());return Ok(());}
  self.history.as_mut().ok_or("not_prepared")?.refresh_account(mode,rating)?;
  self.account=Some(account);self.backend_error=None;self.account_failures=0;Ok(())
 }
 fn backend_unavailable(&mut self,error:String){self.backend_error=Some(error);self.account_failures=self.account_failures.saturating_add(1);self.next_account_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(2u64.saturating_pow(self.account_failures.min(5)).min(60)));}
 pub fn backend_failure(&mut self,error:String)->String{let error=self.close_after_error(error);self.last_error=Some(error.clone());error}
 /// Commands are serialized by the existing stdio loop: one coordinator, one
 /// listener, and no duplicate preparation even when the UI repeats a request.
 pub fn command(&mut self,name:&str,args:Value)->Result<Value,String>{
  let result=if name=="host.directory"{
   self.select_directory(args)
  }else if name=="host.poll"{
   serde_json::from_value(if args.is_null(){json!({})}else{args}).map_err(|_|"invalid_poll_context".to_string()).and_then(|context|self.poll(context))
  }else if name.starts_with("host."){
   crate::ui::empty(args).and_then(|_|self.command_inner(name))
  }else if !self.launch.capabilities.iter().any(|c|c=="ui"){Err("capability_denied".into())}
  else if name=="status"{crate::ui::empty(args).map(|_|self.status())}
  else if !self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){Err("capability_denied".into())}
  else if name=="history.summary"{crate::ui::empty(args).and_then(|_|self.history.as_ref().ok_or_else(||"not_prepared".to_string())).and_then(History::summary).and_then(|summary|serde_json::to_value(summary).map_err(|_|"history_encoding_failed".into()))}
  else if name=="history.sync"{crate::ui::empty(args).and_then(|_|self.history.as_ref().ok_or_else(||"not_prepared".to_string())).and_then(History::sync_status).and_then(|status|serde_json::to_value(status).map_err(|_|"history_encoding_failed".into()))}
  else if name=="history.context"{crate::ui::empty(args).and_then(|_|self.history.as_ref().ok_or_else(||"not_prepared".to_string())).and_then(History::edit_context)}
  else if name=="history.edit"{self.history_edit(args)}
  else if matches!(name,"gsi.find"|"gsi.install"){self.gsi_setup(name,args)}
  else{crate::ui::command(&self.launch.data_root,name,args)};
  if name.starts_with("host."){
   if let Err(error)=&result{self.last_error=Some(error.clone());}
   else if matches!(name,"host.prepare"|"host.activate"|"host.directory"){self.last_error=None;}
  }
  result
 }
 fn history_edit(&mut self,args:Value)->Result<Value,String>{
  let request=serde_json::from_value(args).map_err(|_|"invalid_history_edit")?;
  let history=self.history.as_mut().ok_or("not_prepared")?;
  let receipt=history.edit(request)?;
  self.stream_ended=history.session_ended()?;
  self.last_lifecycle_at=None;
  // Committed changes are visible through the same real summary/revisions on
  // the next poll. A renderer failure cannot cause this edit to be replayed.
  serde_json::to_value(receipt).map_err(|_|"history_encoding_failed".into())
 }
 fn select_directory(&mut self,args:Value)->Result<Value,String>{
  #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Selection{path:PathBuf}
  if !self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){return Err("capability_denied".into());}
  let selection:Selection=serde_json::from_value(args).map_err(|_|"invalid_directory_selection")?;
  if !selection.path.is_absolute()||selection.path.as_os_str().to_string_lossy().len()>4096{return Err("invalid_directory_selection".into());}
  let path=selection.path.canonicalize().map_err(|_|"dota_directory_unavailable")?;
  if !crate::gsi::finder::validate_dota_path(path.to_str().ok_or("dota_directory_invalid")?){return Err("dota_directory_invalid".into());}
  self.selected_directory=Some(path);self.gsi_setup("gsi.find",json!({}))
 }
 fn gsi_setup(&mut self,name:&str,args:Value)->Result<Value,String>{
  crate::ui::empty(args)?;
  let path=self.selected_directory.clone().or_else(||crate::gsi::finder::find_dota_auto().map(PathBuf::from));
  let Some(path)=path else{return if name=="gsi.install"{Err("dota_directory_not_found".into())}else{Ok(json!({"found":false,"installed":false}))};};
  let path=path.canonicalize().map_err(|_|"dota_directory_unavailable")?;let text=path.to_str().ok_or("dota_directory_invalid")?;
  if !crate::gsi::finder::validate_dota_path(text){return Err("dota_directory_invalid".into());}
  let target=crate::gsi::config::gsi_config_path(text);
  if name=="gsi.install"{
   if target.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink())||!path.join("game/dota").canonicalize().map_err(|_|"dota_directory_invalid")?.starts_with(&path){return Err("gsi_directory_invalid".into());}
   crate::gsi::config::install_gsi(text).map_err(|_|"gsi_config_write_failed")?;
  }
  Ok(json!({"found":true,"path":text,"installed":target.is_file()}))
 }
 fn command_inner(&mut self,name:&str)->Result<Value,String>{
  match name {
   "host.prepare"=>{
    if !self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){return Err("capability_denied".into());}
    if self.history.as_ref().is_some_and(History::active){return Err("already_active".into());}
    if let Some(history)=self.history.as_ref(){
     if let Err(error)=history.confirm_prepared(){self.history=None;return Err(error);}
    }else{self.history=Some(History::prepare(&self.launch.data_root)?);}
    self.last_error=None;
    Ok(self.status())
   },
   "host.activate"=>{
    if self.history.as_ref().is_some_and(History::active){return Err("already_active".into());}
    if self.history.is_none(){return Err("not_prepared".into());}
    config::load_verified(&self.launch.data_root.join("game-sounds-config.json"))?;
    let proof=SupervisedProcess::current(&self.launch.generation)?;
    // Bind closed admission before durable activation. Never consume cached GSI.
    let listener=Listener::bind()?;
    let overlay=if self.launch.capabilities.iter().any(|c|c=="overlay.publish"){Some(crate::overlay::server::Server::bind(&self.launch.data_root,&self.launch.package)?)}else{None};
    let mut permissions=vec![companion_dota_domain::match_execution::MATCH_EXECUTION_CAPABILITY.to_string()];
    for (host,internal) in [("audio.play","dota.sound.play"),("obs.scene","dota.obs.scene"),("overlay.publish","dota.overlay.update")]{if self.launch.capabilities.iter().any(|c|c==host){permissions.push(internal.into());}}
    if self.launch.capabilities.iter().any(|c|c=="backend.access"){permissions.push("backend.access".into());}
    self.history.as_mut().unwrap().activate(&proof,self.launch.package.clone(),permissions)?;
    if let Err(error)=listener.start_admission(){let _=self.history.as_mut().unwrap().drain();return Err(error);}
    self.pipeline.reset();self.listener=Some(listener);self.overlay=overlay;self.last_overlay_at=None;self.last_lifecycle_at=None;self.last_watchdog_at=None;self.stream_ended=false;self.streaming=None;self.scene=companion_dota_domain::broadcast_state::BroadcastState::BetweenMatches;self.last_error=None;
    if let Err(error)=self.publish_overlay(){return Err(self.close_after_error(error));}
    Ok(self.status())
   },
   "host.stop"=>{self.stop()?;Ok(self.status())},
   "host.status"=>Ok(self.status()),
   _=>Err("unsupported_worker_command".into()),
  }
 }
 pub fn stop(&mut self)->Result<(),String>{
  self.overlay.take();self.last_overlay_at=None;
  if let Some(listener)=self.listener.take(){self.last_gsi=Some(json!(listener.status()));}
  self.pipeline.reset();
  if let Some(history)=self.history.as_mut(){history.drain()?;}
  Ok(())
 }
 fn poll(&mut self,context:PollContext)->Result<Value,String>{
  if let Some(receipt)=context.scene_receipt{let now=u64::try_from(chrono::Utc::now().timestamp_millis()).map_err(|_|"clock_unavailable")?;self.obs.receipt(receipt,now)?;}
  if self.overlay.as_ref().is_some_and(|s|s.closed()){return Err(self.close_after_error("overlay_listener_failed".into()));}
  if let Some(listener)=self.listener.as_ref().filter(|l|l.failed()||l.status().rejected>0){
   let code=listener.status().last_error.unwrap_or("gsi_admission_failed").to_string();return Err(self.close_after_error(code));
  }
  let now=chrono::Utc::now();
  let now_ms=u64::try_from(now.timestamp_millis()).map_err(|_|"clock_unavailable")?;
  let streaming=if self.launch.capabilities.iter().any(|c|c=="obs.scene"){context.stream_observation.and_then(|o|o.fresh_streaming(now_ms))}else{None};
  let changed=self.streaming!=streaming;self.streaming=streaming;
  if self.history.as_ref().is_some_and(History::active)&&(changed||self.last_lifecycle_at.is_none_or(|at|at.elapsed()>=std::time::Duration::from_secs(2))){
   let sweep=self.last_watchdog_at.is_none_or(|at|at.elapsed()>=std::time::Duration::from_secs(60));
   match self.history.as_mut().unwrap().tick(streaming,now,sweep){
    Ok(ended)=>{if let Some(ended)=ended{self.stream_ended=ended;}self.last_lifecycle_at=Some(std::time::Instant::now());if sweep{self.last_watchdog_at=self.last_lifecycle_at;}},
    Err(error)=>return Err(self.close_after_error(error)),
   }
  }
  let before=self.processed;let mut result=self.frames();
  if let Ok(batch)=&mut result{
   let effect_context=self.effect_context();
   let intent=if self.launch.capabilities.iter().any(|c|c=="obs.scene")&&self.history.as_ref().is_some_and(History::active){self.obs.plan(context.scene_observation.as_ref(),self.scene,self.stream_ended,false,effect_context.as_deref(),now_ms)?}else{None};
   batch["sceneIntent"]=serde_json::to_value(intent).map_err(|_|"obs_intent_encoding_failed")?;batch["status"]=self.status();
  }
  if result.is_ok()&&self.overlay.is_some()&&(before!=self.processed||self.last_overlay_at.is_none_or(|at|at.elapsed()>=std::time::Duration::from_secs(1))){
   if let Err(error)=self.publish_overlay(){return Err(self.close_after_error(error));}
  }
  result.map_err(|error|self.close_after_error(error))
 }
 fn close_after_error(&mut self,error:String)->String{
  match self.stop(){Ok(())=>error,Err(drain)=>format!("{error}; drain: {drain}")}
 }
 fn frames(&mut self)->Result<Value,String>{
  let mut sounds=Vec::new();
  // Bounded work per IPC command; the HTTP producer never waits for this loop.
  for _ in 0..8 {
   let Some(frame)=self.listener.as_ref().and_then(Listener::next)else{break;};
   let settings=config::load_verified(&self.launch.data_root.join("game-sounds-config.json"))?;
   let raw=serde_json::to_value(&frame.snapshot).map_err(|_|"projection_serialization_failed")?;
   self.scene=companion_dota_domain::broadcast_state::BroadcastState::from_gsi(&raw);
   let result=self.pipeline.frame(&raw,frame.sequence,frame.observed_at_ms,Default::default(),&settings,&self.launch.data_root.join("sounds"))?;
   self.detected_sounds=self.detected_sounds.checked_add(result.analysis.sound_signals.len() as u64).ok_or("sound_counter_exhausted")?;
   self.planned_sounds=self.planned_sounds.checked_add(result.sounds.len() as u64).ok_or("sound_counter_exhausted")?;
   if let Some(signal)=result.analysis.sound_signals.last(){self.last_sound_signal=Some(json!({"eventId":signal.id,"kind":signal.kind,"sequence":frame.sequence}));}
   if !result.sounds.is_empty()&&!self.launch.capabilities.iter().any(|c|c=="audio.play"){return Err("capability_denied".into());}
   let now=chrono::DateTime::from_timestamp_millis(i64::try_from(frame.observed_at_ms).map_err(|_|"gsi_time_invalid")?).ok_or("gsi_time_invalid")?;
   if let Some(receipt)=self.history.as_mut().ok_or("not_prepared")?.frame(frame.snapshot,now,frame.sequence)?{self.last_receipt=Some(receipt);}
   if self.reminder.observe(self.scene,self.streaming.is_some(),self.streaming){
    if !self.launch.capabilities.iter().any(|c|c=="audio.play"){return Err("capability_denied".into());}
    self.speech_sequence=self.speech_sequence.checked_add(1).filter(|n|*n<=i64::MAX as u64).ok_or("sound_counter_exhausted")?;let key=format!("speech:{}",self.speech_sequence);self.last_sound_operation=Some(key.clone());
    sounds.push(SoundIntent{operation_key:key,asset_file:String::new(),volume:100,deadline_ms:frame.observed_at_ms.saturating_add(2000),context:self.effect_context(),speech:Some("Стрим не запущен".into())});
   }
   if sounds.len()+result.sounds.len()>32{return Err("sound_batch_exhausted".into());}
   for sound in result.sounds{
    self.audio_sequence=self.audio_sequence.checked_add(1).filter(|n|*n<=i64::MAX as u64).ok_or("sound_counter_exhausted")?;let key=format!("audio:{}",self.audio_sequence);self.last_sound_operation=Some(key.clone());
    sounds.push(SoundIntent{operation_key:key,asset_file:sound.asset.file_name,volume:sound.volume,deadline_ms:frame.observed_at_ms.saturating_add(2000),context:self.effect_context(),speech:None});
   }
   self.last_analysis=Some(serde_json::to_value(result.analysis).map_err(|_|"analysis_serialization_failed")?);
   self.processed=self.processed.checked_add(1).ok_or("gsi_sequence_exhausted")?;self.last_sequence=Some(frame.sequence);
  }
  // These are intents, never playback receipts. The core must admit each one
  // durably and authenticate the frontend ACK before declaring playback done.
  // A batch may cross demo/match/session boundaries; old-context cues must
  // not be admitted after the final committed session has changed.
  let dropped=retain_context(&mut sounds,self.effect_context().as_deref());
  self.dropped_sound_intents=self.dropped_sound_intents.checked_add(dropped).ok_or("sound_counter_exhausted")?;
  Ok(json!({"status":self.status(),"soundIntents":sounds}))
 }
 fn publish_overlay(&mut self)->Result<(),String>{
  let Some(server)=&self.overlay else{return Ok(());};let root=&self.launch.data_root;
  let layout=crate::overlay::saved(root,"overlay-layout.json",1024*1024)?;let queue=crate::overlay::saved(root,"queue-settings.json",128*1024)?;
  let account=if self.account.is_some(){self.account.clone()}else{crate::overlay::saved(root,"account-overlay-data.json",128*1024)?};
  let scene=companion_dota_domain::broadcast_state::resolve(self.scene,self.stream_ended,false);
  let snapshot=crate::overlay::OverlayStateSnapshot{scene,updated_at:chrono::Utc::now().to_rfc3339(),session:self.history.as_ref().ok_or("not_prepared")?.summary()?,layout_version:0,account,twitch_chat:None,overlay_visible:true,opendota_favorite_heroes:None,opendota_radar:None,quiz:None};
  server.publish(&snapshot,layout,queue)?;self.last_overlay_at=Some(std::time::Instant::now());Ok(())
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn batching_never_releases_old_context_sounds_and_preserves_the_order_of_current_intents(){
  let cue=|key:&str,context:Option<&str>|SoundIntent{operation_key:key.into(),asset_file:"managed.wav".into(),volume:63,deadline_ms:100,context:context.map(str::to_string),speech:None};
  let mut sounds=vec![cue("demo",None),cue("old",Some("old-session")),cue("first",Some("resolved-session")),cue("second",Some("resolved-session"))];
  assert_eq!(retain_context(&mut sounds,Some("resolved-session")),2);assert_eq!(sounds.iter().map(|s|s.operation_key.as_str()).collect::<Vec<_>>(),vec!["first","second"]);
  assert_eq!(retain_context(&mut sounds,None),2);assert!(sounds.is_empty());
 }
 fn worker(root:&std::path::Path)->Worker {
  Worker::new(Launch{data_root:root.into(),generation:uuid::Uuid::new_v4().to_string(),package:PackageBinding{id:"dota2".into(),version:env!("CARGO_PKG_VERSION").into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)},capabilities:vec!["data.legacy".into()]})
 }
 #[test]fn a_pending_host_request_keeps_the_same_identity_and_does_not_block_gsi_poll(){
  use companion_plugin_protocol::backend::{Request,Response};
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());
  let request=Request{resource:"account".into(),operation_key:"account:pending:1".into(),query:Default::default(),body:None};
  worker.pending_backend=Some(request.clone());
  for _ in 0..3{
   assert_eq!(worker.backend_request().unwrap().unwrap().operation_key,request.operation_key);
   worker.backend_response(&request,Response::failed(&request,"backend_request_pending")).unwrap();
   assert_eq!(worker.command("host.poll",Value::Null).unwrap()["soundIntents"],json!([]));
   assert_eq!(worker.backend_updates,0);assert!(worker.pending_backend.is_some());
  }
  let mut wrong=request.clone();wrong.query.insert("changed".into(),"1".into());
  assert_eq!(worker.backend_response(&wrong,Response::failed(&wrong,"backend_request_pending")).unwrap_err(),"backend_response_scope_mismatch");
  assert!(worker.pending_backend.is_some());
 }
 #[test]
 fn opening_and_polling_do_not_prepare_or_activate_and_manual_prepare_is_idempotent(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());
  assert_eq!(worker.command("host.status",Value::Null).unwrap()["prepared"],false);
  assert_eq!(worker.command("host.poll",Value::Null).unwrap()["soundIntents"],json!([]));
  assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
  assert_eq!(worker.command("host.activate",Value::Null).unwrap_err(),"not_prepared");
  assert_eq!(worker.command("host.prepare",Value::Null).unwrap()["lastError"],Value::Null);
  let path=root.path().join("local-runtime.pre-external.sqlite3");let before=std::fs::read(&path).unwrap();
  worker.command("host.prepare",Value::Null).unwrap();assert_eq!(std::fs::read(path).unwrap(),before);
  assert_eq!(worker.status()["active"],false);assert_eq!(worker.status()["session"],Value::Null);
  assert_eq!(worker.command("host.prepare",json!({"dataRoot":"elsewhere"})).unwrap_err(),"unexpected_command_payload");
 }
 #[test]
 fn manual_gsi_setup_uses_the_host_selected_directory_and_cannot_prepare_history_or_take_a_ui_path(){
  let root=tempfile::tempdir().unwrap();let game=tempfile::tempdir().unwrap();std::fs::create_dir_all(game.path().join("game/dota")).unwrap();
  let mut worker=worker(root.path());worker.launch.capabilities.push("ui".into());
  assert!(worker.command("host.directory",json!({"path":game.path(),"dataRoot":root.path()})).is_err());
  let selected=worker.command("host.directory",json!({"path":game.path()})).unwrap();assert_eq!(selected["found"],true);assert_eq!(selected["installed"],false);
  assert_eq!(worker.command("gsi.install",json!({"path":"arbitrary"})).unwrap_err(),"unexpected_command_payload");
  assert_eq!(worker.command("gsi.install",json!({})).unwrap()["installed"],true);
  assert_eq!(worker.command("gsi.find",json!({})).unwrap()["path"],json!(game.path().canonicalize().unwrap()));
  assert_eq!(worker.status()["prepared"],false);assert_eq!(worker.status()["active"],false);assert_eq!(worker.status()["session"],Value::Null);assert_eq!(worker.status()["gsi"],Value::Null);
  assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
  let file=crate::gsi::config::gsi_config_path(game.path().to_str().unwrap());assert!(std::fs::read_to_string(file).unwrap().contains("127.0.0.1:3665"));
 }
 #[test]
 fn repeated_prepare_revalidates_the_saved_backup_and_never_replaces_a_damaged_copy(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.command("host.prepare",json!({})).unwrap();
  let backup=root.path().join("local-runtime.pre-external.sqlite3");std::fs::write(&backup,b"damaged backup fixture").unwrap();
  let error=worker.command("host.prepare",json!({})).unwrap_err();assert_eq!(worker.status()["prepared"],false);assert_eq!(worker.status()["lastError"],json!(error));
  assert!(worker.command("host.prepare",json!({})).is_err());assert_eq!(std::fs::read(backup).unwrap(),b"damaged backup fixture");
  assert_eq!(worker.status()["session"],Value::Null);assert_eq!(worker.status()["active"],false);
 }
 #[test]
 fn history_edits_require_actual_activation_and_cannot_gain_ownership_from_ui_arguments(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.launch.capabilities.push("ui".into());
  assert_eq!(worker.command("history.context",json!({})).unwrap_err(),"not_prepared");worker.command("host.prepare",json!({})).unwrap();
  let context=worker.command("history.context",json!({})).unwrap();assert_eq!(context["active"],false);assert_eq!(context["session"],Value::Null);
  let request=json!({"operationKey":format!("manual:{}",uuid::Uuid::new_v4()),"expectedRevision":context["revision"],"session":null,"edit":{"kind":"rating","rating":1234}});
  assert_eq!(worker.command("history.edit",request.clone()).unwrap_err(),"worker_inactive");
  let mut forged=request;forged["epoch"]=json!(1);assert_eq!(worker.command("history.edit",forged).unwrap_err(),"invalid_history_edit");
  assert_eq!(worker.command("history.summary",json!({})).unwrap()["hasSession"],false);
  assert_eq!(worker.status()["active"],false);assert_eq!(worker.status()["gsi"],Value::Null);
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
