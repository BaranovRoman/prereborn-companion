//! Production request/receipt bridge. Manager pin -> process mutex -> existing history mutex.
//! The reverse callback uses the already held pin, never reacquires PluginManager.
use super::*;
use crate::{core::{plugin_manager::{PluginManager,MatchExecutionGrant},plugin_runtime::{Runtime,ProcessBinding}},local_runtime::{LocalRuntimeState,host_execution::Prepared}};
use companion_dota_domain::{match_execution::*,effects::{Effect,Status as EffectStatus},contracts::{ReplayInput,ReplayContext}};
use serde_json::Value;
use tauri::{AppHandle,Manager};
pub(crate) struct LiveProcess {runtime:Mutex<Runtime>,binding:ProcessBinding,grant:MatchExecutionGrant}
impl LiveProcess {
 fn start(manager:&PluginManager,history:&LocalRuntimeState,grant:MatchExecutionGrant)->Result<Self,String> {
  let mut runtime=Runtime::default();let generation=uuid::Uuid::new_v4().to_string();
  let binding=manager.with_verified_match_grant(&grant,|pin|{
   history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::process_starting(c,grant.lease,grant.binding(),&generation))?;
   let binding=match runtime.start_verified_generation(pin,generation.clone()) {Ok(b)=>b,Err(e)=>{runtime.stopped_confirmed()?;history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::process_stopped(c,&generation))?;return Err(e);}};
   let pid=runtime.diagnostic_process_id().ok_or("process_identity_missing")?;
   if let Err(e)=history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::process_spawned(c,&generation,pid)){let _=runtime.stop();return Err(e);}
   Ok(binding)
  })?;
  Ok(Self{runtime:Mutex::new(runtime),binding,grant})
 }
 pub(crate) fn process(&self,manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,frame:Frame,context:ReplayContext,
     mut dispatch:impl FnMut(&Effect,&str,&crate::local_runtime::host_execution::live_effects::EffectAdmission)->EffectStatus)->Result<(),String> {
  let _admission=gate.external(self.grant.lease)?;
  manager.with_verified_match_grant(&self.grant,|pin|{
   let mut runtime=self.runtime.lock().map_err(|_|"process_lock_poisoned")?;
   let scope=ExecutionScope{session:self.grant.session.clone(),epoch:self.grant.lease.epoch,run:self.binding.generation.clone()};
   // Short history lock; RELEASED before sending or waiting for any IPC.
   let prepared=history.with_transaction_adapter(|adapter,c|adapter.prepare_plugin_operation(c,pin,frame.snapshot.clone(),frame.at,frame.sequence))?;
   if let Some(prepared)=prepared {
    let key=if prepared.ticket.starts_with("telemetry:"){prepared.ticket.clone()}else{format!("match:{}:{}",scope.run,frame.sequence)};
    let input=execution_frame(&scope,&prepared,&key);
    let mut committed=None;
    let reply=runtime.command_live(pin,&self.binding,"dota.live_frame".into(),serde_json::to_value(&input).map_err(|_|"invalid_frame")?,|payload|{
     let _operation_admission=gate.external(self.grant.lease)?;
     let request:ExecutionRequest=serde_json::from_value(payload).map_err(|_|"invalid_execution_request")?;
     if !request.bounded(){return Err("invalid_execution_request".into());}
     let (received,operation)=match &request {
      ExecutionRequest::Execute{scope,sequence,snapshot_identity,request} if *sequence==frame.sequence&&snapshot_identity==&input.context.snapshot_identity=>(scope,request),
      _=>return Err("unsolicited_execution_request".into()),
     };
     if received!=&scope||operation.operation_key!=key||operation.ticket!=input.ticket||operation.binding!=input.binding{return Err("execution_scope_mismatch".into());}
     let response=history.with_transaction_adapter(|adapter,c|adapter.execute_plugin(c,pin,operation))?;
     committed=Some(response.clone());
     serde_json::to_value(ExecutionReply::Result{response}).map_err(|_|"invalid_receipt".into())
    })?;
    let response:ExecutionReply=serde_json::from_value(reply.get("reply").cloned().ok_or("missing_execution_reply")?).map_err(|_|"invalid_execution_reply")?;
    match response {ExecutionReply::Result{response} if response.status==EffectStatus::Completed&&Some(&response)==committed.as_ref()=>(),_=>return Err("match_result_unconfirmed".into())}
   }
   self.effects_locked(pin,&mut runtime,history,gate,frame,context,&mut dispatch)
  })
 }
 fn effects_locked(&self,pin:&crate::core::plugin_manager::VerifiedMatchGrant<'_>,runtime:&mut Runtime,history:&LocalRuntimeState,gate:&LiveDota,frame:Frame,context:ReplayContext,
     dispatch:&mut impl FnMut(&Effect,&str,&crate::local_runtime::host_execution::live_effects::EffectAdmission)->EffectStatus)->Result<(),String> {
   let scope=ExecutionScope{session:self.grant.session.clone(),epoch:self.grant.lease.epoch,run:self.binding.generation.clone()};
   let input=LiveEffectsFrame{obs_revision:gate.obs_revision(),deadline_ms:(chrono::Utc::now().timestamp_millis().max(0) as u64).saturating_add(2000),scope:scope.clone(),input:ReplayInput{sequence:frame.sequence,observed_at_ms:frame.at.timestamp_millis().max(0) as u64,snapshot:frame.snapshot,context,match_context:None}};
   // Only real scene transitions/sound detections create effect keys, never idle snapshots.
   let mut uncertain=false;
   let mut effect_indices=std::collections::HashSet::new();
   let result=runtime.command_live(pin,&self.binding,"dota.live_effects".into(),serde_json::to_value(&input).map_err(|_|"invalid_frame")?,|payload|{
    let _effect_admission=gate.external(self.grant.lease)?;
    if uncertain{return Err("effect_result_unknown".into());}
    let request:LiveEffectRequest=serde_json::from_value(payload).map_err(|_|"invalid_effect")?;
    let prefix=format!("effect:{}:{}:",scope.run,frame.sequence);
    let index=request.request.idempotency_key.strip_prefix(&prefix).and_then(|s|s.parse::<u8>().ok());
    if index.is_none_or(|n|n>=32||request.request.idempotency_key!=format!("{prefix}{n}")||!effect_indices.insert(n))||request.request.correlation_id!=request.request.idempotency_key{return Err("unsolicited_effect_request".into());}
    if request.scope!=scope||request.request.lease!=self.grant.lease{return Err("execution_scope_mismatch".into());}
    let admission=history.with_transaction_adapter(|adapter,c|adapter.admit_effect(c,pin,&request.request,chrono::Utc::now().timestamp_millis().max(0) as u64))?;
    let ack=if admission.fresh {
     // Ledger Unknown already committed. No history lock during transport or file IO.
     let outcome=dispatch(&request.request.effect,&request.request.correlation_id,&admission);
     history.with_transaction_adapter(|adapter,c|{if let Some(mut ack)=adapter.audio_result(c,&admission)?{if outcome==EffectStatus::Unknown{ack.status=EffectStatus::Unknown;}Ok(ack)}else{adapter.settle_effect(c,admission,outcome)}})?
    } else {admission.ack};
    uncertain=ack.status==EffectStatus::Unknown;
    serde_json::to_value(ack).map_err(|_|"invalid_ack".into())
   })?;
   if uncertain||result.get("blocked").and_then(Value::as_bool)!=Some(false){return Err("effect_result_unknown".into());}Ok(())
 }
 pub(crate) fn reconcile_obs(&self,manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,frame:Frame,context:ReplayContext,
     mut dispatch:impl FnMut(&Effect,&str,&crate::local_runtime::host_execution::live_effects::EffectAdmission)->EffectStatus)->Result<(),String> {
  let _admission=gate.external(self.grant.lease)?;
  manager.with_verified_match_grant(&self.grant,|pin|{
   let mut runtime=self.runtime.lock().map_err(|_|"process_lock_poisoned")?;
   self.effects_locked(pin,&mut runtime,history,gate,frame,context,&mut |effect,key,admission|{
    // This is a configuration/OBS observation, never fresh game evidence.
    if matches!(effect,Effect::Sound{..}){EffectStatus::Rejected}else{dispatch(effect,key,admission)}
   })
  })
 }

 pub(crate) fn recover(&self,manager:&PluginManager,history:&LocalRuntimeState,request:&Request)->Result<Response,String> {
  manager.with_verified_match_grant(&self.grant,|pin|{
   let scope=ExecutionScope{session:self.grant.session.clone(),epoch:self.grant.lease.epoch,run:self.binding.generation.clone()};
   let input=ExecutionRequest::Recover{scope:scope.clone(),request:request.clone()};
   let mut runtime=self.runtime.lock().map_err(|_|"process_lock_poisoned")?;
   let result=runtime.command_live(pin,&self.binding,"dota.live_recover".into(),serde_json::to_value(&input).map_err(|_|"invalid_request")?,|payload|{
    let received:ExecutionRequest=serde_json::from_value(payload).map_err(|_|"invalid_recovery")?;
    let ExecutionRequest::Recover{scope:received_scope,request:operation}=received else{return Err("invalid_recovery".into());};
    if !operation.bounded()||received_scope!=scope||serde_json::to_value(&operation).ok()!=serde_json::to_value(request).ok(){return Err("execution_scope_mismatch".into());}
    let response=history.with_transaction_adapter(|adapter,c|{
     let response=adapter.recover_plugin(c,pin,&operation)?;
     if response.status==EffectStatus::Unknown{adapter.record_unknown_plugin(c,pin,&operation)?;}Ok(response)
    })?;
    serde_json::to_value(ExecutionReply::Result{response}).map_err(|_|"invalid_receipt".into())
   })?;
   match serde_json::from_value::<ExecutionReply>(result.get("reply").cloned().ok_or("missing_receipt")?).map_err(|_|"invalid_receipt")?{
    ExecutionReply::Result{response}=>Ok(response),ExecutionReply::Denied{code}=>Err(code),
   }
  })
 }
 pub(crate) fn fallback(&self,history:&LocalRuntimeState,gate:&LiveDota,fence_and_reset_builtin:impl FnOnce()->Result<(),String>)->Result<Lease,String> {
  let old=self.grant.lease;let session=&self.grant.session;
  gate.switch(old,Owner::BuiltIn,Duration::from_secs(5),
   ||history.with_transaction_adapter(|_,c|{
    use companion_dota_domain::ownership::Phase;
    match crate::local_runtime::transaction_authorization::phase(c)? {
     Phase::Active(l) if l==old=>crate::local_runtime::transaction_authorization::begin(c,old,Owner::BuiltIn,session,None),
     Phase::Draining{old:held,target:Owner::BuiltIn} if held==old=>Ok(()),
     _=>Err("fallback_scope_mismatch".into()),
    }
   }),
   ||{let mut runtime=self.runtime.lock().map_err(|_|"process_lock_poisoned")?;let _=runtime.stop();runtime.stopped_confirmed()?;
      history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::process_stopped(c,&self.binding.generation))?;
      fence_and_reset_builtin()?;
      // Unknown audio may still be playing in WebView. A dead plugin is insufficient proof.
      let mut guard=history.try_lock().map_err(str::to_string)?;let c=guard.as_mut().ok_or("local_runtime_unavailable")?;
      if crate::local_runtime::host_execution::live_effects::quota(c)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}Ok(())},
   ||history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::confirm_fenced(c,old)),|_|Ok(()))
 }
 pub(crate) fn lifecycle(&mut self,manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,streaming:Option<bool>,snapshot:Option<&companion_dota_domain::contracts::ReplayGsi>,now:chrono::DateTime<chrono::Utc>)->Result<(),String> {
  self.lifecycle_controlled(manager,history,gate,streaming,snapshot,now,true).map(|_|())
 }
 fn lifecycle_controlled(&mut self,manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,streaming:Option<bool>,snapshot:Option<&companion_dota_domain::contracts::ReplayGsi>,now:chrono::DateTime<chrono::Utc>,sweep:bool)->Result<Option<bool>,String> {
  let _admission=gate.external(self.grant.lease)?;
  let resolved=manager.with_verified_match_grant(&self.grant,|pin|history.with_transaction_adapter(|a,c|a.external_lifecycle(c,pin,streaming,snapshot,now,sweep)))?;
  self.grant.session=resolved.session;Ok(resolved.stream_ended)
 }
 pub(crate) fn consume(mut self,app:AppHandle) {
  std::thread::spawn(move||{
   let gate=app.state::<LiveDota>();let manager=app.state::<PluginManager>();let history=app.state::<LocalRuntimeState>();
   let mut last_watchdog=Instant::now();
   let mut last_snapshot=companion_dota_domain::contracts::ReplayGsi::default();let mut reconciled=None;
   let mut last_lifecycle=Instant::now()-Duration::from_secs(2);
   loop {
    if gate.status().mode==Mode::External&&last_lifecycle.elapsed()>=Duration::from_secs(2) {
     let streaming={let state=app.state::<crate::state::AppState>();let inner=state.0.lock().unwrap();if inner.obs_watcher_connected {inner.obs_streaming}else{None}};
     let sweep=last_watchdog.elapsed()>=Duration::from_secs(60);
     match self.lifecycle_controlled(&manager,&history,&gate,streaming,None,chrono::Utc::now(),sweep) {
      Ok(Some(ended))=>crate::obs::handle_session_state(&app,ended),Ok(None)=>(),Err(e)=>gate.failed(self.grant.lease,&e),
     }
     if sweep{last_watchdog=Instant::now();}
     last_lifecycle=Instant::now();
    }
    if manager.stopping(){gate.failed(self.grant.lease,"core_shutdown");}
    match gate.status().mode {
     Mode::External=>if let Some(frame)=gate.next(){
      // Resolve using this exact snapshot before creating its bounded execution ticket.
      if let Err(e)=self.lifecycle_controlled(&manager,&history,&gate,None,Some(&frame.snapshot),frame.at,false){gate.failed(self.grant.lease,&e);continue;}
      {
       let reminder_admission=gate.external(self.grant.lease);
       let result=reminder_admission.and_then(|_admission|manager.with_verified_match_grant(&self.grant,|pin|crate::draft_reminder::handle_external(&app,&serde_json::to_value(&frame.snapshot).map_err(|_|"invalid_snapshot")?,pin,&format!("effect:{}:{}:draft",self.binding.generation,frame.sequence))));
       if let Err(e)=result{gate.failed(self.grant.lease,&e);continue;}
      }
      last_snapshot=frame.snapshot.clone();
      let context=current_effect_context(&app);
      let obs_revision=gate.obs_revision();
      if let Err(e)=self.process(&manager,&history,&gate,frame,context,|effect,correlation,admission|match effect{
       Effect::Sound{event_id,kind:Some(kind)}=>crate::game_sounds::dispatch_plugin_sound(&app,event_id,*kind,correlation,self.grant.lease,&self.grant.session,admission),
       Effect::ObsScene{state}=>crate::obs::dispatch_plugin_scene(&app,*state),
       Effect::Overlay{state}=>if gate.publish_overlay(self.grant.lease,*state).is_ok(){EffectStatus::Completed}else{EffectStatus::Rejected},
       _=>EffectStatus::Rejected,
      }){gate.failed(self.grant.lease,&e);}else{reconciled=Some(obs_revision);}
     }else{
      if reconciled!=Some(gate.obs_revision()) {
       let context=current_effect_context(&app);
       if let Some(frame)=gate.obs_frame(self.grant.lease,last_snapshot.clone(),context.clone()) {
        let revision=gate.obs_revision();
        match self.reconcile_obs(&manager,&history,&gate,frame,context,|effect,_,_|match effect{
         Effect::ObsScene{state}=>crate::obs::dispatch_plugin_scene(&app,*state),
         Effect::Overlay{state}=>if gate.publish_overlay(self.grant.lease,*state).is_ok(){EffectStatus::Completed}else{EffectStatus::Rejected},_=>EffectStatus::Rejected,
        }){Ok(())=>reconciled=Some(revision),Err(e)=>gate.failed(self.grant.lease,&e)}
       }
      }
      let running=self.runtime.lock().map(|mut r|r.snapshot().phase==crate::core::plugin_runtime::Phase::Running).unwrap_or(false);
      if !running{gate.failed(self.grant.lease,"process_crashed");}std::thread::sleep(Duration::from_millis(50));
     },
     Mode::Fallback=>{let _=self.fallback(&history,&gate,||{let audio=app.state::<crate::game_sounds::audio_fence::AudioFence>();audio.fence(&app)?;crate::dota::reset_after_external_fence(&app)?;audio.reopen()});break;},
     _=>break,
    }
   }
  });
 }
}
fn current_effect_context(app:&AppHandle)->ReplayContext {
 let state=app.state::<crate::state::AppState>();let inner=state.0.lock().unwrap();
 ReplayContext{observer_session:None,session_ended:inner.session_ended,manual_summary_override:inner.obs_manual_summary_override}
}
fn execution_frame(scope:&ExecutionScope,p:&Prepared,key:&str)->ExecutionFrame {
 ExecutionFrame{scope:scope.clone(),ticket:p.ticket.clone(),binding:p.binding.clone(),preconditions:p.data.preconditions.clone(),operation_key:key.into(),correlation_id:key.into(),context:p.data.context.clone(),snapshot:p.data.snapshot.clone(),core_context:p.core_context.clone()}
}

