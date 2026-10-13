//! Production request/receipt bridge. Manager pin -> process mutex -> existing history mutex.
//! The reverse callback uses the already held pin, never reacquires PluginManager.
use super::*;
use crate::{core::{plugin_manager::{PluginManager,MatchExecutionGrant},plugin_runtime::{Runtime,ProcessBinding}},local_runtime::{LocalRuntimeState,host_execution::Prepared}};
use companion_dota_domain::{match_execution::*,effects::{Effect,Status as EffectStatus},contracts::{ReplayInput,ReplayContext}};
use serde_json::Value;
use tauri::{AppHandle,Manager};
pub(crate) struct LiveProcess {runtime:Mutex<Runtime>,binding:ProcessBinding,grant:MatchExecutionGrant}
impl LiveProcess {
 fn start(manager:&PluginManager,grant:MatchExecutionGrant)->Result<Self,String> {
  let mut runtime=Runtime::default();let binding=manager.with_verified_match_grant(&grant,|pin|runtime.start_verified(pin))?;
  Ok(Self{runtime:Mutex::new(runtime),binding,grant})
 }
 pub(crate) fn process(&self,manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,frame:Frame,context:ReplayContext,
     mut dispatch:impl FnMut(&Effect,&str)->EffectStatus)->Result<(),String> {
  let _admission=gate.external(self.grant.lease)?;
  manager.with_verified_match_grant(&self.grant,|pin|{
   let mut runtime=self.runtime.lock().map_err(|_|"process_lock_poisoned")?;
   let scope=ExecutionScope{session:self.grant.session.clone(),epoch:self.grant.lease.epoch,run:self.binding.generation.clone()};
   // Short history lock; RELEASED before sending or waiting for any IPC.
   let prepared=history.with_transaction_adapter(|adapter,c|adapter.prepare_plugin_operation(c,pin,frame.snapshot.clone(),frame.at,frame.sequence))?;
   if let Some(prepared)=prepared {
    let key=format!("match:{}:{}",scope.run,frame.sequence);
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
   let input=LiveEffectsFrame{deadline_ms:(chrono::Utc::now().timestamp_millis().max(0) as u64).saturating_add(2000),scope:scope.clone(),input:ReplayInput{sequence:frame.sequence,observed_at_ms:frame.at.timestamp_millis().max(0) as u64,snapshot:frame.snapshot,context,match_context:None}};
   // Only real scene transitions/sound detections create effect keys, never idle snapshots.
   let mut uncertain=false;
   let result=runtime.command_live(pin,&self.binding,"dota.live_effects".into(),serde_json::to_value(&input).map_err(|_|"invalid_frame")?,|payload|{
    let _effect_admission=gate.external(self.grant.lease)?;
    if uncertain{return Err("effect_result_unknown".into());}
    let request:LiveEffectRequest=serde_json::from_value(payload).map_err(|_|"invalid_effect")?;
    if request.scope!=scope||request.request.lease!=self.grant.lease{return Err("execution_scope_mismatch".into());}
    let admission=history.with_transaction_adapter(|adapter,c|adapter.admit_effect(c,pin,&request.request,chrono::Utc::now().timestamp_millis().max(0) as u64))?;
    let ack=if admission.fresh {
     // Ledger Unknown already committed. No history lock during transport or file IO.
     let outcome=dispatch(&request.request.effect,&request.request.correlation_id);
     history.with_transaction_adapter(|adapter,c|adapter.settle_effect(c,admission,outcome))?
    } else {admission.ack};
    uncertain=matches!(ack.status,EffectStatus::Unknown|EffectStatus::Accepted);
    serde_json::to_value(ack).map_err(|_|"invalid_ack".into())
   })?;
   if uncertain||result.get("blocked").and_then(Value::as_bool)!=Some(false){return Err("effect_result_unknown".into());}Ok(())
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
 pub(crate) fn fallback(&self,history:&LocalRuntimeState,gate:&LiveDota,reset_builtin:impl FnOnce()->Result<(),String>)->Result<Lease,String> {
  let old=self.grant.lease;let session=&self.grant.session;
  gate.switch(old,Owner::BuiltIn,Duration::from_secs(5),
   ||history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::begin(c,old,Owner::BuiltIn,session,None)),
   ||{let mut runtime=self.runtime.lock().map_err(|_|"process_lock_poisoned")?;let _=runtime.stop();runtime.stopped_confirmed()?;
      // Unknown audio may still be playing in WebView. A dead plugin is insufficient proof.
      let mut guard=history.try_lock().map_err(str::to_string)?;let c=guard.as_mut().ok_or("local_runtime_unavailable")?;
      if crate::local_runtime::host_execution::live_effects::quota(c)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}Ok(())},
   ||history.with_transaction_adapter(|_,c|crate::local_runtime::transaction_authorization::confirm_fenced(c,old)),|_|reset_builtin())
 }
 pub(crate) fn consume(self,app:AppHandle) {
  std::thread::spawn(move||{
   let gate=app.state::<LiveDota>();let manager=app.state::<PluginManager>();let history=app.state::<LocalRuntimeState>();
   loop {
    if manager.stopping(){gate.failed(self.grant.lease,"core_shutdown");}
    match gate.status().mode {
     Mode::External=>if let Some(frame)=gate.next(){
      let context=frame.context.clone();
      if let Err(e)=self.process(&manager,&history,&gate,frame,context,|effect,correlation|match effect{
       Effect::Sound{event_id,kind:Some(kind)}=>crate::game_sounds::dispatch_plugin_sound(&app,event_id,*kind,correlation),
       Effect::ObsScene{state}=>crate::obs::dispatch_plugin_scene(&app,*state),
       Effect::Overlay{state}=>if gate.publish_overlay(self.grant.lease,*state).is_ok(){EffectStatus::Completed}else{EffectStatus::Rejected},
       _=>EffectStatus::Rejected,
      }){gate.failed(self.grant.lease,&e);}
     }else{
      let running=self.runtime.lock().map(|mut r|r.snapshot().phase==crate::core::plugin_runtime::Phase::Running).unwrap_or(false);
      if !running{gate.failed(self.grant.lease,"process_crashed");}std::thread::sleep(Duration::from_millis(50));
     },
     Mode::Fallback=>{let _=self.fallback(&history,&gate,||crate::dota::reset_after_external_fence(&app));break;},
     _=>break,
    }
   }
  });
 }
}
fn execution_frame(scope:&ExecutionScope,p:&Prepared,key:&str)->ExecutionFrame {
 ExecutionFrame{scope:scope.clone(),ticket:p.ticket.clone(),binding:p.binding.clone(),preconditions:p.data.preconditions.clone(),operation_key:key.into(),correlation_id:key.into(),context:p.data.context.clone(),snapshot:p.data.snapshot.clone()}
}

// Core-only handover, not a user activation API. `fence_builtin` must prove all legacy
// effect/writer quiescence; the current developer gate deliberately cannot supply that proof.
pub(crate) fn handover_external(manager:&PluginManager,history:&LocalRuntimeState,gate:&LiveDota,session:&str,backup:&std::path::Path,
    capabilities:&[&str],fence_builtin:impl FnOnce()->Result<(),String>)->Result<LiveProcess,String> {
 let old={let mut guard=history.try_lock().map_err(str::to_string)?;let c=guard.as_mut().ok_or("local_runtime_unavailable")?;
  crate::local_runtime::transaction_schema::activation_preflight(c,backup)?;
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
  |_|{process=Some(LiveProcess::start(manager,grant)?);Ok(())})?;
 process.ok_or("process_unavailable".into())
}

#[cfg(test)]
#[path="tests.rs"]
mod tests;
