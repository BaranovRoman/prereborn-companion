//! Proposed IPC v1 payloads only; no effect dispatch, SQL, network or secrets.
use serde::{Deserialize, Serialize};
use crate::{broadcast_state::BroadcastState, contracts::MatchTransition, ownership::{Lease,Ownership}};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Capability { Obs, Sound, Notification, History, Sync, Overlay }
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag="operation",rename_all="snake_case",deny_unknown_fields)]
pub enum Effect {
 ObsScene {state:BroadcastState}, Sound {event_id:String}, Notification {text:String},
 MatchTransition {match_id:String,transition:MatchTransition}, HistoryRead {limit:u16},
 BackendSync {match_id:String}, Overlay {state:BroadcastState},
}
impl Effect {
 fn capability(&self)->Capability {match self {Self::ObsScene{..}=>Capability::Obs,Self::Sound{..}=>Capability::Sound,Self::Notification{..}=>Capability::Notification,Self::MatchTransition{..}|Self::HistoryRead{..}=>Capability::History,Self::BackendSync{..}=>Capability::Sync,Self::Overlay{..}=>Capability::Overlay}}
 fn validate(&self)->bool {match self {
  Self::Sound{event_id}=>identifier(event_id), Self::Notification{text}=>!text.is_empty()&&text.len()<=512,
  Self::MatchTransition{match_id,..}|Self::BackendSync{match_id}=>identifier(match_id),
  Self::HistoryRead{limit}=>*limit>0&&*limit<=100, _=>true,
 }}
}
fn identifier(s:&str)->bool {!s.is_empty()&&s.len()<=128&&s.bytes().all(|c| c.is_ascii_alphanumeric()||b"_-.:".contains(&c))}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Request {pub api:u32,pub lease:Lease,pub correlation_id:String,pub idempotency_key:String,pub deadline_ms:u64,pub effect:Effect}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Status { Accepted, Completed, Rejected, Unknown }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Ack {pub correlation_id:String,pub idempotency_key:String,pub lease:Lease,pub status:Status}
// Bounded in-memory contract model. Production needs a durable transaction/outbox ledger.
// Never evict an entry silently: saturation fails closed; timeout keeps Unknown pending.
#[derive(Debug, PartialEq, Eq)]
pub struct Admission { pub status: Status, pub duplicate: bool }
pub struct Ledger { entries:std::collections::BTreeMap<String,(String,Status)> }
impl Default for Ledger {fn default()->Self {Self {entries:Default::default()}}}
impl Ledger {
 pub fn admit(&mut self, owners:&Ownership, grants:&[Capability], req:&Request, now:u64)->Result<Admission,&'static str> {
  owners.authorize(req.lease)?;
  if req.api!=1||!identifier(&req.correlation_id)||!identifier(&req.idempotency_key)||!req.effect.validate() {return Err("invalid_effect_request");}
  if !grants.contains(&req.effect.capability()) {return Err("capability_denied");}
  let fingerprint=serde_json::to_string(&req.effect).map_err(|_| "invalid_effect_request")?;
  let key=req.idempotency_key.clone();
  if let Some((existing,status))=self.entries.get(&key) {return if *existing==fingerprint {Ok(Admission {status:*status,duplicate:true})} else {Err("idempotency_conflict")};}
  if req.deadline_ms<=now||req.deadline_ms-now>30000 {return Err("deadline_invalid");}
  if self.entries.len()>=256 {return Err("ledger_full");}
  self.entries.insert(key,(fingerprint,Status::Accepted)); Ok(Admission {status:Status::Accepted,duplicate:false})
 }
 pub fn acknowledge(&mut self,owners:&Ownership,req:&Request,status:Status)->Result<Ack,&'static str> {
  owners.authorize(req.lease)?;
  let entry=self.entries.get_mut(&req.idempotency_key).ok_or("not_admitted")?;
  if entry.0!=serde_json::to_string(&req.effect).map_err(|_|"invalid_effect_request")? {return Err("idempotency_conflict");}
  if matches!(entry.1,Status::Completed|Status::Rejected)&&entry.1!=status {return Err("terminal_ack");}
  if status==Status::Accepted {return Err("invalid_ack_transition");}
  entry.1=status;
  Ok(Ack {correlation_id:req.correlation_id.clone(),idempotency_key:req.idempotency_key.clone(),lease:req.lease,status})
 }
}
#[cfg(test)] mod tests {
 use super::*; use crate::ownership::{Phase,Owner};
 fn request(lease:Lease)->Request {Request {api:1,lease,correlation_id:"c1".into(),idempotency_key:"e1".into(),deadline_ms:1000,effect:Effect::Sound{event_id:"item_tango".into()}}}
 #[test] fn bounds_rights_dedupe_conflicts_timeout_and_stale_owner() {
  let mut owners=Ownership::default(); let Phase::Active(lease)=owners.phase() else {panic!()}; let mut l=Ledger::default(); let mut r=request(lease);
  assert_eq!(l.admit(&owners,&[],&r,0),Err("capability_denied"));
  assert_eq!(l.admit(&owners,&[Capability::Sound],&r,0),Ok(Admission {status:Status::Accepted,duplicate:false}));
  l.acknowledge(&owners,&r,Status::Unknown).unwrap(); assert_eq!(l.admit(&owners,&[Capability::Sound],&r,1001),Ok(Admission {status:Status::Unknown,duplicate:true}));
  l.acknowledge(&owners,&r,Status::Completed).unwrap(); assert_eq!(l.admit(&owners,&[Capability::Sound],&r,1001),Ok(Admission {status:Status::Completed,duplicate:true}));
  assert!(l.acknowledge(&owners,&r,Status::Unknown).is_err());
  r.effect=Effect::Sound{event_id:"other".into()}; assert_eq!(l.admit(&owners,&[Capability::Sound],&r,0),Err("idempotency_conflict"));
  owners.begin(lease,Owner::External).unwrap(); assert!(l.admit(&owners,&[Capability::Sound],&r,0).is_err());
  r.lease=owners.confirm_fenced(lease).unwrap(); r.effect=Effect::Sound{event_id:"item_tango".into()};
  assert_eq!(l.admit(&owners,&[Capability::Sound],&r,1001),Ok(Admission {status:Status::Completed,duplicate:true}));
 }
 #[test] fn arbitrary_operations_secrets_and_large_payloads_rejected() {
  for json in [r#"{"operation":"sql","query":"select 1"}"#,r#"{"operation":"backend_sync","match_id":"1","token":"secret"}"#] {assert!(serde_json::from_str::<Effect>(json).is_err());}
  assert!(!Effect::Notification{text:"x".repeat(513)}.validate()); assert!(!Effect::HistoryRead{limit:101}.validate());
 }
}

