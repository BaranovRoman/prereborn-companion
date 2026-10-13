//! Indexed effect admissions share the production connection, ownership and quota triggers.
//! Unknown is committed BEFORE transport IO; no read/recovery method can re-admit it.
use super::*;
use companion_dota_domain::{effects::{Request as EffectRequest,Ack,Effect},ownership::Lease,match_execution::PackageBinding};
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {family:String,session:String,ack:Ack}
pub(crate) struct EffectAdmission {pub(crate) ack:Ack,pub(crate) fresh:bool,identity:String,session:String}
fn bounded_record(c:&Connection,key:&str)->Result<()> {
 let bad:bool=sql(c.query_row("SELECT EXISTS(SELECT 1 FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1 AND (length(identity)!=64 OR length(CAST(receipt AS BLOB))>2048 OR length(checksum)!=64))",[key],|r|r.get(0)))?;
 if bad{return Err("receipt_corrupt".into());}Ok(())
}
impl Adapter {
 pub(crate) fn admit_effect(&mut self,c:&mut Connection,pin:&crate::core::plugin_manager::VerifiedMatchGrant<'_>,req:&EffectRequest,now:u64)->Result<EffectAdmission> {
  let g=pin.grant();if !g.permits(req.effect.capability().permission()){return Err("capability_denied".into());}
  self.admit_effect_guarded(c,g.lease,&g.session,Some(g.binding()),req,now)
 }
 fn admit_effect_guarded(&mut self,c:&mut Connection,lease:Lease,session:&str,package:Option<&PackageBinding>,req:&EffectRequest,now:u64)->Result<EffectAdmission> {
  if req.api!=1||req.lease!=lease||!req.idempotency_key.starts_with("effect:")||!req.effect.validate()
      ||!matches!(req.effect,Effect::Sound{kind:Some(_),..}|Effect::ObsScene{..}|Effect::Overlay{..})
      ||[&req.idempotency_key,&req.correlation_id].iter().any(|v|v.is_empty()||v.len()>128||!v.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-.:".contains(&b))){return Err("invalid_effect_request".into());}
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
  super::super::transaction_authorization::authorize_scope(&tx,lease,session,package)?;
  let identity=hash(&encode(&("effect-v1",session,&req.effect))?);
  bounded_record(&tx,&req.idempotency_key)?;
  let row:Option<(String,String,Option<String>,Option<String>)>=sql(tx.query_row("SELECT identity,status,CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt ELSE NULL END,checksum FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&req.idempotency_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
  if let Some((prior,status,doc,checksum))=row {
   if prior!=identity{return Err("idempotency_conflict".into());}
   let doc=doc.ok_or("receipt_corrupt")?;if doc.len()>2048||Some(hash(&doc))!=checksum{return Err("receipt_corrupt".into());}
   let stored:Stored=serde_json::from_str(&doc).map_err(|_|"receipt_corrupt")?;
   let expected=match stored.ack.status{Status::Completed=>"completed",Status::Rejected=>"rejected",Status::Unknown=>"unknown",Status::Accepted=>return Err("receipt_corrupt".into())};
   if stored.family!="effect-v1"||stored.session!=session||stored.ack.idempotency_key!=req.idempotency_key||status!=expected{return Err("receipt_corrupt".into());}
   return Ok(EffectAdmission{ack:stored.ack,fresh:false,identity,session:session.into()});
  }
  if req.deadline_ms<=now||req.deadline_ms-now>30000{return Err("deadline_invalid".into());}
  let ack=Ack{correlation_id:req.correlation_id.clone(),idempotency_key:req.idempotency_key.clone(),lease,status:Status::Unknown};
  let doc=encode(&Stored{family:"effect-v1".into(),session:session.into(),ack:ack.clone()})?;
  sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'unknown')",params![req.idempotency_key,identity]))?;
  sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![req.idempotency_key,doc,hash(&doc)]))?;
  sql(tx.commit())?;Ok(EffectAdmission{ack,fresh:true,identity,session:session.into()})
 }
 pub(crate) fn settle_effect(&mut self,c:&mut Connection,admission:EffectAdmission,status:Status)->Result<Ack> {
  if !admission.fresh||status==Status::Accepted{return Err("effect_not_admitted".into());}
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
  // Completion belongs to an already admitted operation, even when draining began meanwhile.
  bounded_record(&tx,&admission.ack.idempotency_key)?;
  let (old_doc,old_hash):(String,String)=sql(tx.query_row("SELECT receipt,checksum FROM pc_tx_receipts WHERE operation_key=?1",[&admission.ack.idempotency_key],|r|Ok((r.get(0)?,r.get(1)?))))?;
  if hash(&old_doc)!=old_hash{return Err("receipt_corrupt".into());}
  let existing:(String,String)=sql(tx.query_row("SELECT identity,status FROM pc_tx_ledger WHERE operation_key=?1",[&admission.ack.idempotency_key],|r|Ok((r.get(0)?,r.get(1)?))))?;
  if existing!=(admission.identity,"unknown".into()){return Err("terminal_receipt_is_immutable".into());}
  let ack=Ack{status,..admission.ack};let doc=encode(&Stored{family:"effect-v1".into(),session:admission.session,ack:ack.clone()})?;
  let fits:bool=sql(tx.query_row("SELECT (SELECT bytes FROM pc_tx_usage WHERE kind='pc_tx_receipts')-length(CAST(receipt AS BLOB))+?2<=(SELECT max_receipt_bytes FROM pc_tx_limits WHERE id=1) FROM pc_tx_receipts WHERE operation_key=?1",params![ack.idempotency_key,doc.len() as u64],|r|r.get(0)))?;
  if !fits{return Err("safety_quota_exhausted".into());}
  sql(tx.execute("UPDATE pc_tx_ledger SET status=?2 WHERE operation_key=?1",params![ack.idempotency_key,match status{Status::Completed=>"completed",Status::Rejected=>"rejected",_=>"unknown"}]))?;
  sql(tx.execute("UPDATE pc_tx_receipts SET receipt=?2,checksum=?3 WHERE operation_key=?1",params![ack.idempotency_key,doc,hash(&doc)]))?;
  sql(tx.commit())?;Ok(ack)
 }
}
#[derive(Serialize,Debug)]
#[serde(rename_all="camelCase")]
pub(crate) struct Quota {pub(crate) remaining_operations:u64,pub(crate) remaining_tickets:u64,pub(crate) remaining_receipt_bytes:u64,pub(crate) unknown:u64}
pub(crate) fn quota(c:&Connection)->Result<Quota> {
 super::super::transaction_schema::version(c)?;
 let (operations,tickets,bytes):(u64,u64,u64)=sql(c.query_row("SELECT max(0,max_operations-(SELECT entries FROM pc_tx_usage WHERE kind='pc_tx_ledger')),max(0,max_tickets-(SELECT entries FROM pc_tx_usage WHERE kind='pc_tx_ticket')),max(0,max_receipt_bytes-(SELECT bytes FROM pc_tx_usage WHERE kind='pc_tx_receipts')) FROM pc_tx_limits WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
 Ok(Quota{remaining_operations:operations,remaining_tickets:tickets,remaining_receipt_bytes:bytes,unknown:sql(c.query_row("SELECT count(*) FROM pc_tx_ledger WHERE status='unknown'",[],|r|r.get(0)))?})
}
#[cfg(test)]
mod tests {
 use super::*;
 use crate::local_runtime::{transaction_authorization as auth,host_execution::Adapter};
 #[test]
 fn durable_effects_never_readmit_unknown_completed_conflicts_or_exhaustion() {
  let (f,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(f.clone()).unwrap();
  let old=match auth::phase(&h.conn).unwrap(){companion_dota_domain::ownership::Phase::Draining{old,..}=>old,_=>panic!()};
  let lease=auth::confirm_fenced(&mut h.conn,old).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
  let mut req=EffectRequest{api:1,lease,correlation_id:"effect:c".into(),idempotency_key:"effect:one".into(),deadline_ms:1000,effect:Effect::Sound{event_id:"item_tango".into(),kind:Some(companion_dota_domain::events::GameSoundEventKind::ItemUsed)}};
  let a=h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap();assert!(a.fresh);drop(a);
  assert!(!h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap().fresh);
  req.idempotency_key="effect:two".into();let a=h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap();
  h.adapter.settle_effect(&mut h.conn,a,Status::Completed).unwrap();
  assert_eq!(h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,1001).unwrap().ack.status,Status::Completed);
  req.effect=Effect::Overlay{state:companion_dota_domain::broadcast_state::BroadcastState::Gameplay};assert!(h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).is_err());
  h.conn.execute("UPDATE pc_tx_limits SET max_operations=2",[]).unwrap();req.idempotency_key="effect:extra".into();assert!(h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).is_err());
  assert_eq!(quota(&h.conn).unwrap().remaining_operations,0);assert_eq!(quota(&h.conn).unwrap().unknown,1);
  auth::begin(&mut h.conn,lease,companion_dota_domain::ownership::Owner::External,&session,Some(PackageBinding{id:"dota2".into(),version:"1".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)})).unwrap();
  assert!(h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).is_err());
 }
}

