//! Existing Dota OBS precedence, optional Post Stream fallback and retry rules.
use crate::broadcast_state::{self,BroadcastState};
pub fn resolve(requested:BroadcastState,ended:bool,summary:bool,post_stream_unavailable:bool)->BroadcastState{
 let canonical=broadcast_state::resolve(requested,ended,summary);
 if canonical==BroadcastState::PostStream&&post_stream_unavailable{BroadcastState::BetweenMatches}else{canonical}
}
pub fn retry_seconds(attempt:u32)->u64{2_u64.saturating_pow(attempt.min(5)).min(30)}
