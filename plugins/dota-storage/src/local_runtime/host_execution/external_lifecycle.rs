//! External admission, shared lifecycle rules and real facade SQL on the existing writer.
use super::*;
use companion_dota_domain::session_lifecycle::{self as lifecycle,LifecycleDecision as Decision,SessionLifecycleView};
#[derive(Debug)]
pub struct Outcome {pub session:Option<String>,pub stream_ended:Option<bool>}
#[derive(Serialize)]
struct LifecycleReceipt {family:&'static str,before:u64,after:u64,decision:Option<Decision>,resolved_session:String,interrupted:Vec<String>,sessions:Vec<SessionReceipt>}
impl Adapter {
 pub fn external_lifecycle(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,streaming:Option<bool>,snapshot:Option<&ReplayGsi>,now:DateTime<Utc>,sweep:bool)->Result<Outcome> {
  let grant=pin;if !grant.permits(MATCH_EXECUTION_CAPABILITY){return Err("capability_denied".into());}
  if grant.session().is_none(){return self.cold_lifecycle(c,grant.lease(),Some(grant.binding()),snapshot,now);}
  self.lifecycle_guarded(c,grant.lease(),grant.session_id()?,Some(grant.binding()),streaming,snapshot,now,sweep)
 }
 fn lifecycle_guarded(&mut self,c:&mut Connection,lease:companion_dota_domain::ownership::Lease,session:&str,package:Option<&PackageBinding>,streaming:Option<bool>,snapshot:Option<&ReplayGsi>,now:DateTime<Utc>,sweep:bool)->Result<Outcome> {
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
  super::super::transaction_authorization::authorize_scope(&tx,lease,session,package)?;
  let before:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let f=Facade::new(&tx);let open=sql(store::find_open_session(&tx))?;
  let mut before_revisions=std::collections::HashMap::new();for id in std::iter::once(session).chain(open.as_ref().map(|s|s.local_id.as_str())) {before_revisions.insert(id.to_string(),revision(&tx,"local_sessions",id)?);}
  let view=open.as_ref().map(|s|Ok::<_,String>(SessionLifecycleView{local_id:s.local_id.clone(),started_at:lifecycle::parse_rfc3339(&s.started_at).ok_or("session_timestamp_invalid")?,pending_end_at:s.pending_end_at.as_deref().map(|v|lifecycle::parse_rfc3339(v).ok_or("session_timestamp_invalid")).transpose()?,stale_ack:s.stale_ack,is_streamed:s.is_streamed})).transpose()?;
  let decision=streaming.map(|streaming|lifecycle::decide(view.as_ref(),streaming,now));
  match decision {
   Some(Decision::StartNewSession)=>{sql(f.session(now,true))?;},
   Some(Decision::ContinueSession)=>{if let Some(s)=&open{sql(f.streamed(&s.local_id,now))?;}},
   Some(Decision::CancelPendingEnd)=>{if let Some(s)=&open{sql(store::cancel_pending_end(&tx,&s.local_id))?;}},
   Some(Decision::BeginPendingEnd)=>{if let Some(s)=&open{sql(store::begin_pending_end(&tx,&s.local_id,now))?;}},
   Some(Decision::FinalizeEnd)=>{if let Some(s)=&open{sql(f.end_session(&s.local_id,now))?;}},
   _=>(),
  }
  // The existing watchdog's ended-session SQL cutoff and neutral interrupted SQL.
  let mut interrupted=Vec::new();
  for matched in if sweep{sql(store::find_stale_matches_with_ended_session(&tx,now,rules::STALE_THRESHOLD))?}else{Vec::new()} {
   sql(f.interrupted(&matched.local_id,now))?;interrupted.push(matched.local_id);
   if interrupted.len()>64{return Err("watchdog_batch_limit".into());}
  }
  // Preserve legacy identity selection: unresolved match's session wins over open session.
  let resolved=if let Some(m)=sql(store::find_active_match_anywhere(&tx))? {m.session_local_id}
   else if let Some(s)=sql(store::find_open_session(&tx))? {s.local_id}
   else if snapshot.and_then(|s|serde_json::to_value(s).ok()).and_then(|v|super::super::gsi::parse(&v)).is_some_and(|s|detector::is_new_match_evidence(&s)) {sql(f.session(now,false))?.local_id}
   else {session.into()};
  let after:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  if after!=before {
   let key=format!("lifecycle:{}:{after}",lease.epoch);
   let mut ids=vec![resolved.clone()];if let Some(s)=&open{ids.push(s.local_id.clone());}if let Some(s)=sql(store::find_open_session(&tx))?{ids.push(s.local_id);}ids.sort();ids.dedup();
   let sessions=ids.iter().map(|id|{let s=sql(f.lookup_session(id))?.ok_or("session_missing")?;Ok(SessionReceipt{local_id:s.local_id,ended_at:s.ended_at,streamed:s.is_streamed,rating_current:s.rating_current,disposition:if before_revisions.get(id).copied()==Some(revision(&tx,"local_sessions",id)?){Disposition::Skipped}else{Disposition::Applied},diagnostic_revision:revision(&tx,"local_sessions",id)?})}).collect::<Result<Vec<_>>>()?;
   let doc=encode(&LifecycleReceipt{family:"lifecycle-v1",before,after,decision,resolved_session:resolved.clone(),interrupted,sessions})?;
   if doc.len()>16384{return Err("lifecycle_receipt_limit".into());}
   sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'completed')",params![key,hash(&doc)]))?;
   sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![key,doc,hash(&doc)]))?;
  }
  super::super::transaction_authorization::rebind_session_in(&tx,lease,session,package,&resolved)?;
  sql(tx.commit())?;
  let stream_ended=match decision{Some(Decision::StartNewSession|Decision::ContinueSession|Decision::CancelPendingEnd)=>Some(false),Some(Decision::FinalizeEnd)=>Some(true),_=>None};
  Ok(Outcome{session:Some(resolved),stream_ended})
 }
 fn cold_lifecycle(&mut self,c:&mut Connection,lease:companion_dota_domain::ownership::Lease,package:Option<&PackageBinding>,snapshot:Option<&ReplayGsi>,now:DateTime<Utc>)->Result<Outcome> {
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
  if let Some(session)=super::super::transaction_authorization::runtime_session(&tx,lease,package)? {
   if sql(store::find_session(&tx,&session))?.is_none(){return Err("session_missing".into());}
   return Ok(Outcome{session:Some(session),stream_ended:None});
  }
  super::super::transaction_authorization::authorize_unbound(&tx,lease,package)?;
  super::super::transaction_authorization::cold_eligible(&tx)?;
  if super::live_effects::quota(&tx)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let real=snapshot.and_then(|s|serde_json::to_value(s).ok()).and_then(|v|super::super::gsi::parse(&v)).is_some_and(|s|detector::is_new_match_evidence(&s));
  if !real{return Ok(Outcome{session:None,stream_ended:None});}
  let before:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let f=Facade::new(&tx);let session=sql(f.session(now,false))?;
  let after:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let doc=encode(&LifecycleReceipt{family:"lifecycle-v1",before,after,decision:None,resolved_session:session.local_id.clone(),interrupted:vec![],sessions:vec![SessionReceipt{local_id:session.local_id.clone(),ended_at:None,streamed:false,rating_current:session.rating_current,disposition:Disposition::Applied,diagnostic_revision:revision(&tx,"local_sessions",&session.local_id)?}]})?;
  let key=format!("lifecycle:{}:{after}",lease.epoch);
  sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'completed')",params![key,hash(&doc)]))?;
  sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![key,doc,hash(&doc)]))?;
  super::super::transaction_authorization::bind_cold_session_in(&tx,lease,package,&session.local_id)?;
  sql(tx.commit())?;Ok(Outcome{session:Some(session.local_id),stream_ended:None})
 }
}
#[cfg(test)]
mod tests {
 use super::*;use crate::local_runtime::{transaction_authorization as auth,transaction_tests as parity};use companion_dota_domain::ownership::{Lease,Owner};
 #[test]
 fn lifecycle_full_write_set_matches_real_store_and_quota_rollback_is_atomic() {
  let (fixture,s,_)=Fixture::seeded().unwrap();let old_path=fixture.root.path().join("legacy-lifecycle.sqlite3");std::fs::copy(&fixture.path,&old_path).unwrap();let mut old=Connection::open(old_path).unwrap();let seed=parity::ids(&old);let mut h=Adapter::install(fixture).unwrap();
  let l=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,l,&s).unwrap();let at=|n:i64|DateTime::from_timestamp(1700000000+n,0).unwrap();
  for (streaming,time) in [(true,2),(false,3),(true,5),(false,6),(false,40)] {
   let session=store::find_open_session(&old).unwrap().unwrap();let view=SessionLifecycleView{local_id:session.local_id.clone(),started_at:lifecycle::parse_rfc3339(&session.started_at).unwrap(),pending_end_at:session.pending_end_at.as_deref().and_then(lifecycle::parse_rfc3339),stale_ack:session.stale_ack,is_streamed:session.is_streamed};
   match lifecycle::decide(Some(&view),streaming,at(time)) {
    Decision::ContinueSession=>store::mark_session_streamed(&mut old,&s,at(time)).unwrap(),Decision::BeginPendingEnd=>store::begin_pending_end(&old,&s,at(time)).unwrap(),Decision::CancelPendingEnd=>store::cancel_pending_end(&old,&s).unwrap(),Decision::FinalizeEnd=>store::finalize_session_end(&mut old,&s,at(time)).unwrap(),_=>(),
   }
   h.adapter.lifecycle_guarded(&mut h.conn,l,&s,None,Some(streaming),None,at(time),true).unwrap();assert_eq!(parity::normalized(&old,&seed),parity::normalized(&h.conn,&seed));
  }
  let before=parity::dump(&h.conn);let count:u64=h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();h.conn.execute("UPDATE pc_tx_limits SET max_operations=?1",[count]).unwrap();
  assert_eq!(h.adapter.lifecycle_guarded(&mut h.conn,l,&s,None,Some(true),None,at(41),true).unwrap_err(),"safety_quota_exhausted");assert_eq!(parity::dump(&h.conn),before);
 }
}
#[cfg(test)]
mod stream_semantics_tests {
 use super::*;use crate::local_runtime::transaction_authorization as auth;use companion_dota_domain::ownership::{Lease,Owner};
 #[test]
 fn gameplay_closure_is_not_stream_closure_and_repeated_continue_has_no_new_ledger_key() {
  let (fixture,s,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&s).unwrap();let at=DateTime::from_timestamp(1700000002,0).unwrap();
  assert_eq!(h.adapter.lifecycle_guarded(&mut h.conn,lease,&s,None,Some(false),None,at,false).unwrap().stream_ended,None);
  {let tx=h.conn.transaction().unwrap();Facade::new(&tx).end_session(&s,at).unwrap();tx.commit().unwrap();}
  assert_eq!(h.adapter.lifecycle_guarded(&mut h.conn,lease,&s,None,Some(false),None,at,false).unwrap().stream_ended,None);
  assert_eq!(h.adapter.lifecycle_guarded(&mut h.conn,lease,&s,None,Some(true),None,at,false).unwrap().stream_ended,Some(false));
  let count:u64=h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();
  assert_eq!(h.adapter.lifecycle_guarded(&mut h.conn,lease,&s,None,Some(true),None,at,false).unwrap().stream_ended,Some(false));
  assert_eq!(h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get::<_,u64>(0)).unwrap(),count);
 }
}
