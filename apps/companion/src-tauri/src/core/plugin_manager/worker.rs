//! Installed API2 workers use the existing manager, Runtime and host transport.
//! No game types, listener, SQL/history writer or credential access in this adapter.
use super::*;
use companion_plugin_protocol::{PackageBinding,ProcessGrant,runtime::ProcessBinding};
use super::super::plugin_audio::{HostAudio,store::ProcessPhase};
use serde::Deserialize;
use tauri::Emitter;

#[derive(Clone)]
struct Pin{package:PackageBinding,executable:PathBuf,permissions:Vec<String>,backend_resources:std::collections::BTreeMap<String,companion_plugin_protocol::backend::Resource>,obs_bindings:std::collections::BTreeMap<String,companion_plugin_protocol::obs::Binding>}
impl ProcessGrant for Pin{
 fn binding(&self)->&PackageBinding{&self.package}
 fn executable(&self)->&std::path::Path{&self.executable}
 fn permits(&self,cap:&str)->bool{self.permissions.iter().any(|p|p==cap)}
}
#[derive(Clone)]
pub(super) struct WorkerProcess{ui_backend:Arc<Mutex<()>>,obs_querying:Arc<AtomicBool>,backend_io:Arc<Mutex<super::super::backend_transport::PendingRequest>>,pin:Pin,binding:ProcessBinding,epoch:u64,root:PathBuf,active:bool,polling:Arc<AtomicBool>,effect_context:Arc<Mutex<Option<Option<String>>>>,scene_receipt:Arc<Mutex<Option<companion_plugin_protocol::obs::SceneReceipt>>>,scene_observation:Arc<Mutex<Option<companion_plugin_protocol::obs::SceneObservation>>>}
struct Task{worker:WorkerProcess,host:PluginHost,app:tauri::AppHandle,audio:Arc<HostAudio>}
struct PollGuard(Arc<AtomicBool>);
impl Drop for PollGuard{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Batch{status:Value,sound_intents:Vec<SoundIntent>,#[serde(default)]scene_intent:Option<companion_plugin_protocol::obs::SceneIntent>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SoundIntent{operation_key:String,asset_file:String,volume:u8,deadline_ms:u64,context:Option<String>,#[serde(default)]speech:Option<String>}

// Called from blocking worker/command threads only. The controller is read on
// the UI thread; its current browser PID is resolved to an owned kernel handle.
// No Manager/history callback, cached PID or Javascript assertion is trusted.
#[cfg(windows)]
fn verify_frontend_in_host(app:&tauri::AppHandle)->Result<(),String>{
 let window=app.get_webview_window("main").ok_or("frontend_audio_unavailable")?;
 let generation=companion_plugin_protocol::windows::current_host_generation().ok_or("host_supervision_unproven")?.to_string();
 let(tx,rx)=std::sync::mpsc::sync_channel(1);
 window.with_webview(move|view|{
  let result=(||unsafe{
   let browser=view.controller().CoreWebView2().map_err(|_|"frontend_controller_unavailable")?;let mut pid=0;
   browser.BrowserProcessId(&mut pid).map_err(|_|"frontend_controller_unavailable")?;
   companion_plugin_protocol::windows::verify_host_descendant(&generation,pid)
  })();let _=tx.send(result);
 }).map_err(|_|"frontend_controller_unavailable")?;
 rx.recv_timeout(Duration::from_secs(2)).map_err(|_|"frontend_containment_unproven")?
}
#[cfg(not(windows))]
fn verify_frontend_in_host(_app:&tauri::AppHandle)->Result<(),String>{Err("native_supervision_unsupported".into())}

impl Service{
 fn worker_pin(&self,id:&str)->Result<(Pin,Manifest),String>{
  let installed=self.store.installed().get(id).cloned().ok_or("not_installed")?;
  self.worker_version_pin(id,&installed.active)
 }
 fn worker_version_pin(&self,id:&str,version:&str)->Result<(Pin,Manifest),String>{
  let (executable,manifest)=self.store.executable(id,version)?;
  if manifest.min_api<2||manifest.execution!=packages::ExecutionMode::Live{return Err("plugin_update_required".into());}
  let package=PackageBinding{id:manifest.id.clone(),version:manifest.version.clone(),executable_hash:manifest.files.get(&manifest.executable).cloned().ok_or("executable_unbound")?,manifest_hash:packages::hash(&serde_json::to_vec(&manifest).map_err(|_|"invalid_manifest")?)};
  Ok((Pin{package,executable,permissions:manifest.permissions.clone(),backend_resources:manifest.backend_resources.clone(),obs_bindings:manifest.obs_bindings.clone()},manifest))
 }
 pub(super) fn open_worker(&mut self,id:&str)->Result<(),String>{
  if let Some(worker)=self.workers.get(id){
   let (_,audio)=self.native.as_ref().ok_or("plugin_transport_unavailable")?;
   audio.locked_authorize(&worker.binding,worker.epoch)?;
   if self.hosts.get(id).ok_or("not_running")?.0.lock().map_err(|_|locked())?.snapshot().phase!=Phase::Running{return Err("plugin_process_requires_recovery".into());}return Ok(());
  }
  if self.workers.len()>=8{return Err("plugin_process_quota".into());}
  let (pin,manifest)=self.worker_pin(id)?;
  let (_,audio)=self.native.as_ref().ok_or("plugin_transport_unavailable")?;
  if !cfg!(windows){return Err("native_supervision_unsupported".into());}
  if audio.process(id)?.is_some_and(|p|p.phase!=ProcessPhase::Stopped){return Err("previous_process_stop_unproven".into());}
  let root=if pin.permits("data.legacy"){self.store.root().parent().ok_or("plugin_data_path_unavailable")?.to_path_buf()}else{self.store.root().join("data").join(id)};
  std::fs::create_dir_all(&root).map_err(|_|"plugin_data_path_unavailable")?;
  let generation=uuid::Uuid::new_v4().to_string();let process=ProcessBinding{generation:generation.clone(),package:pin.package.clone()};
  let epoch=audio.reserve_process(&process)?.epoch;
  let launch=serde_json::json!({"dataRoot":root,"generation":generation,"package":pin.package,"capabilities":pin.permissions});
  let host=self.hosts.entry(id.into()).or_insert_with(PluginHost::new);
  let mut runtime=host.0.lock().map_err(|_|locked())?;
  let started=runtime.start_verified_args(&pin,generation,&["--worker".into(),launch.to_string()]);
  if let Err(error)=started{
   audio.process_draining(&process,epoch)?;
   // A failed handshake is not an exit proof. Keep Draining on any OS error.
   let _=runtime.stop();runtime.stopped_confirmed()?;
   #[cfg(windows)] companion_plugin_protocol::windows::fence_generation(&process.generation)?;
   audio.process_after_native_exit(&process,epoch)?;return Err(error);
  }
  audio.process_ready(&process,epoch)?;
  let idle=runtime.command_verified(&pin,&process,"host.status".into(),serde_json::json!({})).and_then(|status|if status.get("active")==Some(&Value::Bool(false)){Ok(())}else{Err("worker_startup_not_idle".into())});
  if let Err(error)=idle{
   audio.process_draining(&process,epoch)?;let _=runtime.stop();runtime.stopped_confirmed()?;
   #[cfg(windows)] companion_plugin_protocol::windows::fence_generation(&process.generation)?;
   audio.process_after_native_exit(&process,epoch)?;return Err(error);
  }
  drop(runtime);
  self.workers.insert(id.into(),WorkerProcess{ui_backend:Default::default(),obs_querying:Default::default(),backend_io:Default::default(),pin,binding:process,epoch,root,active:false,polling:Default::default(),effect_context:Default::default(),scene_receipt:Default::default(),scene_observation:Default::default()});self.manifests.insert(id.into(),manifest);Ok(())
 }
 pub(super) fn prepare_worker(&mut self,id:&str)->Result<(),String>{
  self.open_worker(id)?;
  let (pin,_)=self.worker_pin(id)?;let process=self.workers.get(id).ok_or("not_running")?;
  if pin.binding()!=process.pin.binding(){return Err("process_binding_denied".into());}
  let host=self.hosts.get(id).ok_or("not_running")?;
  let result=host.0.lock().map_err(|_|locked())?.command_verified(&pin,&process.binding,"host.prepare".into(),serde_json::json!({}))?;
  if result.get("prepared")!=Some(&Value::Bool(true)){return Err("worker_preparation_unconfirmed".into());}Ok(())
 }
 pub(super) fn enable_worker(&mut self,id:&str)->Result<(),String>{
  self.open_worker(id)?;
  let (pin,_)=self.worker_pin(id)?;
  let (app,audio)=self.native.as_ref().ok_or("plugin_transport_unavailable")?;
  verify_frontend_in_host(app)?;
  let worker=self.workers.get_mut(id).ok_or("not_running")?;
  if worker.active{return Err("already_active".into());}
  if pin.binding()!=worker.pin.binding(){return Err("process_binding_denied".into());}
  // Fencing cannot be skipped for a replayed/unknown audio admission. Waiting
  // here holds no worker history connection; frontend ACK never takes Manager.
  audio.fence(id,|request|app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
  let quota=audio.quota(id)?;
  if quota.blocking_unknown>0{return Err("unknown_effects_require_explicit_reconciliation".into());}
  if quota.remaining_operations<256||quota.remaining_bytes<1024*1024{return Err("transport_quota_headroom_required".into());}
  audio.reopen(id)?;
  let activated=self.hosts.get(id).ok_or("not_running")?.0.lock().map_err(|_|locked())?.command_verified(&pin,&worker.binding,"host.activate".into(),serde_json::json!({}))
   .and_then(|result|if result.get("active")==Some(&Value::Bool(true)){Ok(())}else{Err("worker_activation_unconfirmed".into())});
  if let Err(error)=activated{let stopped=self.stop_worker(id);return Err(stopped.err().map_or(error.clone(),|stop|format!("{error}; stop: {stop}")));}
  worker.active=true;
  if let Err(error)=self.store.enable(id,true){let stopped=self.stop_worker(id);return Err(stopped.err().map_or(error.clone(),|stop|format!("{error}; stop: {stop}")));}Ok(())
 }
 pub(super) fn stop_worker(&mut self,id:&str)->Result<(),String>{
  let (app,audio)=self.native.as_ref().ok_or("plugin_transport_unavailable")?;
  let worker=self.workers.get_mut(id).ok_or("not_running")?;
  audio.process_draining(&worker.binding,worker.epoch)?;worker.active=false;
  let host=self.hosts.get(id).ok_or("not_running")?;let mut runtime=host.0.lock().map_err(|_|locked())?;
  // Native stop still runs if the worker failed to answer its own drain command.
  let drain=runtime.command_verified(&worker.pin,&worker.binding,"host.stop".into(),serde_json::json!({}));
  let _=runtime.stop();runtime.stopped_confirmed()?;
  #[cfg(windows)] companion_plugin_protocol::windows::fence_generation(&worker.binding.generation)?;
  drop(runtime);
  worker.backend_io.lock().map_err(|_|"backend_state_poisoned")?.drain(Duration::from_secs(2))?;
  drain_ui_backend(worker)?;
  reconcile_stopped_setting(app,audio,&worker.binding,worker.epoch,||Ok(worker.pin.clone()))?;
  reconcile_stopped_scenes(app,audio,&worker.binding,worker.epoch)?;
  audio.fence(id,|request|app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
  audio.process_after_native_exit(&worker.binding,worker.epoch)?;
  self.store.enable(id,false)?;self.workers.remove(id);self.store.activate(id)?;
  let installed=self.store.installed().get(id).cloned().ok_or("not_installed")?;self.manifests.insert(id.into(),self.store.manifest(id,&installed.active)?);
  if drain.is_err(){crate::storage::append_rolling_log(app,"Plugin IPC drain failed; native process exit and effect fences confirmed.");}Ok(())
 }
 pub(super) fn recover_worker(&mut self,id:&str)->Result<(),String>{
  if self.workers.contains_key(id){return self.stop_worker(id);}
  let (app,audio)=self.native.as_ref().ok_or("plugin_transport_unavailable")?;
  let Some(record)=audio.process(id)?else{return Ok(());};
  if record.phase==ProcessPhase::Stopped{return Ok(());}
  if !cfg!(windows){return Err("native_supervision_unsupported".into());}
  let process=ProcessBinding{generation:record.process.generation,package:record.process.package};
  audio.process_draining(&process,record.epoch)?;
  // The kernel job identity (not a saved PID or timeout) proves that this
  // exact generation can no longer run. Unknown receipts are never erased.
  #[cfg(windows)] companion_plugin_protocol::windows::fence_generation(&process.generation)?;
  reconcile_stopped_setting(app,audio,&process,record.epoch,||self.worker_version_pin(id,&process.package.version).map(|(pin,_)|pin))?;
  reconcile_stopped_scenes(app,audio,&process,record.epoch)?;
  audio.fence(id,|request|app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
  audio.process_after_native_exit(&process,record.epoch)?;
  self.store.enable(id,false)?;self.store.activate(id)?;
  let installed=self.store.installed().get(id).cloned().ok_or("not_installed")?;self.manifests.insert(id.into(),self.store.manifest(id,&installed.active)?);Ok(())
 }
 fn tasks(&self)->Vec<Task>{
  let Some((app,audio))=self.native.as_ref()else{return vec![];};
  self.workers.iter().filter(|(_,w)|w.active).filter_map(|(id,worker)|{
   let host=self.hosts.get(id)?.clone();
   if worker.polling.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return None;}
   Some(Task{worker:worker.clone(),host,app:app.clone(),audio:audio.clone()})
  }).collect()
 }
}
// Only the native transport sees credentials. Public worker observations omit
// connection configuration and are bound to the current verified package.
fn read_obs_config(app:&tauri::AppHandle)->Result<super::super::obs_transport::ObsConfig,String>{
 use tauri::Manager;
 let state=app.state::<crate::state::AppState>();let inner=state.0.lock().map_err(|_|"obs_state_poisoned")?;
 Ok(inner.obs_config.clone())
}
fn backend_identity(app:&tauri::AppHandle)->Result<(String,String),String>{
 use tauri::Manager;use sha2::{Digest,Sha256};
 let token={let state=app.state::<crate::state::AppState>();let inner=state.0.lock().map_err(|_|"account_state_unavailable")?;inner.companion_token.clone().ok_or("account_not_connected")?};
 let account=crate::storage::load_session(app).map(|s|format!("session:{}",s.email.trim().to_lowercase())).unwrap_or_else(||format!("legacy:{:x}",Sha256::digest(token.as_bytes())));
 let authority=format!("{:x}",Sha256::digest(format!("{}\0{account}",crate::state::DEFAULT_BACKEND_URL).as_bytes()));Ok((token,authority))
}
fn drain_ui_backend(worker:&WorkerProcess)->Result<(),String>{
 let deadline=std::time::Instant::now()+Duration::from_secs(2);
 loop{match worker.ui_backend.try_lock(){
  Ok(_guard)=>return Ok(()),Err(std::sync::TryLockError::Poisoned(_))=>return Err("backend_ui_state_poisoned".into()),Err(std::sync::TryLockError::WouldBlock)=>{},
 }if std::time::Instant::now()>=deadline{return Err("backend_ui_stop_unproven".into());}std::thread::sleep(Duration::from_millis(5));}
}
fn read_unknown_setting(app:&tauri::AppHandle,pin:&Pin,action:&super::super::plugin_audio::store::Action,read_id:Option<&str>)->Result<companion_plugin_protocol::backend::Response,String>{
 use companion_plugin_protocol::backend::Method;
 let super::super::plugin_audio::store::Action::BackendSetting{request,resource_hash,authority:owner}=action else{return Err("backend_setting_scope_mismatch".into());};
 let(token,authority)=backend_identity(app)?;
 let write=pin.backend_resources.get(&request.resource).ok_or("backend_resource_denied")?;
 let (id,read)=pin.backend_resources.iter().find(|(id,r)|r.method==Method::Get&&r.path==write.path&&read_id.is_none_or(|wanted|wanted==id.as_str())).ok_or("backend_resource_denied")?;
 let current_hash=packages::hash(&serde_json::to_vec(write).map_err(|_|"backend_resource_denied")?);
 if *owner!=authority||*resource_hash!=current_hash||write.method!=Method::Put{return Err("backend_reconciliation_scope_mismatch".into());}
 let mut query=request.clone();query.resource=id.clone();query.body=None;read.authorize(&query)?;
 Ok(crate::backend::plugin_request_pinned(app,read,&query,&token))
}
fn reconcile_stopped_setting(app:&tauri::AppHandle,audio:&HostAudio,process:&ProcessBinding,epoch:u64,verified:impl FnOnce()->Result<Pin,String>)->Result<(),String>{
 audio.reconcile_setting_after_native_exit(process,epoch,|action|{
  let pin=verified()?;if pin.binding()!=&process.package||!pin.permits("backend.access"){return Err("process_binding_denied".into());}
  read_unknown_setting(app,&pin,action,None)
 })
}
fn reconcile_stopped_scenes(app:&tauri::AppHandle,audio:&HostAudio,process:&ProcessBinding,epoch:u64)->Result<(),String>{
 audio.reconcile_scenes_after_native_exit(process,epoch,|desired,target|{
  let config=read_obs_config(app)?;if config.transport_identity(&process.package.id)?!=target{return Err("obs_operation_target_changed".into());}
  let current=super::super::obs_transport::program_scene_before(&config.connection(),std::time::Instant::now()+std::time::Duration::from_millis(500)).map_err(|_|"obs_fence_unconfirmed")?;
  Ok(current==desired&&read_obs_config(app)?.transport_identity(&process.package.id)?==target)
 })
}
impl Task{
 fn scene_observation(&self)->Result<Option<companion_plugin_protocol::obs::SceneObservation>,String>{
  use companion_plugin_protocol::obs::SceneObservation;use std::time::{Instant,Duration,SystemTime,UNIX_EPOCH};
  if !self.worker.pin.permits("obs.scene"){return Ok(None);}
  let config=read_obs_config(&self.app)?;
  let now=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|"clock_unavailable")?.as_millis() as u64;
  let revision=config.plugin_revision(&self.worker.pin.package.id,&self.worker.pin.obs_bindings)?;
  let cached=self.worker.scene_observation.lock().map_err(|_|"obs_observation_poisoned")?.clone()
   .filter(|s|s.config_revision==revision&&s.fresh(now));
  if cached.as_ref().is_some_and(|s|now-s.observed_at_ms<1000){return Ok(cached);}
  if self.worker.obs_querying.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_ok(){
   let worker=self.worker.clone();let app=self.app.clone();let flag=worker.obs_querying.clone();
   let spawn=std::thread::Builder::new().name("plugin-obs-observation".into()).spawn(move||{
    struct Release(Arc<AtomicBool>);impl Drop for Release{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
    let _release=Release(worker.obs_querying.clone());
    let connection=super::super::obs_transport::ConnectionSettings{host:&config.host,port:config.port,password:&config.password};
    let snapshot=super::super::obs_transport::snapshot_before(&connection,Instant::now()+Duration::from_millis(500)).ok();
    // A result from an old endpoint/configuration is never fresh authority.
    let Ok(current)=read_obs_config(&app)else{return;};
    if !current.same_transport(&config)||current.plugin_revision(&worker.pin.package.id,&worker.pin.obs_bindings).ok().as_ref()!=Some(&revision){return;}
    let Ok(bindings)=config.plugin_bindings(&worker.pin.package.id,&worker.pin.obs_bindings)else{return;};
    let Ok(time)=SystemTime::now().duration_since(UNIX_EPOCH)else{return;};let observed_at_ms=time.as_millis() as u64;
    let observation=SceneObservation{observed_at_ms,config_revision:revision,enabled:config.enabled,bindings,current_scene:snapshot.as_ref().map(|s|s.current_scene.clone()),scenes:snapshot.as_ref().map(|s|s.scenes.clone()).unwrap_or_default(),streaming:snapshot.map(|s|s.streaming)};
    if observation.validate().is_err(){return;}
    if let Ok(mut scene)=worker.scene_observation.lock(){*scene=Some(observation);}
   });
   if spawn.is_err(){flag.store(false,Ordering::SeqCst);return Err("obs_observer_unavailable".into());}
  }
  Ok(cached)
 }
 fn scene_intent(&self,intent:&companion_plugin_protocol::obs::SceneIntent,context:Option<&str>)->Result<companion_plugin_protocol::obs::SceneReceipt,String>{
  use std::time::{Instant,Duration};use companion_plugin_protocol::{obs::SceneReceipt,audio::Status};
  if !self.worker.pin.permits("obs.scene")||intent.operation_key.is_empty()||intent.operation_key.len()>128||intent.context.as_deref()!=context{return Err("invalid_scene_intent".into());}
  self.audio.locked_authorize(&self.worker.binding,self.worker.epoch)?;
  let config=read_obs_config(&self.app)?;
  if !config.enabled||config.plugin_revision(&self.worker.pin.package.id,&self.worker.pin.obs_bindings)?!=intent.config_revision{return Err("obs_configuration_changed".into());}
  let mappings=config.plugin_bindings(&self.worker.pin.package.id,&self.worker.pin.obs_bindings)?;let name=mappings.get(&intent.semantic).filter(|s|!s.is_empty()).ok_or("obs_semantic_denied")?;
  let key=super::super::plugin_audio::store::ordered_key(&self.worker.binding.generation,self.worker.epoch,&intent.operation_key)?;
  let action=super::super::plugin_audio::store::Action::Scene{name:name.clone(),config_revision:Some(intent.config_revision.clone()),transport_identity:Some(config.transport_identity(&self.worker.pin.package.id)?),context:intent.context.clone()};
  let receipt=self.audio.scene(&self.worker.pin,&self.worker.binding,self.worker.epoch,&key,action,|may_write|{
   let deadline=Instant::now()+Duration::from_millis(1500);
   let connection=super::super::obs_transport::ConnectionSettings{host:&config.host,port:config.port,password:&config.password};
   let status=if may_write{super::super::obs_transport::reconcile_scene_status(name,||super::super::obs_transport::program_scene_before(&connection,deadline),||super::super::obs_transport::set_program_scene_before(&connection,name,deadline))}
    else{if super::super::obs_transport::program_scene_before(&connection,deadline).is_ok_and(|current|current==*name){Status::Completed}else{Status::Unknown}};
   Ok(if read_obs_config(&self.app)?.same_transport(&config){status}else{Status::Unknown})
  })?;
  // Queued/playing do not describe a synchronous scene operation.
  if !matches!(receipt.status,Status::Completed|Status::Unknown|Status::Cancelled){return Err("obs_receipt_invalid".into());}
  Ok(SceneReceipt{operation_key:intent.operation_key.clone(),status:receipt.status})
 }
 fn stream_observation(&self,scene:Option<&companion_plugin_protocol::obs::SceneObservation>)->Result<companion_plugin_protocol::obs::StreamObservation,String>{
  use companion_plugin_protocol::obs::StreamObservation;
  let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"clock_unavailable")?.as_millis() as u64;
  // The same bounded read-only probe supplies both observations. Never wait on
  // an OBS socket here, or reinterpret an expired/missing observation as stop.
  Ok(scene.filter(|s|s.fresh(now)).map(|s|StreamObservation{observed_at_ms:s.observed_at_ms,streaming:s.streaming})
   .unwrap_or(StreamObservation{observed_at_ms:now,streaming:None}))
 }
 fn poll(&self,stopping:&AtomicBool)->Result<(),String>{
  if stopping.load(Ordering::SeqCst){return Err("core_shutdown".into());}
  let worker=&self.worker;
  // OBS IO is outside both process command and history locks. An unavailable
  // transport supplies None; it can never fabricate an authoritative stop.
  let scene_observation=self.scene_observation()?;
  let observation=self.stream_observation(scene_observation.as_ref())?;
  let mut runtime=self.host.0.lock().map_err(|_|locked())?;
  let scene_receipt=worker.scene_receipt.lock().map_err(|_|"obs_receipt_poisoned")?.take();
  let chat=if worker.pin.permits("chat.read"){
   let now=u64::try_from(chrono::Utc::now().timestamp_millis()).map_err(|_|"clock_unavailable")?;
   self.app.state::<crate::state::AppState>().0.lock().map_err(|_|"account_state_unavailable")?.core.plugin_chat(now)
  }else{None};
  let args=serde_json::json!({"streamObservation":observation,"sceneObservation":scene_observation,"sceneReceipt":scene_receipt,"chat":chat});
  let value=if worker.pin.permits("backend.access"){
   runtime.command_verified_reader(&worker.pin,&worker.binding,args,|value|{
    use companion_plugin_protocol::backend::{Request,Response};
    let request:Request=serde_json::from_value(value).map_err(|_|"invalid_backend_request")?;
    self.audio.locked_authorize(&worker.binding,worker.epoch)?;
    let response=if let Some(resource)=worker.pin.backend_resources.get(&request.resource){
     resource.authorize(&request)?;
     let resource=resource.clone();let call=request.clone();let app=self.app.clone();
     worker.backend_io.lock().map_err(|_|"backend_state_poisoned")?.poll(&request,move||crate::backend::plugin_request(&app,&resource,&call))?
    }else{Response::failed(&request,"backend_resource_denied")};
    serde_json::to_value(response).map_err(|_|"backend_response_invalid".into())
   })?
  }else{runtime.command_verified(&worker.pin,&worker.binding,"host.poll".into(),args)?};
  // Keep child command serialization through admission/emit. A UI command
  // cannot change the worker's committed context between its reply and our
  // use of these intents. play() never waits for a frontend ACK and there is
  // no history mutex in this process or callback back into PluginManager.
  let batch:Batch=serde_json::from_value(value).map_err(|_|"invalid_worker_batch")?;
  if batch.sound_intents.len()>32||batch.status.get("active")!=Some(&Value::Bool(true)){return Err("worker_admission_closed".into());}
  if !batch.sound_intents.is_empty(){verify_frontend_in_host(&self.app)?;}
  let context=match batch.status.get("context"){Some(Value::Null)=>None,Some(Value::String(s))if !s.is_empty()&&s.len()<=128=>Some(s.as_str()),_=>return Err("invalid_worker_context".into())};
  let next_context=context.map(str::to_string);
  let mut previous=worker.effect_context.lock().map_err(|_|"effect_context_poisoned")?;
  if previous.as_ref().is_some_and(|old|old!=&next_context){
   // The child command lock prevents a concurrent session edit until pending
   // and active audio from the previous committed scope is actually fenced.
   self.audio.fence(&worker.pin.package.id,|request|self.app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
   self.audio.reopen(&worker.pin.package.id)?;
  }
  *previous=Some(next_context);drop(previous);
  if let Some(intent)=batch.scene_intent{
   let receipt=self.scene_intent(&intent,context)?;
   let blocked=receipt.status==companion_plugin_protocol::audio::Status::Unknown;
   *worker.scene_receipt.lock().map_err(|_|"obs_receipt_poisoned")?=Some(receipt);
   if blocked{return Ok(());}
  }
  for sound in batch.sound_intents{
   if stopping.load(Ordering::SeqCst){return Err("core_shutdown".into());}
   if sound.operation_key.is_empty()||sound.operation_key.len()>128||sound.context.as_ref().is_some_and(|s|s.is_empty()||s.len()>128){return Err("invalid_sound_intent".into());}
   if sound.context.as_deref()!=context{return Err("effect_context_mismatch".into());}
   if runtime.snapshot().phase!=Phase::Running{return Err("plugin_process_requires_recovery".into());}
   let key=super::super::plugin_audio::store::ordered_key(&worker.binding.generation,worker.epoch,&sound.operation_key)?;
   if let Some(text)=sound.speech{
    if !sound.asset_file.is_empty(){return Err("invalid_sound_intent".into());}
    self.audio.speak(&worker.pin,&worker.binding,worker.epoch,sound.context.as_deref(),&key,&text,sound.volume,sound.deadline_ms,|payload|self.app.emit_to("main","plugin-audio-play",payload).map_err(|_|"frontend_audio_emit_failed".into()))?;
   }else{
   self.audio.play(&worker.pin,&worker.binding,worker.epoch,sound.context.as_deref(),&worker.root.join("sounds"),&key,&sound.asset_file,sound.volume,sound.deadline_ms,
    |payload|self.app.emit_to("main","plugin-audio-play",payload).map_err(|_|"frontend_audio_emit_failed".into()))?;
   }
  }Ok(())
 }
}

impl PluginManager{
 fn asset_command(&self,id:&str,name:&str,args:Value,expected_version:Option<&str>)->Result<Value,String>{
  let (worker,app,audio,host)={
   let mut guard=self.service.lock().map_err(|_|locked())?;let service=guard.as_mut().map_err(|e|e.clone())?;
   let active=service.manifests.get(id).ok_or("not_installed")?;
   if expected_version!=Some(active.version.as_str()){return Err("stale_ui_package".into());}
   let (_,manifest)=service.worker_pin(id)?;
   if expected_version!=Some(manifest.version.as_str()){return Err("stale_ui_package".into());}
   let obs=matches!(name,"obs.settings"|"obs.save");let backend=name.starts_with("backend.");
   let permitted=if obs{manifest.permissions.iter().any(|p|p=="obs.scene")}else if backend{manifest.permissions.iter().any(|p|p=="backend.access")}else{name=="directory.pick"||name=="image.import"||manifest.permissions.iter().any(|p|p=="audio.play")};
   if !manifest.permissions.iter().any(|p|p=="ui")||!permitted
    ||(!obs&&!backend&&!manifest.permissions.iter().any(|p|matches!(p.as_str(),"data.legacy"|"data.private")))||!manifest.ui_commands.iter().any(|c|c==name){return Err("capability_denied".into());}
   service.open_worker(id)?;
   let worker=service.workers.get(id).cloned().ok_or("not_running")?;
   let (app,audio)=service.native.as_ref().ok_or("plugin_transport_unavailable")?;
   (worker,app.clone(),audio.clone(),service.hosts.get(id).cloned().ok_or("not_running")?)
  };
  audio.locked_authorize(&worker.binding,worker.epoch)?;
  match name{
   "backend.pending"=>{
    if args!=serde_json::json!({}){return Err("invalid_backend_request".into());}
    serde_json::to_value(audio.pending_backend_setting(&worker.pin,&worker.binding,worker.epoch)?).map_err(|_|"backend_response_invalid".into())
   },
   "backend.request"|"backend.reconcile"=>{
    use companion_plugin_protocol::backend::{Method,Request};
    let _ui=worker.ui_backend.try_lock().map_err(|_|"backend_ui_busy")?;
    audio.locked_authorize(&worker.binding,worker.epoch)?;
    let public=|receipt:super::super::plugin_audio::store::Receipt|serde_json::json!({"operationKey":receipt.operation_key,"status":receipt.status,"response":receipt.backend_response,"reconciled":receipt.reconciled});
    let apply=|resource:&str,body:Option<&Value>|->Result<(),String>{
     if let Some(body)=body{let mut runtime=host.0.lock().map_err(|_|locked())?;audio.locked_authorize(&worker.binding,worker.epoch)?;let confirmed=runtime.command_verified(&worker.pin,&worker.binding,"host.resource".into(),serde_json::json!({"resource":resource,"body":body}))?;
      if confirmed.get("applied")!=Some(&Value::Bool(true)){return Err("worker_resource_apply_unconfirmed".into());}
     }Ok(())
    };
    if name=="backend.reconcile"{
     #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Reconcile{read_resource:String}
     let args:Reconcile=serde_json::from_value(args).map_err(|_|"invalid_backend_request")?;
     let receipt=audio.pending_backend_setting(&worker.pin,&worker.binding,worker.epoch)?.ok_or("backend_setting_not_found")?;
     let super::super::plugin_audio::store::Action::BackendSetting{request,..}=&receipt.action else{return Err("backend_setting_scope_mismatch".into());};
     let confirmed=audio.reconcile_backend_setting(&worker.pin,&worker.binding,worker.epoch,&receipt.operation_key,&receipt.action,||read_unknown_setting(&app,&worker.pin,&receipt.action,Some(&args.read_resource)))?;
     apply(&request.resource,confirmed.backend_response.as_ref().and_then(|r|r.body.as_ref()))?;
     Ok(public(confirmed))
    }else{
     let(token,authority)=backend_identity(&app)?;
     #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Arguments{request:Request}
     let args:Arguments=serde_json::from_value(args).map_err(|_|"invalid_backend_request")?;let request=args.request;
     let resource=worker.pin.backend_resources.get(&request.resource).ok_or("backend_resource_denied")?;resource.authorize(&request)?;
     match resource.method{
      Method::Get=>{let response=crate::backend::plugin_request_pinned(&app,resource,&request,&token);if response.error.is_some()||!response.status.is_some_and(|s|(200..300).contains(&s)){return Err(response.error.unwrap_or("backend_read_failed".into()));}apply(&request.resource,response.body.as_ref())?;Ok(serde_json::json!({"operationKey":request.operation_key,"status":"completed","response":response}))},
      Method::Put=>{
       let id=request.operation_key.strip_prefix("setting:").ok_or("invalid_backend_setting_key")?;
       if uuid::Uuid::parse_str(id).map_err(|_|"invalid_backend_setting_key")?.to_string()!=id{return Err("invalid_backend_setting_key".into());}
       let action=super::super::plugin_audio::store::Action::BackendSetting{request:request.clone(),resource_hash:packages::hash(&serde_json::to_vec(resource).map_err(|_|"backend_resource_denied")?),authority};
       let receipt=audio.backend_setting(&worker.pin,&worker.binding,worker.epoch,&request.operation_key,action,||crate::backend::plugin_request_pinned(&app,resource,&request,&token))?;
       if receipt.status==companion_plugin_protocol::audio::Status::Completed{apply(&request.resource,receipt.backend_response.as_ref().and_then(|r|r.body.as_ref()))?;}Ok(public(receipt))
      },
      Method::Post=>Err("backend_ui_method_denied".into()),
     }
    }
   },
   "obs.settings"|"obs.save"=>{
    use tauri::Manager;use std::time::{Duration,Instant};
    let _runtime=host.0.lock().map_err(|_|locked())?;
    audio.locked_authorize(&worker.binding,worker.epoch)?;
    let mut config=read_obs_config(&app)?;config.validate()?;let probed=config.clone();
    let mut snapshot=super::super::obs_transport::snapshot_before(&config.connection(),Instant::now()+Duration::from_millis(500)).ok();
    if name=="obs.save"{
     #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Mapping{expected_revision:String,bindings:std::collections::BTreeMap<String,String>}
     let change:Mapping=serde_json::from_value(args).map_err(|_|"invalid_ui_arguments")?;
     if snapshot.as_ref().is_some_and(|state|change.bindings.values().any(|name|!state.scenes.contains(name))){return Err("obs_mapped_scene_missing".into());}
     let state=app.state::<crate::state::AppState>();let mut inner=state.0.lock().map_err(|_|"obs_state_poisoned")?;
     // Compare immediately before the actual config write, never overwrite a
     // concurrent core setting change with the older network-probe snapshot.
     config=inner.obs_config.clone();
     config.update_plugin_bindings(id,&worker.pin.obs_bindings,&change.expected_revision,change.bindings)?;
     audio.locked_authorize(&worker.binding,worker.epoch)?;crate::storage::save_obs_config(&app,&config).map_err(|_|"obs_configuration_write_failed")?;inner.obs_config=config.clone();
    }else{if args!=serde_json::json!({}){return Err("invalid_ui_arguments".into());}config=read_obs_config(&app)?;}
    if config.host!=probed.host||config.port!=probed.port||config.password!=probed.password{snapshot=None;}
    audio.locked_authorize(&worker.binding,worker.epoch)?;
    let result=serde_json::json!({"configRevision":config.plugin_revision(id,&worker.pin.obs_bindings)?,"bindings":config.plugin_bindings(id,&worker.pin.obs_bindings)?,"enabled":config.enabled,"scenes":snapshot.as_ref().map(|s|s.scenes.clone()).unwrap_or_default(),"connected":snapshot.is_some()});
    let _=app.emit("obs-status",app.state::<crate::state::AppState>().snapshot());Ok(result)
   },
   "audio.receipt"=>{
    #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Query{operation_key:String}
    let query:Query=serde_json::from_value(args).map_err(|_|"invalid_ui_arguments")?;
    if query.operation_key.is_empty()||query.operation_key.len()>128{return Err("invalid_ui_arguments".into());}
    let key=super::super::plugin_audio::store::ordered_key(&worker.binding.generation,worker.epoch,&query.operation_key)?;
    let receipt=audio.receipt(id,&key)?;
    if receipt.as_ref().is_some_and(|r|!matches!(r.action,super::super::plugin_audio::store::Action::Sound{..}|super::super::plugin_audio::store::Action::Speech{..})||r.process.generation!=worker.binding.generation||r.process.package!=worker.binding.package){return Err("receipt_scope_denied".into());}
    Ok(serde_json::json!({"receipt":receipt}))
   },
   "directory.pick"=>{
    if args!=serde_json::json!({}){return Err("invalid_ui_arguments".into());}
    self.begin(Some(id.into()),"file_selection")?;
    let result=(||{
     use tauri_plugin_dialog::DialogExt;
     let picked=app.dialog().file().blocking_pick_folder().ok_or("file_selection_cancelled")?;
     let path=picked.into_path().map_err(|_|"selected_directory_invalid")?.canonicalize().map_err(|_|"selected_directory_unavailable")?;
     if !path.is_dir()||path.to_str().is_none_or(|p|p.len()>4096){return Err("selected_directory_invalid".into());}
     audio.locked_authorize(&worker.binding,worker.epoch)?;
     let host={let guard=self.service.lock().map_err(|_|locked())?;guard.as_ref().map_err(Clone::clone)?.hosts.get(id).cloned().ok_or("not_running")?};
     let value=host.0.lock().map_err(|_|locked())?.command_verified(&worker.pin,&worker.binding,"host.directory".into(),serde_json::json!({"path":path}))?;
     Ok(value)
    })();self.finish(&result.as_ref().map(|_|()).map_err(Clone::clone));result
   },
   "asset.import"|"image.import"=>{
    if args!=serde_json::json!({}){return Err("invalid_ui_arguments".into());}
    self.begin(Some(id.into()),"file_selection")?;
    let result=(||{
    use tauri_plugin_dialog::DialogExt;
    let picker=app.dialog().file();let picker=if name=="image.import"{picker.add_filter("Image",&["png","jpg","jpeg","webp"])}else{picker.add_filter("Audio",&["wav","mp3","ogg"])};
    let picked=picker.blocking_pick_file().ok_or("file_selection_cancelled")?;
    let source=picked.into_path().map_err(|_|"audio_source_invalid")?;
    // A modal picker can outlive disable/replacement; never continue under a
    // generation which lost admission while the user was choosing a file.
    audio.locked_authorize(&worker.binding,worker.epoch)?;
    let imported=if name=="image.import"{super::super::plugin_audio::assets::import_selected_image(&worker.root,&source)?}else{super::super::plugin_audio::assets::import_selected(&worker.root,&source)?};
    serde_json::to_value(imported).map_err(|_|"asset_encoding_failed".into())
    })();self.finish(&result.as_ref().map(|_|()).map_err(Clone::clone));result
   },
   "asset.preview"=>{
    verify_frontend_in_host(&app)?;
    #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Preview{file_name:String,volume:u8}
    let p:Preview=serde_json::from_value(args).map_err(|_|"invalid_ui_arguments")?;
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"clock_unavailable")?.as_millis() as u64;
    let receipt=audio.play(&worker.pin,&worker.binding,worker.epoch,None,&worker.root.join("sounds"),&format!("preview:{}",uuid::Uuid::new_v4()),&p.file_name,p.volume,now.saturating_add(5000),
     |payload|app.emit_to("main","plugin-audio-play",payload).map_err(|_|"frontend_audio_emit_failed".into()))?;
    serde_json::to_value(receipt).map_err(|_|"receipt_encoding_failed".into())
   },
   _=>Err("command_not_allowed".into()),
  }
 }
 pub(super) fn ui_command(&self,id:&str,name:String,args:Value,expected_version:Option<&str>)->Result<Value,String>{
  if name.starts_with("host.")||name.len()>64||serde_json::to_vec(&args).map_err(|_|"invalid_ui_request")?.len()>8192{return Err("command_not_allowed".into());}
  if matches!(name.as_str(),"asset.import"|"image.import"|"asset.preview"|"directory.pick"|"audio.receipt"|"obs.settings"|"obs.save"|"backend.request"|"backend.pending"|"backend.reconcile"){return self.asset_command(id,&name,args,expected_version);}
  let (host,process)={
   let mut guard=self.service.lock().map_err(|_|locked())?;let service=guard.as_mut().map_err(|e|e.clone())?;
   let manifest=service.manifests.get(id).cloned().ok_or("not_installed")?;
   if !manifest.permissions.iter().any(|p|p=="ui"){return Err("capability_denied".into());}
   if manifest.min_api>=2&&expected_version!=Some(manifest.version.as_str()){return Err("stale_ui_package".into());}
   if manifest.min_api>=2&&manifest.execution==packages::ExecutionMode::Live{
    if !manifest.ui_commands.contains(&name){return Err("command_not_allowed".into());}
    service.open_worker(id)?;let worker=service.workers.get(id).ok_or("not_running")?;
    (service.hosts.get(id).cloned().ok_or("not_running")?,Some((worker.pin.clone(),worker.binding.clone())))
   }else{
    if manifest.execution!=packages::ExecutionMode::ReplayOnly||name!="greet"{return Err("command_not_allowed".into());}
    (service.hosts.get(id).cloned().ok_or("not_running")?,None)
   }
  };
  // Release Manager before awaiting child IO. Binding is rechecked inside the
  // Runtime; a concurrent disable/replacement cannot redirect this request.
  let mut runtime=host.0.lock().map_err(|_|locked())?;
  match process{Some((pin,binding))=>runtime.command_verified(&pin,&binding,name,args),None=>runtime.command(name,args)}
 }
 /// Hooked up only when the remaining legacy bootstrap is removed. Startup does
 /// not migrate game history, enable a plugin, or start an installed live worker.
 pub(crate) fn attach_worker_host(&self,app:tauri::AppHandle,audio:Arc<HostAudio>)->Result<(),String>{
  let mut guard=self.service.lock().map_err(|_|locked())?;let service=guard.as_mut().map_err(|e|e.clone())?;
  service.native=Some((app,audio));Ok(())
 }
 pub(crate) fn consume_workers(&self){
  let manager=self.clone();std::thread::spawn(move||{
   while !manager.shutting_down.load(Ordering::SeqCst){
    std::thread::sleep(Duration::from_millis(50));
    let tasks=match manager.service.try_lock(){Ok(guard)=>guard.as_ref().map(Service::tasks).unwrap_or_default(),Err(_)=>vec![]};
    for task in tasks{
     let manager=manager.clone();std::thread::spawn(move||{
      let _in_flight=PollGuard(task.worker.polling.clone());
      // No Manager or history lock while waiting on IPC. At most one bounded
      // command per process is in flight; no unbounded scheduler backlog.
      if let Err(error)=task.poll(&manager.shutting_down){
       if let Ok(mut guard)=manager.service.lock(){if let Ok(service)=guard.as_mut(){
        let id=task.worker.binding.package.id.clone();
        if service.workers.get(&id).is_some_and(|w|w.active&&w.binding==task.worker.binding&&w.epoch==task.worker.epoch){
         let stopped=service.stop_worker(&id);let error=stopped.err().map_or(error.clone(),|stop|format!("{error}; stop: {stop}"));
         crate::storage::append_rolling_log(&task.app,&format!("[plugins] {id}: {error}"));service.errors.insert(id,error);
        }
       }}
      }
     });
    }
   }
  });
 }
}
