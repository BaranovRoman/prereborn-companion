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
  if launch.capabilities.len()>8||launch.capabilities.iter().any(|c|!matches!(c.as_str(),"ui"|"data.legacy"|"data.private"|"audio.play"|"obs.scene"|"overlay.publish"|"backend.access"|"chat.read")){return Err("capability_denied".into());}
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
/// Public live passthrough for the unchanged backend presence/scene contract.
/// Built from the strict projection only: fixed scalar fields, no raw GSI JSON.
fn live_state(snapshot:&companion_dota_domain::contracts::ReplayGsi)->Value{
 let mut payload=serde_json::Map::new();
 if let Some(p)=&snapshot.player{payload.insert("player".into(),json!({"activity":p.activity,"team_name":p.team_name,"kills":p.kills,"deaths":p.deaths,"assists":p.assists}));}
 if let Some(m)=&snapshot.map{payload.insert("map".into(),json!({"game_state":m.game_state,"matchid":m.matchid,"win_team":m.win_team}));}
 if let Some(h)=&snapshot.hero{payload.insert("hero".into(),json!({"id":h.id}));}
 Value::Object(payload)
}
fn retain_context(sounds:&mut Vec<SoundIntent>,context:Option<&str>)->u64{
 let before=sounds.len();sounds.retain(|s|s.context.as_deref()==context);(before-sounds.len())as u64
}

#[derive(Default,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct PollContext{chat:Option<companion_plugin_protocol::chat::Snapshot>,stream_observation:Option<companion_plugin_protocol::obs::StreamObservation>,scene_observation:Option<companion_plugin_protocol::obs::SceneObservation>,scene_receipt:Option<companion_plugin_protocol::obs::SceneReceipt>}

