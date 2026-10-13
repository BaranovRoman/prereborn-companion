//! Typed match execution/receipt contracts shared by diagnostic and production hosts; no SQL capability.
use serde::{Serialize,Deserialize};
use crate::{match_shadow::Decision, model::{LocalMatchState,MatchResult,RankedMode}, effects::Status};
pub const EXECUTION_API:u32=1;
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Preconditions {pub policy:u32,pub epoch:u64,pub session_revision:u64,pub match_revision:Option<u64>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Request {pub api:u32,pub correlation_id:String,pub operation_key:String,pub ticket:String,pub binding:String,pub preconditions:Preconditions,pub plan:Decision}
impl Request {pub fn bounded(&self)->bool {
    fn key(s:&str)->bool{!s.is_empty()&&s.len()<=128&&s.bytes().all(|c|c.is_ascii_alphanumeric()||b":-_.".contains(&c))}
    self.api==EXECUTION_API&&key(&self.operation_key)&&key(&self.correlation_id)&&key(&self.ticket)&&self.binding.len()==64&&self.binding.bytes().all(|b|b.is_ascii_hexdigit())
        &&self.preconditions.policy==1&&crate::match_shadow::Analysis{conclusive:true,reason:None,detector:Some(self.plan.clone()),watchdog:None}.is_bounded()
        &&serde_json::to_vec(self).is_ok_and(|b|b.len()<=16384)
}}
#[derive(Clone,Copy,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="snake_case")]
pub enum Disposition {Applied,Skipped,Conflicted}
#[derive(Clone,Copy,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="snake_case")]
pub enum PreconditionOutcome {Satisfied,Rejected}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct MatchState {
    pub local_id:String,pub session_local_id:String,pub match_key:String,pub game_id:Option<String>,
    pub state:LocalMatchState,pub result:Option<MatchResult>,pub ranked_mode:RankedMode,pub hero_id:i64,
    pub rating_before:Option<i64>,pub rating_after:Option<i64>,pub kills:Option<i64>,pub deaths:Option<i64>,pub assists:Option<i64>,
    pub inventory:Vec<Option<String>>,pub last_seen_at:Option<String>,pub interrupted_at:Option<String>,pub finalized_at:Option<String>,
    pub diagnostic_revision:u64,
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct OperationReceipt {pub index:u8,pub disposition:Disposition,pub post_state:Option<MatchState>}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SessionReceipt {pub local_id:String,pub ended_at:Option<String>,pub streamed:bool,pub rating_current:Option<i64>,pub disposition:Disposition,pub diagnostic_revision:u64}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="snake_case")]
pub enum Delivery {Pending,Delivered,Failed}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct OutboxReceipt {pub id:String,pub entity_local_id:String,pub event_type:String,pub delivery:Delivery,pub attempts:i64,pub payload_identity:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Receipt {
    pub api:u32,pub operation_key:String,pub committed_correlation_id:String,pub status:Status,pub error:Option<String>,
    pub precondition_outcome:PreconditionOutcome,pub before:Preconditions,pub after:Option<Preconditions>,
    pub operations:Vec<OperationReceipt>,pub session:Option<SessionReceipt>,pub current_match:Option<MatchState>,pub current_context:Option<crate::match_shadow::MatchContext>,pub outbox:Vec<OutboxReceipt>,
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Response {pub correlation_id:String,pub status:Status,pub receipt:Option<Receipt>}

pub const DIAGNOSTIC_CAPABILITY:&str="dota.diagnostic.execute";
pub const MATCH_EXECUTION_CAPABILITY:&str="dota.match.execute";
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct PackageBinding {pub id:String,pub version:String,pub executable_hash:String,pub manifest_hash:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct DiagnosticScope {pub session:String,pub epoch:u64,pub run:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ContextReceipt {pub preconditions:Preconditions,pub session:SessionReceipt,pub current_context:Option<crate::match_shadow::MatchContext>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct DiagnosticFrame {
    pub scope:DiagnosticScope,pub ticket:String,pub binding:String,pub preconditions:Preconditions,
    pub operation_key:String,pub correlation_id:String,pub context:crate::match_shadow::Context,
    pub snapshot:crate::contracts::ReplayGsi,
    #[serde(default,skip_serializing_if="Option::is_none")] pub core_context:Option<ContextReceipt>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum DiagnosticRequest {
    Execute {scope:DiagnosticScope,sequence:u64,snapshot_identity:String,request:Request},
    Recover {scope:DiagnosticScope,request:Request},
}
impl DiagnosticRequest {
    pub fn bounded(&self)->bool {
        let (scope,request)=match self {Self::Execute{scope,request,..}|Self::Recover{scope,request}=>(scope,request)};
        scope.epoch>0&&!scope.session.is_empty()&&scope.session.len()<=128&&!scope.run.is_empty()&&scope.run.len()<=128
            &&request.bounded()&&match self {Self::Execute{sequence,snapshot_identity,..}=>*sequence>0&&snapshot_identity.len()==64&&snapshot_identity.bytes().all(|b|b.is_ascii_hexdigit()),Self::Recover{..}=>true}
    }
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum DiagnosticReply {Result {response:Response},Denied {code:String}}

// Same validated contracts in both hosts; separate wire variants prevent replay escalation.
pub type ExecutionScope = DiagnosticScope;
pub type ExecutionFrame = DiagnosticFrame;
pub type ExecutionRequest = DiagnosticRequest;
pub type ExecutionReply = DiagnosticReply;
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct LiveEffectsFrame {
    pub deadline_ms:u64,
    #[serde(default)] pub obs_revision:u64,
    pub scope:ExecutionScope,
    pub input:crate::contracts::ReplayInput,
}
#[derive(Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct LiveEffectRequest {
    pub scope:ExecutionScope,
    pub request:crate::effects::Request,
}
