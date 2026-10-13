//! Transport-only intents. Detection remains the shared Replay implementation.
use companion_dota_domain::{match_execution::{LiveEffectsFrame,LiveEffectRequest},effects::{Effect,Request,Ack,Status},ownership::{Lease,Owner},replay::Replay,broadcast_state::BroadcastState};
use companion_plugin_protocol::{read_frame,write_frame,Message};
use std::io::{BufRead,Write};
#[derive(Default)]
pub struct State {replay:Replay,scene:Option<BroadcastState>,obs_revision:Option<u64>,blocked:bool}
impl State {
 pub fn apply(&mut self,id:u64,frame:LiveEffectsFrame,input:&mut impl BufRead,output:&mut impl Write)->Result<(),String> {
  if self.blocked{return Err("effect_result_unknown".into());}
  if frame.scope.epoch==0||frame.scope.session.is_empty()||frame.scope.session.len()>128||frame.scope.run.len()>128{return Err("invalid_execution_scope".into());}
  let sequence=frame.input.sequence;
  let result=self.replay.apply(frame.input)?;
  let mut intents=Vec::new();
  if self.scene!=Some(result.broadcast_state)||self.obs_revision!=Some(frame.obs_revision) {
   intents.push(Effect::ObsScene{state:result.broadcast_state});intents.push(Effect::Overlay{state:result.broadcast_state});
  }
  for sound in &result.sound_signals {intents.push(Effect::Sound{event_id:sound.id.clone(),kind:Some(sound.kind)});}
  if intents.len()>32{return Err("too_many_effects".into());}
  let mut acks=Vec::new();
  for (index,effect) in intents.into_iter().enumerate() {
   let key=format!("effect:{}:{sequence}:{index}",frame.scope.run);
   let pending_sound=matches!(effect,Effect::Sound{..});
   let request=LiveEffectRequest{scope:frame.scope.clone(),request:Request{api:1,lease:Lease{owner:Owner::External,epoch:frame.scope.epoch},correlation_id:key.clone(),idempotency_key:key.clone(),deadline_ms:frame.deadline_ms,effect}};
   write_frame(output,Message::GameEffect{id,request:serde_json::to_value(request).map_err(|_|"invalid_effect")?})?;
   let Some(Message::GameEffectAck{id:reply_id,response})=read_frame(input)? else{return Err("expected_effect_ack".into());};
   let ack:Ack=serde_json::from_value(response).map_err(|_|"invalid_effect_ack")?;
   if reply_id!=id||ack.idempotency_key!=key||ack.correlation_id!=key||ack.lease!=(Lease{owner:Owner::External,epoch:frame.scope.epoch}){return Err("effect_ack_mismatch".into());}
   if ack.status==Status::Unknown||(ack.status==Status::Accepted&&!pending_sound) {self.blocked=true;}
   acks.push(ack);
   if self.blocked{break;}
  }
  self.scene=Some(result.broadcast_state);self.obs_revision=Some(frame.obs_revision);
  write_frame(output,Message::Reply{id,result:serde_json::json!({"analysis":result,"acks":acks,"blocked":self.blocked})})
 }
}
