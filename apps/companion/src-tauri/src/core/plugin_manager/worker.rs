//! Installed API2 workers use the existing manager, Runtime and host transport.
//! No game types, listener, SQL/history writer or credential access in this adapter.
use super::*;
use companion_plugin_protocol::{PackageBinding,ProcessGrant,runtime::ProcessBinding};
use super::super::plugin_audio::{HostAudio,store::ProcessPhase};
use serde::Deserialize;
use tauri::Emitter;

#[derive(Clone)]
struct Pin{package:PackageBinding,executable:PathBuf,permissions:Vec<String>}
impl ProcessGrant for Pin{
 fn binding(&self)->&PackageBinding{&self.package}
 fn executable(&self)->&std::path::Path{&self.executable}
 fn permits(&self,cap:&str)->bool{self.permissions.iter().any(|p|p==cap)}
}
#[derive(Clone)]
pub(super) struct WorkerProcess{pin:Pin,binding:ProcessBinding,epoch:u64,root:PathBuf,active:bool,polling:Arc<AtomicBool>}
struct Task{worker:WorkerProcess,host:PluginHost,app:tauri::AppHandle,audio:Arc<HostAudio>}
struct PollGuard(Arc<AtomicBool>);
impl Drop for PollGuard{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Batch{status:Value,sound_intents:Vec<SoundIntent>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SoundIntent{operation_key:String,asset_file:String,volume:u8,deadline_ms:u64,context:Option<String>}

impl Service{
 fn worker_pin(&self,id:&str)->Result<(Pin,Manifest),String>{
  let installed=self.store.installed().get(id).cloned().ok_or("not_installed")?;
  let (executable,manifest)=self.store.executable(id,&installed.active)?;
  if manifest.min_api<2||manifest.execution!=packages::ExecutionMode::Live{return Err("plugin_update_required".into());}
  let package=PackageBinding{id:manifest.id.clone(),version:manifest.version.clone(),executable_hash:manifest.files.get(&manifest.executable).cloned().ok_or("executable_unbound")?,manifest_hash:packages::hash(&serde_json::to_vec(&manifest).map_err(|_|"invalid_manifest")?)};
  Ok((Pin{package,executable,permissions:manifest.permissions.clone()},manifest))
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
  self.workers.insert(id.into(),WorkerProcess{pin,binding:process,epoch,root,active:false,polling:Default::default()});self.manifests.insert(id.into(),manifest);Ok(())
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
  let worker=self.workers.get_mut(id).ok_or("not_running")?;
  if worker.active{return Err("already_active".into());}
  if pin.binding()!=worker.pin.binding(){return Err("process_binding_denied".into());}
  // Fencing cannot be skipped for a replayed/unknown audio admission. Waiting
  // here holds no worker history connection; frontend ACK never takes Manager.
  audio.fence(id,|request|app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
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
  audio.fence(id,|request|app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
  audio.process_after_native_exit(&worker.binding,worker.epoch)?;drop(runtime);
  self.store.enable(id,false)?;self.workers.remove(id);self.store.activate(id)?;
  drain.map(|_|())
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
  audio.fence(id,|request|app.emit_to("main","plugin-audio-fence",request).map_err(|_|"frontend_audio_unavailable".into()))?;
  audio.process_after_native_exit(&process,record.epoch)?;
  self.store.enable(id,false)?;self.store.activate(id)?;Ok(())
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
impl Task{
 fn poll(&self,stopping:&AtomicBool)->Result<(),String>{
  if stopping.load(Ordering::SeqCst){return Err("core_shutdown".into());}
  let worker=&self.worker;
  let value={let mut runtime=self.host.0.lock().map_err(|_|locked())?;
   runtime.command_verified(&worker.pin,&worker.binding,"host.poll".into(),serde_json::json!({}))?};
  let batch:Batch=serde_json::from_value(value).map_err(|_|"invalid_worker_batch")?;
  if batch.sound_intents.len()>32||batch.status.get("active")!=Some(&Value::Bool(true)){return Err("worker_admission_closed".into());}
  for sound in batch.sound_intents{
   if stopping.load(Ordering::SeqCst){return Err("core_shutdown".into());}
   if sound.operation_key.is_empty()||sound.operation_key.len()>128||sound.context.as_ref().is_some_and(|s|s.is_empty()||s.len()>128){return Err("invalid_sound_intent".into());}
   let key=format!("{}:{}",worker.binding.generation,packages::hash(sound.operation_key.as_bytes()));
   self.audio.play(&worker.pin,&worker.binding,worker.epoch,sound.context.as_deref(),&worker.root.join("sounds"),&key,&sound.asset_file,sound.volume,sound.deadline_ms,
    |payload|self.app.emit_to("main","plugin-audio-play",payload).map_err(|_|"frontend_audio_emit_failed".into()))?;
  }Ok(())
 }
}

impl PluginManager{
 fn asset_command(&self,id:&str,name:&str,args:Value)->Result<Value,String>{
  let (worker,app,audio)={
   let mut guard=self.service.lock().map_err(|_|locked())?;let service=guard.as_mut().map_err(|e|e.clone())?;
   let (_,manifest)=service.worker_pin(id)?;
   if !manifest.permissions.iter().any(|p|p=="ui")||!manifest.permissions.iter().any(|p|p=="audio.play")
    ||!manifest.permissions.iter().any(|p|matches!(p.as_str(),"data.legacy"|"data.private"))||!manifest.ui_commands.iter().any(|c|c==name){return Err("capability_denied".into());}
   service.open_worker(id)?;
   let worker=service.workers.get(id).cloned().ok_or("not_running")?;
   let (app,audio)=service.native.as_ref().ok_or("plugin_transport_unavailable")?;
   (worker,app.clone(),audio.clone())
  };
  audio.locked_authorize(&worker.binding,worker.epoch)?;
  match name{
   "asset.import"=>{
    if args!=serde_json::json!({}){return Err("invalid_ui_arguments".into());}
    self.begin(Some(id.into()),"file_selection")?;
    let result=(||{
    use tauri_plugin_dialog::DialogExt;
    let picked=app.dialog().file().add_filter("Audio",&["wav","mp3","ogg"]).blocking_pick_file().ok_or("file_selection_cancelled")?;
    let source=picked.into_path().map_err(|_|"audio_source_invalid")?;
    // A modal picker can outlive disable/replacement; never continue under a
    // generation which lost admission while the user was choosing a file.
    audio.locked_authorize(&worker.binding,worker.epoch)?;
    serde_json::to_value(super::super::plugin_audio::assets::import_selected(&worker.root,&source)?).map_err(|_|"asset_encoding_failed".into())
    })();self.finish(&result.as_ref().map(|_|()).map_err(Clone::clone));result
   },
   "asset.preview"=>{
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
 pub(super) fn ui_command(&self,id:&str,name:String,args:Value)->Result<Value,String>{
  if name.starts_with("host.")||name.len()>64||serde_json::to_vec(&args).map_err(|_|"invalid_ui_request")?.len()>8192{return Err("command_not_allowed".into());}
  if matches!(name.as_str(),"asset.import"|"asset.preview"){return self.asset_command(id,&name,args);}
  let (host,process)={
   let mut guard=self.service.lock().map_err(|_|locked())?;let service=guard.as_mut().map_err(|e|e.clone())?;
   let manifest=service.manifests.get(id).cloned().ok_or("not_installed")?;
   if !manifest.permissions.iter().any(|p|p=="ui"){return Err("capability_denied".into());}
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
 pub(super) fn attach_worker_host(&self,app:tauri::AppHandle,audio:Arc<HostAudio>)->Result<(),String>{
  let mut guard=self.service.lock().map_err(|_|locked())?;let service=guard.as_mut().map_err(|e|e.clone())?;
  service.native=Some((app,audio));Ok(())
 }
 pub(super) fn consume_workers(&self){
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
