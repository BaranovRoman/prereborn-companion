//! Original draft-entry reminder rule. No session/stream fabrication or TTS IO.
use crate::broadcast_state::BroadcastState;
pub fn should_fire(previous:Option<BroadcastState>,current:BroadcastState,connected:bool,streaming:Option<bool>)->bool{
 current==BroadcastState::Draft&&previous!=Some(BroadcastState::Draft)&&connected&&streaming==Some(false)
}
#[derive(Default)]pub struct Tracker{pub previous:Option<BroadcastState>,pub fired:bool}
impl Tracker{
 pub fn observe(&mut self,current:BroadcastState,connected:bool,streaming:Option<bool>)->bool{
  let fire=!self.fired&&should_fire(self.previous,current,connected,streaming);
  if current!=BroadcastState::Draft{self.fired=false;}if fire{self.fired=true;}self.previous=Some(current);fire
 }
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn real_transition_rearms_but_unknown_obs_or_an_already_active_stream_cannot_warn(){
  let mut tracker=Tracker::default();assert!(tracker.observe(BroadcastState::Draft,true,Some(false)));assert!(!tracker.observe(BroadcastState::Draft,true,Some(false)));
  assert!(!tracker.observe(BroadcastState::Gameplay,true,Some(false)));assert!(!tracker.observe(BroadcastState::Draft,false,Some(false)));
  assert!(!tracker.observe(BroadcastState::Draft,true,Some(false)));tracker.observe(BroadcastState::Gameplay,true,Some(false));assert!(!tracker.observe(BroadcastState::Draft,true,Some(true)));
  tracker.observe(BroadcastState::Gameplay,true,None);assert!(!tracker.observe(BroadcastState::Draft,true,None));tracker.observe(BroadcastState::Gameplay,true,Some(false));assert!(tracker.observe(BroadcastState::Draft,true,Some(false)));
 }
}
