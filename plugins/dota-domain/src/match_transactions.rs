//! Proposed IPC v1 payloads. Not routed to the replay worker or live services.
use serde::{Serialize,Deserialize};
use crate::{ownership::Lease,effects::Status,broadcast_state::BroadcastState};
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Team {Radiant,Dire}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Outcome {Win,Loss,Abandon}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Mode {Ranked,Unranked,Unknown}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {pub local_id:String,pub session_id:String,pub match_key:String,pub gsi_match_id:Option<String>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Telemetry {pub kills:Option<u16>,pub deaths:Option<u16>,pub assists:Option<u16>,pub observed_ms:u64,pub inventory:Vec<Option<String>>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="action",rename_all="snake_case",deny_unknown_fields)]
pub enum Reconciliation {Resume {hero_id:u16,observed_ms:u64,gsi_match_id:Option<String>},PostGame {outcome:Option<Outcome>},Interrupted {evidence:InterruptEvidence},NeedsReview {reason:ReviewReason}}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum InterruptEvidence {SessionEnded,DistinctMatch}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum ReviewReason {WinnerConflict,MatchIdChanged,IncompleteEvidence}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rating {pub before:Option<i32>,pub delta:Option<i16>,pub after:Option<i32>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="operation",rename_all="snake_case",deny_unknown_fields)]
pub enum Operation {
 Started {identity:Identity,hero_id:u16,team:Team,mode:Mode,started_ms:u64},
 Updated {local_id:String,revision:u32,telemetry:Telemetry},
 Finished {local_id:String,revision:u32,outcome:Outcome,confirmed:bool,finished_ms:u64,rating:Rating},
 Reconcile {local_id:String,revision:u32,change:Reconciliation},
 HistoryRead {session_id:String,limit:u8}, OutboxEnqueue {local_id:String,revision:u32},
 OutboxStatus {limit:u8}, BackendSyncIntent {outbox_id:String},
 OverlayState {state:BroadcastState},
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {pub api:u32,pub lease:Lease,pub correlation_id:String,pub operation_key:String,pub deadline_ms:u64,pub operation:Operation}
fn id(s:&str)->bool {!s.is_empty()&&s.len()<=128&&s.bytes().all(|c|c.is_ascii_alphanumeric()||b"_:.-".contains(&c))}
fn uuid(s:&str)->bool {s.len()==36&&s.bytes().enumerate().all(|(i,c)|if [8,13,18,23].contains(&i){c==b'-'}else{c.is_ascii_hexdigit()})}
fn time(n:u64)->bool {n<=253402300799999}
impl Request {
 pub fn validate(&self)->bool {
  if self.api!=1||!id(&self.operation_key)||!id(&self.correlation_id) {return false;}
  match &self.operation {
   Operation::Started{identity,hero_id,started_ms,..}=>uuid(&identity.local_id)&&uuid(&identity.session_id)&&id(&identity.match_key)&&identity.gsi_match_id.as_ref().map_or(true,|s|id(s))&&*hero_id>0&&*hero_id<=4096&&time(*started_ms),
   Operation::Updated{local_id,telemetry,..}=>uuid(local_id)&&telemetry.kills.iter().chain(telemetry.deaths.iter()).chain(telemetry.assists.iter()).all(|n|*n<=10000)&&time(telemetry.observed_ms)&&telemetry.inventory.len()<=9&&telemetry.inventory.iter().all(|s|s.as_ref().map_or(true,|s|id(s))),
   Operation::Finished{local_id,finished_ms,rating,..}=>uuid(local_id)&&time(*finished_ms)&&rating.delta.map_or(true,|d|(-1000..=1000).contains(&d))&&rating.before.iter().chain(rating.after.iter()).all(|v|(1..=1000000).contains(v)),
   Operation::Reconcile{local_id,change,..}=>uuid(local_id)&&match change {Reconciliation::Resume{hero_id,observed_ms,gsi_match_id}=>*hero_id>0&&*hero_id<=4096&&time(*observed_ms)&&gsi_match_id.as_ref().map_or(true,|s|id(s)),_=>true},
   Operation::HistoryRead{session_id,limit}=>uuid(session_id)&&*limit>0&&*limit<=20,
   Operation::OutboxStatus{limit}=>*limit>0&&*limit<=20,
   Operation::OutboxEnqueue{local_id,..}=>uuid(local_id), Operation::BackendSyncIntent{outbox_id}=>id(outbox_id),Operation::OverlayState{..}=>true,
  }
 }
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Error {NotFound,RevisionConflict,InvalidTransition,IdentityConflict,OutcomeConflict,ExternalResultUnknown}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {pub operation_key:String,pub correlation_id:String,pub status:Status,pub data:Data,pub error:Option<Error>}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum MatchState {InProgress,PostGamePending,Interrupted,NeedsReview,Finalized}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchRow {pub identity:Identity,pub revision:u32,pub hero_id:u16,pub team:Team,pub mode:Mode,pub started_ms:u64,pub last_seen_ms:u64,pub finished_ms:Option<u64>,pub telemetry:Option<Telemetry>,pub state:MatchState,pub outcome:Option<Outcome>,pub confirmed:bool,pub rating:Option<Rating>}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Delivery {Pending,Unknown}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutboxRow {pub id:String,pub local_match_id:String,pub event_type:String,pub delivery:Delivery}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum Data {None,Match {row:MatchRow},History {rows:Vec<MatchRow>},Outbox {rows:Vec<OutboxRow>},Overlay {state:BroadcastState}}


impl Operation {
 pub fn capability(&self)->crate::effects::Capability {match self {Self::BackendSyncIntent{..}=>crate::effects::Capability::Sync,Self::OverlayState{..}=>crate::effects::Capability::Overlay,_=>crate::effects::Capability::History}}
}
