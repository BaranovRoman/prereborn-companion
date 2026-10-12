//! Whitelisted read-only IPC; no paths, scene names, SQL, URLs or credentials.
use serde::{Serialize,Deserialize};
use crate::broadcast_state::BroadcastState;
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum ReadCapability { Obs, Scenes, Stream, Sounds, History, Backend }
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="query",rename_all="snake_case",deny_unknown_fields)]
pub enum ReadRequest { Obs, Scenes, Stream, Sounds, History {limit:u8}, Backend }
impl ReadRequest {
 pub fn capability(&self)->ReadCapability {match self {Self::Obs=>ReadCapability::Obs,Self::Scenes=>ReadCapability::Scenes,Self::Stream=>ReadCapability::Stream,Self::Sounds=>ReadCapability::Sounds,Self::History{..}=>ReadCapability::History,Self::Backend=>ReadCapability::Backend}}
 pub fn validate(&self)->bool {!matches!(self,Self::History{limit} if *limit==0||*limit>20)}
}
#[derive(Clone,Copy,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Connectivity { Unknown, Connected, Recovering, Unavailable }
#[derive(Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchSummary {pub hero_id:i64,pub won:Option<bool>,pub kills:Option<i64>,pub deaths:Option<i64>,pub assists:Option<i64>}
#[derive(Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum ReadResponse {
 Obs {connected:bool}, Scenes {ids:Vec<BroadcastState>},
 Stream {streaming:Option<bool>,session_ended:bool,twitch_connected:Option<bool>},
 Sounds {enabled:bool,volume:u8,configured_events:Vec<String>,truncated:bool},
 History {matches:Vec<MatchSummary>}, Backend {state:Connectivity},
 Error {code:ReadError},
}
#[derive(Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum ReadError { CapabilityDenied, InvalidRequest, Unavailable, ResponseTooLarge }
pub const DOTA_READ_GRANTS:&[ReadCapability]=&[ReadCapability::Obs,ReadCapability::Scenes,ReadCapability::Stream,ReadCapability::Sounds,ReadCapability::History,ReadCapability::Backend];
