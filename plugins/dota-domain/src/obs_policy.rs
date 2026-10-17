//! Dota OBS scene policy (two scenes) and retry rules.
use crate::broadcast_state::{self,BroadcastState};
/// OBS has two package scenes: Gameplay while a match is being played on a
/// live (not ended) stream, Between Matches for everything else - draft and
/// an ended stream included (the overlay marks a running draft itself).
pub fn resolve(requested:BroadcastState,ended:bool)->BroadcastState{
 if !ended&&broadcast_state::resolve(requested,false,false)==BroadcastState::Gameplay{BroadcastState::Gameplay}else{BroadcastState::BetweenMatches}
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn only_live_gameplay_leaves_between_matches(){
  assert_eq!(resolve(BroadcastState::Gameplay,false),BroadcastState::Gameplay);
  for state in [BroadcastState::Draft,BroadcastState::BetweenMatches,BroadcastState::PostStream]{assert_eq!(resolve(state,false),BroadcastState::BetweenMatches);}
  for state in [BroadcastState::Gameplay,BroadcastState::Draft,BroadcastState::BetweenMatches]{assert_eq!(resolve(state,true),BroadcastState::BetweenMatches);}
 }
}
pub fn retry_seconds(attempt:u32)->u64{2_u64.saturating_pow(attempt.min(5)).min(30)}