pub struct Worker {
 chat:Option<companion_plugin_protocol::chat::Snapshot>,
 overlay_hotkey:crate::overlay::hotkey::Controller,overlay_visible:bool,show_summary:bool,
 pending_backend:Option<companion_plugin_protocol::backend::Request>,
 obsolete_overlay_request:Option<String>,
 overlay_refresh:std::collections::BTreeMap<String,std::time::Instant>,overlay_resources:std::collections::BTreeMap<String,Value>,overlay_backend_error:Option<String>,
 launch:Launch, history:Option<History>, listener:Option<Listener>, pipeline:Pipeline,
 overlay:Option<crate::overlay::server::Server>,last_overlay_at:Option<std::time::Instant>,scene:companion_dota_domain::broadcast_state::BroadcastState,
 selected_directory:Option<PathBuf>,obs:crate::obs::Controller,reminder:companion_dota_domain::draft_reminder::Tracker,
 dropped_sound_intents:u64,audio_sequence:u64,speech_sequence:u64,
 last_lifecycle_at:Option<std::time::Instant>,last_watchdog_at:Option<std::time::Instant>,stream_ended:bool,streaming:Option<bool>,
 next_account_at:Option<std::time::Instant>,account_request_sequence:u64,account_failures:u32,backend_error:Option<String>,account:Option<Value>,
 live_gsi:Option<(u64,Value)>,gsi_sent:u64,pending_gsi:Option<u64>,next_gsi_at:Option<std::time::Instant>,gsi_failures:u32,next_command_at:Option<std::time::Instant>,remote_scene:Option<(companion_dota_domain::broadcast_state::BroadcastState,u64)>,last_command:Option<String>,presence_error:Option<String>,
 next_sync_at:Option<std::time::Instant>,pending_sync:Option<companion_dota_storage::local_runtime::sync::OutboxRow>,
 backend_updates:u64,next_corrections_at:Option<std::time::Instant>,pending_corrections:Option<String>,
 detected_sounds:u64,planned_sounds:u64,last_sound_signal:Option<Value>,last_sound_operation:Option<String>,
 last_error:Option<String>, processed:u64, last_sequence:Option<u64>, last_analysis:Option<Value>,last_gsi:Option<Value>,last_receipt:Option<companion_dota_domain::match_execution::Receipt>,
}
impl Worker {
 pub fn new(launch:Launch)->Self{let mut hotkey=crate::overlay::hotkey::Controller::default();hotkey.load(&launch.data_root);Self{chat:None,overlay_hotkey:hotkey,overlay_visible:true,show_summary:false,pending_backend:None,obsolete_overlay_request:None,overlay_refresh:Default::default(),overlay_resources:Default::default(),overlay_backend_error:None,launch,history:None,listener:None,pipeline:Default::default(),overlay:None,last_overlay_at:None,scene:companion_dota_domain::broadcast_state::BroadcastState::BetweenMatches,selected_directory:None,obs:Default::default(),reminder:Default::default(),dropped_sound_intents:0,audio_sequence:0,speech_sequence:0,last_lifecycle_at:None,last_watchdog_at:None,stream_ended:false,streaming:None,next_account_at:None,account_request_sequence:0,account_failures:0,backend_error:None,account:None,live_gsi:None,gsi_sent:0,pending_gsi:None,next_gsi_at:None,gsi_failures:0,next_command_at:None,remote_scene:None,last_command:None,presence_error:None,next_sync_at:None,pending_sync:None,backend_updates:0,next_corrections_at:None,pending_corrections:None,detected_sounds:0,planned_sounds:0,last_sound_signal:None,last_sound_operation:None,last_error:None,processed:0,last_sequence:None,last_analysis:None,last_gsi:None,last_receipt:None}}
 pub fn status(&self)->Value{
  let history=self.history.as_ref();let active=history.is_some_and(History::active);
  json!({"overlayVisible":self.overlay_visible,"showSummary":self.show_summary,"overlayHotkey":self.overlay_hotkey.status(),"prepared":history.is_some(),"active":active,"awaitingSession":active&&history.and_then(History::session).is_none(),
   "session":history.and_then(History::session),"epoch":history.and_then(History::epoch),"lastError":self.last_error,"streaming":self.streaming,"streamEnded":self.stream_ended,"obsError":self.obs.error,"obsReceipt":self.obs.last_receipt,"backendError":self.backend_error,"presenceError":self.presence_error,"overlayBackendError":self.overlay_backend_error,"backendUpdates":self.backend_updates,
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
   if self.next_sync_at.is_some_and(|at|at>std::time::Instant::now()){return self.enrichment_request();}
   self.next_sync_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(2));
   if self.pending_sync.is_some(){return Err("backend_request_in_flight".into());}
   let Some(row)=self.history.as_mut().unwrap().pending_sync()?else{return self.enrichment_request();};
   let payload:Value=match serde_json::from_str(&row.payload){Ok(value)=>value,Err(_)=>{self.history.as_mut().unwrap().settle_sync(&row,"rejected")?;self.backend_error=Some("outbox_payload_invalid".into());return Ok(None);}};
   let geometry=row.event_type=="quiz_geometry"&&row.entity_type=="overlay-geometry";
   let request=Request{resource:if geometry{"quiz-geometry"}else{"sync-event"}.into(),operation_key:format!("sync:{}:{}",row.id,row.attempts),query:Default::default(),body:Some(if geometry{payload}else{json!({"eventId":row.id,"eventType":row.event_type,"payload":payload})})};
   request.validate()?;self.pending_sync=Some(row);return Ok(Some(request));
  }
  self.account_request_sequence=self.account_request_sequence.checked_add(1).ok_or("backend_sequence_exhausted")?;
  self.next_account_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(60));
  Ok(Some(companion_plugin_protocol::backend::Request{resource:"account".into(),operation_key:format!("account:{}:{}",self.launch.generation,self.account_request_sequence),query:Default::default(),body:None}))
 }
 fn enrichment_request(&mut self)->Result<Option<companion_plugin_protocol::backend::Request>,String>{
  if let Some(request)=self.live_backend_request()?{return Ok(Some(request));}
  self.overlay_backend_request()
 }
 /// Presence and the website's remote test-scene mailbox, as 0.5.90 did:
 /// commands every 15s; the projected live state at most once per second and
 /// only after a new admitted frame. Both are latest-state reads/upserts, never
 /// effect keys, so a lost reply is superseded instead of replayed.
 fn live_backend_request(&mut self)->Result<Option<companion_plugin_protocol::backend::Request>,String>{
  use companion_plugin_protocol::backend::Request;
  let now=std::time::Instant::now();
  let request=if self.launch.capabilities.iter().any(|c|c=="obs.scene")&&self.next_command_at.is_none_or(|at|at<=now){
   self.next_command_at=Some(now+std::time::Duration::from_secs(15));
   ("commands",None)
  }else{
   let Some((frame,state))=self.live_gsi.as_ref().filter(|(frame,_)|*frame!=self.gsi_sent)else{return Ok(None);};
   if self.next_gsi_at.is_some_and(|at|at>now){return Ok(None);}
   self.next_gsi_at=Some(now+std::time::Duration::from_secs(1));self.pending_gsi=Some(*frame);
   ("gsi-state",Some(json!({"payload":state,"companionVersion":concat!("dota2@",env!("CARGO_PKG_VERSION"))})))
  };
  self.account_request_sequence=self.account_request_sequence.checked_add(1).ok_or("backend_sequence_exhausted")?;
  let request=Request{resource:request.0.into(),operation_key:format!("live:{}:{}",self.launch.generation,self.account_request_sequence),query:Default::default(),body:request.1};
  request.validate()?;Ok(Some(request))
 }
 fn live_backend_response(&mut self,request:&companion_plugin_protocol::backend::Request,response:companion_plugin_protocol::backend::Response)->Result<(),String>{
  let ok=response.error.is_none()&&response.status.is_some_and(|code|(200..300).contains(&code));
  let failure=||if response.status==Some(426){"companion_outdated".to_string()}else{response.error.clone().unwrap_or_else(||format!("backend_{}_unavailable",request.resource.replace('-',"_")))};
  if request.resource=="gsi-state"{
   let frame=self.pending_gsi.take().ok_or("backend_request_not_pending")?;
   if ok{self.gsi_sent=frame;self.gsi_failures=0;self.presence_error=None;}
   else{self.gsi_failures=self.gsi_failures.saturating_add(1);self.next_gsi_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(2u64.saturating_pow(self.gsi_failures.min(5)).min(30)));self.presence_error=Some(failure());}
   return Ok(());
  }
  if !ok{self.presence_error=Some(failure());return Ok(());}
  self.presence_error=None;
  let Some(body)=response.body.filter(|_|response.status!=Some(204))else{return Ok(());};
  use companion_dota_domain::broadcast_state::BroadcastState;
  let scene=match body.get("scene").and_then(Value::as_str){Some("betweenMatches")=>BroadcastState::BetweenMatches,Some("draft")=>BroadcastState::Draft,Some("gameplay")=>BroadcastState::Gameplay,_=>{self.presence_error=Some("obs_command_invalid".into());return Ok(());}};
  let Some(id)=body.get("id").and_then(Value::as_str).filter(|id|!id.is_empty()&&id.len()<=64)else{self.presence_error=Some("obs_command_invalid".into());return Ok(());};
  if self.last_command.as_deref()==Some(id){return Ok(());}
  // Same lifetime as 0.5.90's one-shot remote switch: the next real GSI frame
  // resumes automatic policy; ended/summary precedence still applies.
  self.last_command=Some(id.into());self.remote_scene=Some((scene,self.processed));Ok(())
 }
 fn requested_scene(&mut self)->companion_dota_domain::broadcast_state::BroadcastState{
  match self.remote_scene{Some((scene,frame)) if frame==self.processed=>scene,Some(_)=>{self.remote_scene=None;self.scene},None=>self.scene}
 }
 /// Bounded refreshes use the same single host HTTP slot as sync. Cached
 /// enrichment never delays GSI processing and never creates effect keys.
 fn overlay_backend_request(&mut self)->Result<Option<companion_plugin_protocol::backend::Request>,String>{
  use companion_plugin_protocol::backend::Request;
  if !self.launch.capabilities.iter().any(|c|c=="overlay.publish"){return Ok(None);}
  let queue=crate::overlay::saved(&self.launch.data_root,"queue-settings.json",128*1024)?;
  let ids:Vec<String>=queue.as_ref().and_then(|v|v.get("favoriteHeroIds")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64).filter(|id|*id>0&&*id<=u32::MAX as u64).take(3).map(|id|id.to_string()).collect();
  let quiz=queue.as_ref().and_then(|v|v.get("widgets")).and_then(|v|v.get("viewerQuizEnabled")).and_then(Value::as_bool)==Some(true)&&companion_dota_domain::broadcast_state::resolve(self.scene,self.stream_ended,self.show_summary)==companion_dota_domain::broadcast_state::BroadcastState::BetweenMatches;
  if !quiz{self.overlay_resources.remove("quiz-state");}
  for (resource,seconds) in [("overlay-layout",60),("queue-settings",60),("favorite-heroes",90),("profile-radar",90),("quiz-state",2)]{
   if resource=="favorite-heroes"&&ids.is_empty()||resource=="quiz-state"&&!quiz{continue;}
   if self.overlay_refresh.get(resource).is_some_and(|at|*at>std::time::Instant::now()){continue;}
   self.overlay_refresh.insert(resource.into(),std::time::Instant::now()+std::time::Duration::from_secs(seconds));
   self.account_request_sequence=self.account_request_sequence.checked_add(1).ok_or("backend_sequence_exhausted")?;
   let query=if resource=="favorite-heroes"{[("heroIds".into(),ids.join(","))].into()}else{Default::default()};
   return Ok(Some(Request{resource:resource.into(),operation_key:format!("overlay:{}:{}",self.launch.generation,self.account_request_sequence),query,body:None}));
  }Ok(None)
 }
 fn overlay_backend_response(&mut self,request:&companion_plugin_protocol::backend::Request,response:companion_plugin_protocol::backend::Response)->Result<(),String>{
  let valid=response.error.is_none()&&response.status.is_some_and(|code|(200..300).contains(&code));
  if let Some(body)=response.body.filter(|body|valid&&body.is_object()&&companion_plugin_protocol::backend::public_response(body)){
   if matches!(request.resource.as_str(),"overlay-layout"|"queue-settings"){
    if let Err(error)=crate::overlay::save_resource(&self.launch.data_root,&request.resource,&body){self.overlay_backend_error=Some(error);return Ok(());}
   }else{
    if request.resource=="quiz-state"{
     let round=body.get("quiz").ok_or("quiz_state_invalid")?;
     if !round.is_null()&&!round.get("roundId").is_some_and(Value::is_string){self.overlay_backend_error=Some("quiz_state_invalid".into());return Ok(());}
     self.history.as_mut().ok_or("not_prepared")?.expire_quiz_geometry(round.get("roundId").and_then(Value::as_str))?;
    }
    self.overlay_resources.insert(request.resource.clone(),body);
   }
   self.overlay_backend_error=None;self.last_overlay_at=None;
  }else{self.overlay_backend_error=Some(response.error.unwrap_or_else(||"overlay_backend_unavailable".into()));}
  Ok(())
 }
 pub fn backend_response(&mut self,request:&companion_plugin_protocol::backend::Request,response:companion_plugin_protocol::backend::Response)->Result<(),String>{
  if self.pending_backend.as_ref().and_then(|r|serde_json::to_value(r).ok())!=serde_json::to_value(request).ok(){return Err("backend_response_scope_mismatch".into());}
  if response.operation_key!=request.operation_key{return Err("backend_response_scope_mismatch".into());}
  if response.error.as_deref()==Some("backend_request_pending"){
   if response.status.is_some()||response.body.is_some(){return Err("invalid_backend_pending_response".into());}return Ok(());
  }
  self.pending_backend=None;
  if self.obsolete_overlay_request.as_ref()==Some(&request.operation_key){self.obsolete_overlay_request=None;return Ok(());}
  if matches!(request.resource.as_str(),"overlay-layout"|"queue-settings"|"favorite-heroes"|"profile-radar"|"quiz-state"){return self.overlay_backend_response(request,response);}
  if matches!(request.resource.as_str(),"gsi-state"|"commands"){return self.live_backend_response(request,response);}
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
  if !matches!(request.resource.as_str(),"sync-event"|"quiz-geometry"){return Err("backend_response_scope_mismatch".into());}
  let row=self.pending_sync.take().ok_or("backend_request_not_pending")?;
  if (request.resource=="quiz-geometry")!=(row.event_type=="quiz_geometry"&&row.entity_type=="overlay-geometry")||request.operation_key!=format!("sync:{}:{}",row.id,row.attempts){return Err("backend_response_scope_mismatch".into());}
  let geometry_confirmed=request.resource!="quiz-geometry"||response.body.as_ref().is_some_and(|body|body.get("ok")==Some(&Value::Bool(true))&&body.get("applied").is_some_and(Value::is_boolean));
  let delivery=if response.error.is_none()&&response.status.is_some_and(|s|(200..300).contains(&s))&&geometry_confirmed{"delivered"}
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
  if self.account.as_ref()!=Some(&account){self.overlay_backend_error=crate::overlay::save_account(&self.launch.data_root,&account).err();}
  self.account=Some(account);self.backend_error=None;self.account_failures=0;Ok(())
 }
 fn backend_unavailable(&mut self,error:String){self.backend_error=Some(error);self.account_failures=self.account_failures.saturating_add(1);self.next_account_at=Some(std::time::Instant::now()+std::time::Duration::from_secs(2u64.saturating_pow(self.account_failures.min(5)).min(60)));}
 pub fn backend_failure(&mut self,error:String)->String{let error=self.close_after_error(error);self.last_error=Some(error.clone());error}
 /// Commands are serialized by the existing stdio loop: one coordinator, one
 /// listener, and no duplicate preparation even when the UI repeats a request.
 pub fn command(&mut self,name:&str,args:Value)->Result<Value,String>{
  let result=if name=="host.resource"{
   #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Resource{resource:String,body:Value}
   (||{if !self.launch.capabilities.iter().any(|c|c=="backend.access")||!self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){return Err("capability_denied".into());}
    let input:Resource=serde_json::from_value(args).map_err(|_|"invalid_backend_resource")?;
    if !companion_plugin_protocol::backend::public_response(&input.body){return Err("invalid_backend_resource".into());}
    if matches!(input.resource.as_str(),"hero-stats"|"hero-insights"){
     if !input.body.is_object()||!input.body.get("status").is_some_and(Value::is_string){return Err("invalid_backend_resource".into());}
     return Ok(json!({"handled":false,"applied":false}));
    }
    crate::overlay::save_resource(&self.launch.data_root,&input.resource,&input.body)?;
    let read=input.resource.strip_suffix("-save").unwrap_or(&input.resource);
    self.overlay_refresh.insert(read.into(),std::time::Instant::now()+std::time::Duration::from_secs(60));
    // A GET admitted before the confirmed editor result cannot overwrite it.
    // Still consume its real HTTP reply, preserving the one in-flight slot.
    if let Some(pending)=self.pending_backend.as_ref().filter(|pending|pending.resource==read){self.obsolete_overlay_request=Some(pending.operation_key.clone());}
    self.last_overlay_at=None;self.publish_overlay()?;Ok(json!({"applied":true}))
   })()
  }else if name=="host.directory"{
   self.select_directory(args)
  }else if name=="host.poll"{
   serde_json::from_value(if args.is_null(){json!({})}else{args}).map_err(|_|"invalid_poll_context".to_string()).and_then(|context|self.poll(context))
  }else if name.starts_with("host."){
   crate::ui::empty(args).and_then(|_|self.command_inner(name))
  }else if !self.launch.capabilities.iter().any(|c|c=="ui"){Err("capability_denied".into())}
  else if name=="status"{crate::ui::empty(args).map(|_|self.status())}
  else if !self.launch.capabilities.iter().any(|c|matches!(c.as_str(),"data.legacy"|"data.private")){Err("capability_denied".into())}
  else if name.starts_with("overlay."){self.overlay_command(name,args)}
  else if name=="history.hero"{
   #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Hero{hero_id:i64}
   (||{let hero:Hero=serde_json::from_value(args).map_err(|_|"invalid_hero_id")?;
    self.history.as_ref().ok_or("not_prepared")?.hero_stats(hero.hero_id).and_then(|value|serde_json::to_value(value).map_err(|_|"history_encoding_failed".into()))})()
  }
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
 fn overlay_command(&mut self,name:&str,args:Value)->Result<Value,String>{
  if !self.launch.capabilities.iter().any(|c|c=="overlay.publish"){return Err("capability_denied".into());}
  match name{
   "overlay.image.get"|"overlay.image.remove"|"overlay.image.apply"=>{
    #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Image{kind:String,#[serde(default)]file_name:Option<String>}
    let input:Image=serde_json::from_value(args).map_err(|_|"invalid_overlay_image")?;
    if name!="overlay.image.apply"&&input.file_name.is_some(){return Err("invalid_overlay_image".into());}
    let root=&self.launch.data_root;
    let url=if name=="overlay.image.apply"{Some(crate::overlay::images::apply(root,&input.kind,input.file_name.as_deref().ok_or("invalid_overlay_image")?)?)}
     else if name=="overlay.image.remove"{crate::overlay::images::remove(root,&input.kind)?;None}else{crate::overlay::images::current(root,&input.kind)?};
    if name!="overlay.image.get"{
     if input.kind=="webcam"{if let Some(mut settings)=crate::overlay::saved(root,"queue-settings.json",128*1024)?{settings["webcamImageUrl"]=serde_json::to_value(&url).map_err(|_|"overlay_settings_invalid")?;crate::overlay::save_resource(root,"queue-settings",&settings)?;}}
     self.last_overlay_at=None;self.publish_overlay()?;
    }
    Ok(json!({"url":url}))
   },
   "overlay.reference"=>{crate::ui::empty(args)?;Ok(json!({"opacity":crate::overlay::reference_opacity(&self.launch.data_root)?}))},
   "overlay.reference.save"=>{
    #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Reference{opacity:f64}
    let input:Reference=serde_json::from_value(args).map_err(|_|"invalid_reference_opacity")?;Ok(json!({"opacity":crate::overlay::save_reference_opacity(&self.launch.data_root,input.opacity)?}))
   },
   "overlay.hotkey"=>{crate::ui::empty(args)?;Ok(json!(self.overlay_hotkey.status()))},
   "overlay.hotkey.save"=>{let config=serde_json::from_value(args).map_err(|_|"invalid_overlay_hotkey")?;Ok(json!(self.overlay_hotkey.update(&self.launch.data_root,config,self.history.as_ref().is_some_and(History::active))?))},
   "overlay.visibility"=>{
    #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Visibility{visible:bool}
    let request:Visibility=serde_json::from_value(args).map_err(|_|"invalid_overlay_visibility")?;self.overlay_visible=request.visible;self.publish_overlay()?;Ok(json!({"visible":self.overlay_visible}))
   },
   "overlay.summary"=>{
    #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Summary{show:bool}
    let request:Summary=serde_json::from_value(args).map_err(|_|"invalid_overlay_summary")?;self.show_summary=request.show;self.publish_overlay()?;Ok(json!({"show":self.show_summary}))
   },
   _=>Err("unsupported_overlay_command".into()),
  }
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
    if self.overlay.is_some(){let _=self.overlay_hotkey.start();}
    if let Err(error)=self.publish_overlay(){return Err(self.close_after_error(error));}
    Ok(self.status())
   },
   "host.stop"=>{self.stop()?;Ok(self.status())},
   "host.status"=>Ok(self.status()),
   _=>Err("unsupported_worker_command".into()),
  }
 }
 pub fn stop(&mut self)->Result<(),String>{
  self.overlay_hotkey.stop()?;
  self.overlay.take();self.last_overlay_at=None;
  if let Some(listener)=self.listener.take(){self.last_gsi=Some(json!(listener.status()));}
  self.pipeline.reset();self.remote_scene=None;self.live_gsi=None;
  if let Some(history)=self.history.as_mut(){history.drain()?;}
  Ok(())
 }
 fn poll(&mut self,context:PollContext)->Result<Value,String>{
  // HTTP request threads never touch SQLite. The existing serialized worker
  // admits each bounded geometry document and returns its durable outbox ID.
  for _ in 0..4 {
   let Some(request)=self.overlay.as_ref().and_then(|server|server.next_geometry())else{break;};
   let result=if self.launch.capabilities.iter().any(|cap|cap=="backend.access"){
    self.history.as_mut().ok_or_else(||"not_prepared".to_string()).and_then(|history|history.queue_quiz_geometry(&request.geometry))
   }else{Err("capability_denied".into())};
   if let Err(error)=&result{self.overlay_backend_error=Some(error.clone());}let _=request.reply.try_send(result);
  }

  if self.overlay_hotkey.take_toggle()&&self.history.as_ref().is_some_and(History::active){self.overlay_visible=!self.overlay_visible;self.publish_overlay()?;}
  if let Some(receipt)=context.scene_receipt{let now=u64::try_from(chrono::Utc::now().timestamp_millis()).map_err(|_|"clock_unavailable")?;self.obs.receipt(receipt,now)?;}
  if self.overlay.as_ref().is_some_and(|s|s.closed()){return Err(self.close_after_error("overlay_listener_failed".into()));}
  if let Some(listener)=self.listener.as_ref().filter(|l|l.failed()||l.status().rejected>0){
   let code=listener.status().last_error.unwrap_or("gsi_admission_failed").to_string();return Err(self.close_after_error(code));
  }
  let now=chrono::Utc::now();
  let now_ms=u64::try_from(now.timestamp_millis()).map_err(|_|"clock_unavailable")?;
  self.chat=if self.launch.capabilities.iter().any(|cap|cap=="chat.read"){context.chat.filter(|chat|chat.fresh(now_ms))}else{None};
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
   let intent=if self.launch.capabilities.iter().any(|c|c=="obs.scene")&&self.history.as_ref().is_some_and(History::active){{let requested=self.requested_scene();self.obs.plan(context.scene_observation.as_ref(),requested,self.stream_ended,self.show_summary,effect_context.as_deref(),now_ms)?}}else{None};
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
   self.live_gsi=Some((self.processed.wrapping_add(1),live_state(&frame.snapshot)));
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
  let scene=companion_dota_domain::broadcast_state::resolve(self.scene,self.stream_ended,self.show_summary);
  if self.launch.capabilities.iter().any(|cap|cap=="backend.access"){
   let quiz=queue.as_ref().and_then(|q|q.get("widgets")).and_then(|w|w.get("viewerQuizEnabled")).and_then(Value::as_bool)==Some(true)&&scene==companion_dota_domain::broadcast_state::BroadcastState::BetweenMatches;
   self.history.as_mut().ok_or("not_prepared")?.quiz_transition(quiz)?;
  }
  let snapshot=crate::overlay::OverlayStateSnapshot{scene,updated_at:chrono::Utc::now().to_rfc3339(),session:self.history.as_ref().ok_or("not_prepared")?.summary()?,layout_version:0,account,twitch_chat:self.chat.as_ref().filter(|chat|u64::try_from(chrono::Utc::now().timestamp_millis()).is_ok_and(|now|chat.fresh(now))).and_then(|chat|serde_json::to_value(&chat.data).ok()),overlay_visible:self.overlay_visible,opendota_favorite_heroes:self.overlay_resources.get("favorite-heroes").cloned(),opendota_radar:self.overlay_resources.get("profile-radar").cloned(),quiz:if queue.as_ref().and_then(|q|q.get("widgets")).and_then(|w|w.get("viewerQuizEnabled")).and_then(Value::as_bool)==Some(true){self.overlay_resources.get("quiz-state").and_then(|q|q.get("quiz")).cloned().filter(|v|!v.is_null())}else{None}};
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
 #[test]fn overlay_controls_require_the_package_grant_and_do_not_create_a_session_or_listener(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.launch.capabilities.push("ui".into());
  assert_eq!(worker.command("overlay.visibility",json!({"visible":false})).unwrap_err(),"capability_denied");
  worker.launch.capabilities.push("overlay.publish".into());
  assert_eq!(worker.command("overlay.visibility",json!({"visible":false})).unwrap()["visible"],false);
  assert_eq!(worker.command("overlay.summary",json!({"show":true})).unwrap()["show"],true);
  assert!(worker.command("overlay.visibility",json!({"visible":true,"path":"arbitrary"})).is_err());
  assert_eq!(worker.status()["session"],Value::Null);assert_eq!(worker.status()["active"],false);
  assert!(worker.listener.is_none());assert!(worker.overlay.is_none());assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
 }
 #[test]fn confirmed_host_settings_preserve_unedited_fields_without_opening_history(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());
  let body=json!({"version":5,"scenes":{"draft":{"cameraZone":{"unchanged":true}},"gameplay":{"widgets":{"session":{"xVw":42}},"futureWidget":{"keep":"original"}}},"draftProtection":{"mode":"cover"},"aspectRatio":{"preset":"custom"}});
  let request=json!({"resource":"overlay-layout","body":body});
  assert_eq!(worker.command("host.resource",request.clone()).unwrap_err(),"capability_denied");
  worker.launch.capabilities.push("backend.access".into());worker.command("host.resource",request).unwrap();
  let path=root.path().join("overlay-layout.json");let saved=std::fs::read(&path).unwrap();assert_eq!(serde_json::from_slice::<Value>(&saved).unwrap(),body);
  assert!(worker.command("host.resource",json!({"resource":"overlay-layout-save","body":{"version":99,"scenes":{}}})).is_err());
  assert!(worker.command("host.resource",json!({"resource":"overlay-layout","body":{"version":1,"scenes":{},"password":"forbidden"}})).is_err());
  assert!(worker.command("host.resource",json!({"resource":"../../elsewhere","body":body})).is_err());
  assert_eq!(std::fs::read(path).unwrap(),saved);assert!(worker.history.is_none());assert_eq!(worker.status()["session"],Value::Null);
  let queue=json!({"version":2,"visibility":{"webcam":true},"widgets":{"viewerQuizEnabled":false},"favoriteHeroIds":[105],"webcamImageUrl":null,"channelGoal":{"type":"none","label":"","startValue":0,"targetValue":0}});
  worker.command("host.resource",json!({"resource":"queue-settings","body":queue})).unwrap();
  assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(root.path().join("queue-settings.json")).unwrap()).unwrap(),queue);
  assert!(worker.command("host.resource",json!({"resource":"queue-settings","body":{"version":99,"visibility":{},"widgets":{}}})).is_err());
 }
 #[test]fn chat_projection_requires_an_explicit_grant_and_cannot_relabel_expired_data_as_fresh(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());
  let now=u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap();
  let chat=companion_plugin_protocol::chat::Snapshot::project(&json!({"accountConnected":true,"configured":true,"connected":true,"state":"connected","messages":[]}),now).unwrap();
  worker.command("host.poll",json!({"chat":chat})).unwrap();assert!(worker.chat.is_none());
  worker.launch.capabilities.push("chat.read".into());worker.command("host.poll",json!({"chat":chat})).unwrap();assert!(worker.chat.is_some());
  let mut expired=chat;expired.observed_at_ms=now-6000;worker.command("host.poll",json!({"chat":expired})).unwrap();assert!(worker.chat.is_none());
  assert!(worker.history.is_none());assert!(worker.listener.is_none());
 }
 #[test]fn overlay_refresh_preserves_settings_and_a_late_read_cannot_overwrite_a_confirmed_edit(){
  use companion_plugin_protocol::backend::Response;
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.launch.capabilities.extend(["backend.access".into(),"overlay.publish".into()]);
  let first=worker.overlay_backend_request().unwrap().unwrap();assert_eq!(first.resource,"overlay-layout");
  worker.pending_backend=Some(first.clone());
  let layout=json!({"version":5,"scenes":{"gameplay":{"widgets":{"session":{"xVw":42}}}},"future":{"untouched":true}});
  worker.command("host.resource",json!({"resource":"overlay-layout-save","body":layout})).unwrap();
  worker.backend_response(&first,Response{operation_key:first.operation_key.clone(),status:Some(200),body:Some(json!({"version":5,"scenes":{}})),error:None}).unwrap();
  assert_eq!(crate::overlay::saved(root.path(),"overlay-layout.json",24576).unwrap(),Some(layout));
  assert!(worker.pending_backend.is_none());assert!(worker.obsolete_overlay_request.is_none());
  let queue=worker.overlay_backend_request().unwrap().unwrap();assert_eq!(queue.resource,"queue-settings");worker.pending_backend=Some(queue.clone());
  let document=json!({"version":2,"visibility":{},"widgets":{"viewerQuizEnabled":true},"favoriteHeroIds":[105,14]});
  worker.backend_response(&queue,Response{operation_key:queue.operation_key.clone(),status:Some(200),body:Some(document.clone()),error:None}).unwrap();
  assert_eq!(crate::overlay::saved(root.path(),"queue-settings.json",24576).unwrap(),Some(document));
  let favorites=worker.overlay_backend_request().unwrap().unwrap();assert_eq!(favorites.resource,"favorite-heroes");assert_eq!(favorites.query.get("heroIds").unwrap(),"105,14");
  worker.pending_backend=Some(favorites.clone());worker.backend_response(&favorites,Response::failed(&favorites,"backend_result_unknown")).unwrap();
  assert_eq!(worker.overlay_backend_error.as_deref(),Some("backend_result_unknown"));assert!(worker.history.is_none());assert!(worker.listener.is_none());
 }
 #[test]fn live_passthrough_is_whitelisted_throttled_and_the_remote_scene_lasts_until_the_next_frame(){
  use companion_plugin_protocol::backend::Response;use companion_dota_domain::broadcast_state::BroadcastState;
  let snapshot:companion_dota_domain::contracts::ReplayGsi=serde_json::from_value(json!({"player":{"activity":"playing","kills":3},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":"77","customgamename":"/private/path"},"hero":{"id":105},"items":{"slot0":{"name":"item_blink"}},"abilities":{"ability0":{"name":"techies_suicide","cooldown":3.0}}})).unwrap();
  let state=live_state(&snapshot);let text=state.to_string();
  assert_eq!(state["map"]["game_state"],"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");assert_eq!(state["player"]["activity"],"playing");assert_eq!(state["hero"]["id"],105);
  for denied in ["items","abilities","couriers","customgamename","custom_game_name","private","techies"]{assert!(!text.contains(denied),"{denied}");}
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.launch.capabilities.extend(["backend.access".into(),"obs.scene".into()]);
  let commands=worker.live_backend_request().unwrap().unwrap();assert_eq!(commands.resource,"commands");assert!(commands.body.is_none());
  assert!(worker.live_backend_request().unwrap().is_none(),"no frame, no state upsert");
  worker.live_gsi=Some((1,state.clone()));
  let put=worker.live_backend_request().unwrap().unwrap();assert_eq!(put.resource,"gsi-state");assert_eq!(put.body.as_ref().unwrap()["payload"],state);
  assert!(!put.body.as_ref().unwrap()["companionVersion"].as_str().unwrap().starts_with(char::is_numeric));
  worker.live_backend_response(&put,Response{operation_key:put.operation_key.clone(),status:Some(426),body:None,error:Some("backend_http_rejected".into())}).unwrap();
  assert_eq!(worker.presence_error.as_deref(),Some("companion_outdated"));assert_eq!(worker.gsi_sent,0);assert!(worker.live_backend_request().unwrap().is_none(),"failure backs off");
  worker.next_gsi_at=None;let retry=worker.live_backend_request().unwrap().unwrap();
  worker.live_backend_response(&retry,Response{operation_key:retry.operation_key.clone(),status:Some(200),body:Some(json!({"ok":true})),error:None}).unwrap();
  assert_eq!(worker.gsi_sent,1);worker.next_gsi_at=None;assert!(worker.live_backend_request().unwrap().is_none(),"delivered state is not resent");
  let reply=|body:Value|Response{operation_key:commands.operation_key.clone(),status:Some(200),body:Some(body),error:None};
  worker.live_backend_response(&commands,Response{operation_key:commands.operation_key.clone(),status:Some(204),body:None,error:None}).unwrap();assert!(worker.remote_scene.is_none());
  worker.live_backend_response(&commands,reply(json!({"id":"c1","scene":"postStream"}))).unwrap();assert_eq!(worker.presence_error.as_deref(),Some("obs_command_invalid"));assert!(worker.remote_scene.is_none());
  worker.live_backend_response(&commands,reply(json!({"id":"c2","scene":"draft","createdAt":"now"}))).unwrap();
  assert_eq!(worker.requested_scene(),BroadcastState::Draft);assert_eq!(worker.requested_scene(),BroadcastState::Draft);
  worker.processed+=1;assert_eq!(worker.requested_scene(),BroadcastState::BetweenMatches);
  worker.live_backend_response(&commands,reply(json!({"id":"c2","scene":"draft"}))).unwrap();assert!(worker.remote_scene.is_none(),"a repeated command id is not reapplied");
  assert!(worker.history.is_none());assert!(worker.listener.is_none());
 }
 #[test]fn the_account_cache_file_takes_only_an_object_and_never_follows_host_resource(){
  let root=tempfile::tempdir().unwrap();let account=json!({"gameMode":"ranked","currentMmr":4200});
  crate::overlay::save_account(root.path(),&account).unwrap();assert_eq!(crate::overlay::saved(root.path(),"account-overlay-data.json",24576).unwrap(),Some(account.clone()));
  assert!(crate::overlay::save_account(root.path(),&json!([1])).is_err());assert!(crate::overlay::save_resource(root.path(),"account",&account).is_err());
  let mut worker=worker(root.path());worker.launch.capabilities.push("backend.access".into());
  assert!(worker.command("host.resource",json!({"resource":"account","body":{"gameMode":"unranked"}})).is_err());
  assert_eq!(crate::overlay::saved(root.path(),"account-overlay-data.json",24576).unwrap(),Some(account));
 }
 #[test]fn reference_opacity_is_bounded_package_state_and_survives_a_restart(){
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.launch.capabilities.extend(["ui".into(),"overlay.publish".into()]);
  assert_eq!(worker.command("overlay.reference",json!({})).unwrap()["opacity"],0.65);
  assert_eq!(worker.command("overlay.reference.save",json!({"opacity":0.4})).unwrap()["opacity"],0.4);
  for bad in [json!({"opacity":0.0}),json!({"opacity":1.5}),json!({"opacity":0.5,"path":"x"}),json!({"opacity":"0.5"})]{assert!(worker.command("overlay.reference.save",bad).is_err());}
  let mut restarted=super::tests::worker(root.path());restarted.launch.capabilities.extend(["ui".into(),"overlay.publish".into()]);
  assert_eq!(restarted.command("overlay.reference",json!({})).unwrap()["opacity"],0.4);
  assert!(crate::overlay::saved(root.path(),"overlay-editor.json",1024).is_err());assert!(worker.history.is_none());
 }
 #[test]fn disabled_quiz_is_not_polled_and_failed_enrichment_keeps_the_last_actual_response(){
  use companion_plugin_protocol::backend::Response;
  let root=tempfile::tempdir().unwrap();let mut worker=worker(root.path());worker.launch.capabilities.push("overlay.publish".into());
  for resource in ["overlay-layout","queue-settings","profile-radar"]{let request=worker.overlay_backend_request().unwrap().unwrap();assert_eq!(request.resource,resource);}
  assert!(worker.overlay_backend_request().unwrap().is_none());
  worker.overlay_resources.insert("profile-radar".into(),json!({"status":"ok","axes":[1,2]}));
  let request=companion_plugin_protocol::backend::Request{resource:"profile-radar".into(),operation_key:"read:radar".into(),query:Default::default(),body:None};
  worker.overlay_backend_response(&request,Response::failed(&request,"backend_response_invalid")).unwrap();
  assert_eq!(worker.overlay_resources["profile-radar"]["axes"],json!([1,2]));
  worker.overlay_resources.insert("quiz-state".into(),json!({"quiz":{"stale":true}}));worker.overlay_backend_request().unwrap();assert!(!worker.overlay_resources.contains_key("quiz-state"));
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