#[cfg(test)] mod safety_tests {
 use super::*; use crate::ownership::Phase;
 #[test] fn deadlines_and_capacity_fail_closed() {
  let owners=Ownership::default(); let Phase::Active(lease)=owners.phase() else {panic!()}; let mut ledger=Ledger::default();
  let mut r=Request{api:1,lease,correlation_id:"c".into(),idempotency_key:"k".into(),deadline_ms:0,effect:Effect::HistoryRead{limit:10}};
  assert_eq!(ledger.admit(&owners,&[Capability::History],&r,0),Err("deadline_invalid"));
  r.deadline_ms=30001; assert_eq!(ledger.admit(&owners,&[Capability::History],&r,0),Err("deadline_invalid")); r.deadline_ms=1000;
  for i in 0..256 {r.idempotency_key=format!("k{i}"); assert!(!ledger.admit(&owners,&[Capability::History],&r,0).unwrap().duplicate);}
  r.idempotency_key="extra".into(); assert_eq!(ledger.admit(&owners,&[Capability::History],&r,0),Err("ledger_full"));
  r.idempotency_key="k1".into(); assert!(ledger.admit(&owners,&[Capability::History],&r,0).unwrap().duplicate);
 }
 #[test] fn request_and_ack_round_trip_without_open_operations() {
  let owners=Ownership::default(); let Phase::Active(lease)=owners.phase() else {panic!()}; let mut ledger=Ledger::default();
  let r=Request{api:1,lease,correlation_id:"corr".into(),idempotency_key:"stable-operation".into(),deadline_ms:1000,effect:Effect::ObsScene{state:BroadcastState::Gameplay}};
  let bytes=serde_json::to_vec(&r).unwrap(); assert!(bytes.len()<1024);
  let decoded:Request=serde_json::from_slice(&bytes).unwrap(); ledger.admit(&owners,&[Capability::Obs],&decoded,0).unwrap();
  let ack=ledger.acknowledge(&owners,&decoded,Status::Completed).unwrap();
  let decoded_ack:Ack=serde_json::from_slice(&serde_json::to_vec(&ack).unwrap()).unwrap(); assert_eq!(decoded_ack.correlation_id,"corr");
  let mut invalid=serde_json::to_value(&r).unwrap(); invalid["sql"]=serde_json::json!("select 1"); assert!(serde_json::from_value::<Request>(invalid).is_err());
 }
}