// Core-only handover, not a user activation API. `fence_builtin` must prove all legacy
// effect/writer quiescence; the current developer gate deliberately cannot supply that proof.
pub(crate) fn handover_external(manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,session:&str,backup:&std::path::Path,
    capabilities:&[&str],fence_builtin:impl FnOnce()->Result<(),String>)->Result<LiveProcess,String> {
 let old={let mut guard=history.try_lock().map_err(str::to_string)?;let c=guard.as_mut().ok_or("local_runtime_unavailable")?;
  crate::local_runtime::transaction_schema::activation_preflight(c,backup)?;
  super::beta_capacity_preflight(c)?;
  match crate::local_runtime::transaction_authorization::phase(c)?{companion_dota_domain::ownership::Phase::Active(l) if l.owner==Owner::BuiltIn=>l,_=>return Err("ownership_not_builtin".into())}};
 let next=Lease{owner:Owner::External,epoch:old.epoch.checked_add(1).ok_or("epoch_exhausted")?};
 let grant=manager.match_execution_grant(capabilities,session,next)?;
 let package=grant.binding().clone();let mut process=None;
 gate.switch(old,Owner::External,Duration::from_secs(5),
  ||history.with_transaction_adapter(|_,c|{
   // Attaching marks uncertain startup Draining, so first attachment is deliberately refused.
   // A separate confirmed BuiltIn fence must recover that durable state before handover.
   crate::local_runtime::transaction_authorization::begin(c,old,Owner::External,session,Some(package))
  }),fence_builtin,
  ||history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::confirm_fenced(c,old)),
  |_|{process=Some(LiveProcess::start(manager,history,grant)?);Ok(())})?;
 process.ok_or("process_unavailable".into())
}

#[cfg(test)]
#[path="tests.rs"]
mod tests;

// Explicit startup recovery primitive, not normal startup / an activation entrypoint.
// Proof of process termination alone does NOT prove audio/OBS fences or grant ownership.
#[cfg(windows)]
pub(crate) fn fence_previous_windows_process(history:&LocalRuntimeState,gate:&LiveDota)->Result<(),String> {
 // Same transition lock as handover: job absence cannot race a later spawn.
 let _transition=gate.0.transition.lock().map_err(|_|"transition_poisoned")?;
 {let i=gate.0.inner.lock().map_err(|_|"admission_poisoned")?;
  if i.mode!=Mode::Draining||i.in_flight!=0{return Err("process_recovery_requires_drained_gate".into());}}
 let generation=history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::pending_windows_generation(c))?;
 crate::core::plugin_runtime::windows::fence_generation(&generation)?;
 history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::process_stopped(c,&generation))
}
