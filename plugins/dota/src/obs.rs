//! Dota scene policy; transport and durable execution receipts stay in the host.
use companion_dota_domain::{broadcast_state::BroadcastState,obs_policy};
use companion_plugin_protocol::{obs::{SceneObservation,SceneIntent,SceneReceipt},audio::Status};
#[derive(Default)]
pub struct Controller{pending:Option<SceneIntent>,sequence:u64,attempt:u32,next_at:u64,pub error:Option<String>,pub last_receipt:Option<SceneReceipt>}
fn semantic(state:BroadcastState)->&'static str{if state==BroadcastState::Gameplay{"gameplay"}else{"betweenMatches"}}
impl Controller{
 pub fn receipt(&mut self,receipt:SceneReceipt,now:u64)->Result<(),String>{
  if self.pending.as_ref().map(|p|p.operation_key.as_str())!=Some(receipt.operation_key.as_str())||!matches!(receipt.status,Status::Completed|Status::Cancelled|Status::Unknown){return Err("obs_receipt_scope_mismatch".into());}
  if receipt.status==Status::Cancelled{self.pending=None;self.attempt=self.attempt.saturating_add(1);self.next_at=now.saturating_add(obs_policy::retry_seconds(self.attempt)*1000);self.error=Some("obs_request_cancelled_before_write".into());}
  else if receipt.status==Status::Completed{self.pending=None;self.attempt=0;self.next_at=0;self.error=None;}else{self.error=Some("obs_result_unknown_requires_authoritative_reconciliation".into());}
  self.last_receipt=Some(receipt);Ok(())
 }
 pub fn plan(&mut self,observation:Option<&SceneObservation>,requested:BroadcastState,ended:bool,context:Option<&str>,now:u64)->Result<Option<SceneIntent>,String>{
  // Keep the exact uncertain operation. A config/session change cannot turn it
  // into a new write; the host may only query truth for this old identity.
  if let Some(intent)=&self.pending{return Ok(Some(intent.clone()));}
  let Some(obs)=observation else{return Ok(None);};obs.validate()?;
  if !obs.enabled{return Ok(None);}
  if !obs.fresh(now)||obs.current_scene.is_none(){self.error=Some("obs_state_unavailable".into());return Ok(None);}
  let desired=semantic(obs_policy::resolve(requested,ended));
  let name=obs.bindings.get(desired).filter(|s|!s.is_empty()&&obs.scenes.contains(s));
  let Some(name)=name else{self.error=Some("obs_mapped_scene_missing".into());self.attempt=self.attempt.saturating_add(1);self.next_at=now.saturating_add(obs_policy::retry_seconds(self.attempt)*1000);return Ok(None);};
  if obs.current_scene.as_deref()==Some(name){self.error=None;self.attempt=0;self.next_at=0;return Ok(None);}
  if now<self.next_at{return Ok(None);}
  self.sequence=self.sequence.checked_add(1).ok_or("obs_sequence_exhausted")?;
  let intent=SceneIntent{operation_key:format!("scene:{}",self.sequence),semantic:desired.into(),config_revision:obs.config_revision.clone(),context:context.map(str::to_string)};
  self.pending=Some(intent.clone());Ok(Some(intent))
 }
}
#[cfg(test)]mod tests{
 use super::*;
 fn observation()->SceneObservation{SceneObservation{observed_at_ms:1000,config_revision:"a".repeat(64),enabled:true,bindings:[("betweenMatches".into(),"Idle".into()),("gameplay".into(),"Game".into())].into(),current_scene:Some("Idle".into()),scenes:vec!["Idle".into(),"Game".into()],streaming:Some(true)}}
 #[test]fn two_scenes_follow_actual_obs_truth_and_draft_or_ended_stay_between_matches(){
  let mut c=Controller::default();let mut obs=observation();
  assert!(c.plan(Some(&obs),BroadcastState::Gameplay,false,Some("session"),5000).unwrap().is_none(),"stale observation");
  let first=c.plan(Some(&obs),BroadcastState::Gameplay,false,Some("session"),1000).unwrap().unwrap();assert_eq!(first.semantic,"gameplay");
  c.receipt(SceneReceipt{operation_key:first.operation_key,status:Status::Completed},1000).unwrap();obs.current_scene=Some("Game".into());assert!(c.plan(Some(&obs),BroadcastState::Gameplay,false,Some("session"),1000).unwrap().is_none());
  obs.current_scene=Some("Manual".into());let manual=c.plan(Some(&obs),BroadcastState::Gameplay,false,Some("session"),1000).unwrap().unwrap();assert_eq!(manual.semantic,"gameplay");
  c.receipt(SceneReceipt{operation_key:manual.operation_key,status:Status::Completed},1000).unwrap();obs.current_scene=Some("Game".into());
  let draft=c.plan(Some(&obs),BroadcastState::Draft,false,Some("session"),1000).unwrap().unwrap();assert_eq!(draft.semantic,"betweenMatches");
  c.receipt(SceneReceipt{operation_key:draft.operation_key,status:Status::Completed},1000).unwrap();obs.current_scene=Some("Game".into());
  assert_eq!(c.plan(Some(&obs),BroadcastState::Gameplay,true,Some("session:ended"),1000).unwrap().unwrap().semantic,"betweenMatches");
 }
 #[test]fn uncertain_identity_is_retained_across_new_state_and_cannot_be_replaced_by_a_new_write(){
  let mut c=Controller::default();let mut obs=observation();let first=c.plan(Some(&obs),BroadcastState::Gameplay,false,None,1000).unwrap().unwrap();
  c.receipt(SceneReceipt{operation_key:first.operation_key.clone(),status:Status::Unknown},1000).unwrap();obs.config_revision="b".repeat(64);obs.current_scene=None;
  assert_eq!(c.plan(Some(&obs),BroadcastState::Draft,true,Some("new"),1000).unwrap(),Some(first));
  assert!(c.receipt(SceneReceipt{operation_key:"forged".into(),status:Status::Completed},1000).is_err());
 }
}