#[cfg(test)]
mod reopen_tests {
 use super::*;use crate::local_runtime::transaction_authorization as auth;use companion_dota_domain::ownership::{Owner,Phase};
 #[test]
 fn crash_after_effect_admission_reopen_never_reauthorizes_dispatch() {
  let (fixture,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture.clone()).unwrap();
  let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
  let mut req=EffectRequest{api:1,lease,correlation_id:"effect:c".into(),idempotency_key:"effect:one".into(),deadline_ms:1000,effect:Effect::Overlay{state:companion_dota_domain::broadcast_state::BroadcastState::Gameplay}};
  let admitted=h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap();assert!(admitted.fresh);drop(admitted);drop(h);
  let mut conn=fixture.connect().unwrap();let mut adapter=Adapter::attach(&mut conn).unwrap();assert!(matches!(auth::phase(&conn).unwrap(),Phase::Draining{..}));
  assert!(adapter.admit_effect_guarded(&mut conn,lease,&session,None,&req,0).is_err());
  req.lease=auth::confirm_fenced(&mut conn,lease).unwrap();auth::bind_builtin_session(&mut conn,req.lease,&session).unwrap();
  let duplicate=adapter.admit_effect_guarded(&mut conn,req.lease,&session,None,&req,0).unwrap();assert!(!duplicate.fresh);assert_eq!(duplicate.ack.status,Status::Unknown);
 }
 #[test]
 fn no_plan_allocates_neither_ticket_nor_operation_key() {
  let (fixture,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
  let before=quota(&h.conn).unwrap();
  assert!(h.adapter.prepare_live_operation(&mut h.conn,&session,Default::default(),Utc::now(),1).unwrap().is_none());
  let after=quota(&h.conn).unwrap();assert_eq!(before.remaining_tickets,after.remaining_tickets);assert_eq!(before.remaining_operations,after.remaining_operations);
 }
}

#[cfg(test)]
mod settlement_quota_tests {
 use super::*;use crate::local_runtime::transaction_authorization as auth;use companion_dota_domain::ownership::Owner;
 #[test]
 fn receipt_byte_exhaustion_after_transport_keeps_unknown_without_partial_ack() {
  let (fixture,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
  let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
  let req=EffectRequest{api:1,lease,correlation_id:"effect:c".into(),idempotency_key:"effect:quota".into(),deadline_ms:1000,effect:Effect::Overlay{state:companion_dota_domain::broadcast_state::BroadcastState::Gameplay}};
  let admitted=h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap();
  h.conn.execute("UPDATE pc_tx_limits SET max_receipt_bytes=(SELECT bytes FROM pc_tx_usage WHERE kind='pc_tx_receipts')",[]).unwrap();
  assert_eq!(h.adapter.settle_effect(&mut h.conn,admitted,Status::Completed).unwrap_err(),"safety_quota_exhausted");
  assert_eq!(h.conn.query_row("SELECT status FROM pc_tx_ledger WHERE operation_key=?1",[&req.idempotency_key],|r|r.get::<_,String>(0)).unwrap(),"unknown");
  assert!(!h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap().fresh);
 }
}

#[cfg(test)]
mod corruption_tests {
 use super::*;use crate::local_runtime::transaction_authorization as auth;use companion_dota_domain::ownership::Owner;
 #[test]
 fn corrupted_admission_cannot_be_reauthorized_or_settled() {
  let (fixture,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
  let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
  let req=EffectRequest{api:1,lease,correlation_id:"effect:c".into(),idempotency_key:"effect:corrupt".into(),deadline_ms:1000,effect:Effect::Overlay{state:companion_dota_domain::broadcast_state::BroadcastState::Gameplay}};
  let admission=h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).unwrap();
  h.conn.execute("UPDATE pc_tx_receipts SET checksum=?1",["0".repeat(64)]).unwrap();
  assert!(h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).is_err());
  assert_eq!(h.adapter.settle_effect(&mut h.conn,admission,Status::Completed).unwrap_err(),"receipt_corrupt");
  h.conn.execute("UPDATE pc_tx_ledger SET identity=?1",["x".repeat(4097)]).unwrap();
  assert!(h.adapter.admit_effect_guarded(&mut h.conn,lease,&session,None,&req,0).is_err());
 }
}
