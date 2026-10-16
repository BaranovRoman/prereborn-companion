//! External admission, shared lifecycle rules and real facade SQL on the existing writer.
use super::*;
use companion_dota_domain::session_lifecycle::{self as lifecycle,LifecycleDecision as Decision,SessionLifecycleView};
#[derive(Debug)]
pub struct Outcome {pub session:Option<String>,pub stream_ended:Option<bool>}
#[derive(Serialize)]
struct LifecycleReceipt {family:&'static str,before:u64,after:u64,decision:Option<Decision>,resolved_session:String,interrupted:Vec<String>,sessions:Vec<SessionReceipt>}
impl Adapter {
 pub fn corrections_since(&mut self,c:&mut Connection,pin:&impl ExecutionGrant)->Result<String>{
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;self.sync_scope(&tx,pin)?;
  let since=sql(super::super::sync::meta_get(&tx,"corrections_since"))?.unwrap_or_else(||"1970-01-01T00:00:00Z".into());
  if lifecycle::parse_rfc3339(&since).is_none(){return Err("corrections_cursor_invalid".into());}Ok(since)
 }
 /// Original correction SQL, cursor (+1ms) and its durable receipt commit
 /// together. A failed/oversized batch cannot silently advance the cursor.
 pub fn apply_corrections(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,since:&str,batch:&[super::super::sync::Correction])->Result<()> {
  let lower=lifecycle::parse_rfc3339(since).ok_or("corrections_cursor_invalid")?;
  if batch.len()>128||encode(&batch)?.len()>24576{return Err("corrections_limit".into());}
  let mut latest=None;for correction in batch{let time=correction.validate()?;if time<lower{return Err("correction_before_cursor".into());}latest=Some(latest.map_or(time,|previous:DateTime<Utc>|previous.max(time)));}
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;self.sync_scope(&tx,pin)?;
  let key=format!("corrections:{}",hash(&encode(&(since,batch))?));
  let saved:Option<(String,String,Option<String>,Option<String>)>=sql(tx.query_row("SELECT identity,status,CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt ELSE NULL END,checksum FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
  if let Some((identity,status,doc,checksum))=saved{let doc=doc.ok_or("receipt_corrupt")?;if status!="completed"||hash(&doc)!=identity||checksum.as_deref()!=Some(hash(&doc).as_str()){return Err("receipt_corrupt".into());}return Ok(());}
  let current=sql(super::super::sync::meta_get(&tx,"corrections_since"))?.unwrap_or_else(||"1970-01-01T00:00:00Z".into());if current!=since{return Err("corrections_cursor_changed".into());}
  let Some(latest)=latest else{return Ok(());};
  let before:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let f=Facade::new(&tx);for correction in batch{sql(f.server_correction(&correction.local_match_id,correction.rating_delta,correction.rating_after,correction.session_rating,correction.session_rating_adjustment))?;}
  let next=latest.checked_add_signed(chrono::Duration::milliseconds(1)).ok_or("correction_timestamp_invalid")?.to_rfc3339();
  sql(super::super::sync::meta_set(&tx,"corrections_since",&next))?;
  let after:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let doc=encode(&serde_json::json!({"family":"corrections-v1","before":before,"after":after,"since":since,"next":next,"count":batch.len()}))?;
  Self::sync_receipt(&tx,&key,&hash(&doc),&doc)?;sql(tx.commit())
 }
 fn sync_scope(&self,tx:&Transaction<'_>,pin:&impl ExecutionGrant)->Result<()> {
  if !pin.permits(MATCH_EXECUTION_CAPABILITY)||!pin.permits("backend.access"){return Err("capability_denied".into());}
  Self::verify(tx,&self.expected_schema)?;
  if let Some(session)=pin.session(){super::super::transaction_authorization::authorize_scope(tx,pin.lease(),session,Some(pin.binding()))}else{super::super::transaction_authorization::authorize_unbound(tx,pin.lease(),Some(pin.binding()))}
 }
 fn sync_receipt(tx:&Transaction<'_>,key:&str,identity:&str,doc:&str)->Result<()> {
  sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'completed')",params![key,identity]))?;
  sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![key,doc,hash(doc)]))?;Ok(())
 }
 /// Fix the existing cutover timestamp before opening fresh GSI admission,
 /// otherwise the first real session could be mistaken for shadow-era data.
 pub fn initialize_sync(&mut self,c:&mut Connection,pin:&impl ExecutionGrant)->Result<()> {
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;self.sync_scope(&tx,pin)?;
  if let Some(value)=sql(super::super::sync::meta_get(&tx,"cutover_at"))?{if companion_dota_domain::session_lifecycle::parse_rfc3339(&value).is_none(){return Err("sync_cutover_invalid".into());}return Ok(());}
  let cutover=sql(super::super::sync::cutover_at(&tx))?;let revision:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let doc=encode(&serde_json::json!({"family":"sync-cutover-v1","cutoverAt":cutover,"revision":revision}))?;
  Self::sync_receipt(&tx,&format!("sync-cutover:{}:{revision}",pin.lease().epoch),&hash(&doc),&doc)?;sql(tx.commit())
 }
 pub fn pending_sync(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,now:DateTime<Utc>)->Result<Option<super::super::sync::OutboxRow>> {
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;self.sync_scope(&tx,pin)?;
  let cutover=sql(super::super::sync::meta_get(&tx,"cutover_at"))?.and_then(|s|companion_dota_domain::session_lifecycle::parse_rfc3339(&s)).ok_or("sync_cutover_invalid")?;
  let oversized:bool=sql(tx.query_row("SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND length(CAST(payload AS BLOB))>6144)",[],|r|r.get(0)))?;
  if oversized{return Err("outbox_payload_limit".into());}
  // Bounded legacy-shadow skipping. Continue on the next tick, never starve GSI.
  for _ in 0..8 {
   let Some(row)=sql(super::super::sync::next_pending(&tx,now))?else{sql(tx.commit())?;return Ok(None);};
   if sql(super::super::sync::is_eligible(&tx,&row,cutover))?{
    if row.attempts<0||uuid::Uuid::parse_str(&row.id).is_err(){return Err("outbox_corrupt".into());}
    let key=format!("outbox-admit:{}:{}",row.id,row.attempts);let identity=hash(&encode(&("outbox-admission-v1",&row))?);
    let saved:Option<(String,String,String,String)>=sql(tx.query_row("SELECT identity,status,CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt ELSE NULL END,checksum FROM pc_tx_ledger JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
    if let Some((prior,status,doc,checksum))=saved{if prior!=identity||status!="completed"||hash(&doc)!=checksum{return Err("receipt_corrupt".into());}}
    else{
     sql(super::super::sync::mark_sending(&tx,&row.id,row.attempts,now))?;
     let doc=encode(&serde_json::json!({"family":"outbox-admission-v1","id":row.id,"delivery":"unknown","attempt":row.attempts}))?;
     Self::sync_receipt(&tx,&key,&identity,&doc)?;
    }
    sql(tx.commit())?;return Ok(Some(row));
   }
   sql(super::super::sync::mark_failed(&tx,&row.id,super::super::sync::SHADOW_DEAD_LETTER_ERROR,now))?;
   let doc=encode(&serde_json::json!({"family":"outbox-state-v1","id":row.id,"delivery":"pre-cutover-rejected"}))?;
   Self::sync_receipt(&tx,&format!("outbox-shadow:{}",row.id),&hash(&doc),&doc)?;
  }
  sql(tx.commit())?;Ok(None)
 }
 /// Records delivery truth, including Unknown/retry, using the same original
 /// event UUID. Only sync/events has a proven server-side idempotency contract;
 /// this does NOT authorize generic HTTP, OBS or audio retries.
 pub fn settle_sync(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,row:&super::super::sync::OutboxRow,delivery:&str,now:DateTime<Utc>)->Result<()> {
  if !matches!(delivery,"delivered"|"rejected"|"unknown"|"retryable"){return Err("invalid_sync_result".into());}
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;self.sync_scope(&tx,pin)?;
  let key=format!("outbox:{}:{}",row.id,row.attempts);let identity=hash(&encode(&("outbox-state-v1",row,delivery))?);
  let saved:Option<(String,String,Option<String>,Option<String>)>=sql(tx.query_row("SELECT identity,status,CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt ELSE NULL END,checksum FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
  if let Some((saved,status,doc,checksum))=saved{
   if saved!=identity{return Err("payload_conflict".into());}
   let doc=doc.ok_or("receipt_corrupt")?;if status!="completed"||checksum.as_deref()!=Some(hash(&doc).as_str()){return Err("receipt_corrupt".into());}return Ok(());
  }
  let current:(String,String,i64,Option<String>,Option<String>)=sql(tx.query_row("SELECT event_type,CASE WHEN length(CAST(payload AS BLOB))<=6144 THEN payload ELSE NULL END,attempts,delivered_at,failed_at FROM sync_outbox WHERE id=?1",[&row.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))))?;
  if current.0!=row.event_type||current.1!=row.payload||current.2!=row.attempts||current.3.is_some()||current.4.is_some(){return Err("outbox_precondition_changed".into());}
  match delivery{
   "delivered"=>sql(super::super::sync::mark_delivered(&tx,&row.id,now))?,
   "rejected"=>sql(super::super::sync::mark_failed(&tx,&row.id,"backend rejected event",now))?,
   _=>sql(super::super::sync::mark_retry(&tx,&row.id,if delivery=="unknown"{"backend result Unknown; same event UUID retained"}else{"backend temporarily unavailable"},row.attempts,now))?,
  }
  let revision:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let doc=encode(&serde_json::json!({"family":"outbox-state-v1","id":row.id,"delivery":delivery,"revision":revision}))?;
  Self::sync_receipt(&tx,&key,&identity,&doc)?;sql(tx.commit())
 }
 /// Same account bootstrap rules as the legacy sync worker. A cached profile
 /// can initialize an unknown device rating, never overwrite a local/session
 /// correction. Cache writes and their receipt share the history transaction.
 pub fn refresh_account(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,mode:Option<&str>,rating:Option<i64>)->Result<()> {
  if !pin.permits(MATCH_EXECUTION_CAPABILITY)||!pin.permits("backend.access"){return Err("capability_denied".into());}
  self.account_guarded(c,pin.lease(),pin.session(),Some(pin.binding()),mode,rating)
 }
 fn account_guarded(&mut self,c:&mut Connection,lease:companion_dota_domain::ownership::Lease,session:Option<&str>,package:Option<&PackageBinding>,mode:Option<&str>,rating:Option<i64>)->Result<()> {
  if mode.is_some_and(|m|!matches!(m,"ranked"|"unranked"))||rating.is_some_and(|r|!(0..=30000).contains(&r)){return Err("account_settings_invalid".into());}
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
  if let Some(session)=session{super::super::transaction_authorization::authorize_scope(&tx,lease,session,package)?;}else{super::super::transaction_authorization::authorize_unbound(&tx,lease,package)?;}
  let before:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  if let Some(mode)=mode{if sql(super::super::sync::meta_get(&tx,"cached_game_mode"))?.as_deref()!=Some(mode){sql(super::super::sync::meta_set(&tx,"cached_game_mode",mode))?;}}
  if sql(store::find_open_session(&tx))?.is_none()&&sql(store::get_current_rating(&tx))?.is_none(){if let Some(rating)=rating{sql(Facade::new(&tx).rating(rating))?;}}
  let after:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  if before!=after{
   let doc=encode(&serde_json::json!({"family":"account-bootstrap-v1","before":before,"after":after,"mode":sql(super::super::sync::meta_get(&tx,"cached_game_mode"))?,"rating":sql(store::get_current_rating(&tx))?}))?;
   let key=format!("account:{}:{after}",lease.epoch);
   sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'completed')",params![key,hash(&doc)]))?;sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![key,doc,hash(&doc)]))?;
  }
  sql(tx.commit())
 }
 pub fn external_lifecycle(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,streaming:Option<bool>,snapshot:Option<&ReplayGsi>,now:DateTime<Utc>,sweep:bool)->Result<Outcome> {
  let grant=pin;if !grant.permits(MATCH_EXECUTION_CAPABILITY){return Err("capability_denied".into());}
  if grant.session().is_none(){return self.cold_lifecycle(c,grant.lease(),Some(grant.binding()),streaming,snapshot,now);}
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
 fn cold_lifecycle(&mut self,c:&mut Connection,lease:companion_dota_domain::ownership::Lease,package:Option<&PackageBinding>,streaming:Option<bool>,snapshot:Option<&ReplayGsi>,now:DateTime<Utc>)->Result<Outcome> {
  self.bound(c)?;let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
  if let Some(session)=super::super::transaction_authorization::runtime_session(&tx,lease,package)? {
   if sql(store::find_session(&tx,&session))?.is_none(){return Err("session_missing".into());}
   return Ok(Outcome{session:Some(session),stream_ended:None});
  }
  super::super::transaction_authorization::authorize_unbound(&tx,lease,package)?;
  super::super::transaction_authorization::cold_eligible(&tx)?;
  if super::live_effects::quota(&tx)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}
  let real=snapshot.and_then(|s|serde_json::to_value(s).ok()).and_then(|v|super::super::gsi::parse(&v)).is_some_and(|s|detector::is_new_match_evidence(&s));
  let decision=streaming.map(|s|lifecycle::decide(None,s,now));
  let streamed=decision==Some(Decision::StartNewSession);
  if !real&&!streamed{return Ok(Outcome{session:None,stream_ended:None});}
  let before:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let f=Facade::new(&tx);let session=sql(f.session(now,streamed))?;
  let after:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
  let doc=encode(&LifecycleReceipt{family:"lifecycle-v1",before,after,decision,resolved_session:session.local_id.clone(),interrupted:vec![],sessions:vec![SessionReceipt{local_id:session.local_id.clone(),ended_at:None,streamed,rating_current:session.rating_current,disposition:Disposition::Applied,diagnostic_revision:revision(&tx,"local_sessions",&session.local_id)?}]})?;
  let key=format!("lifecycle:{}:{after}",lease.epoch);
  sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'completed')",params![key,hash(&doc)]))?;
  sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![key,doc,hash(&doc)]))?;
  super::super::transaction_authorization::bind_cold_session_in(&tx,lease,package,&session.local_id)?;
  sql(tx.commit())?;Ok(Outcome{session:Some(session.local_id),stream_ended:streamed.then_some(false)})
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
 #[test]
 fn account_refresh_cannot_overwrite_local_rating_or_allocate_receipts_for_unchanged_polls_and_rolls_back_on_quota(){
  let(fixture,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
  h.adapter.account_guarded(&mut h.conn,lease,Some(&session),None,Some("ranked"),Some(2300)).unwrap();assert_eq!(store::get_current_rating(&h.conn).unwrap(),Some(1000));
  let count:u64=h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();assert_eq!(count,1);let epoch:u64=h.conn.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)).unwrap();
  h.adapter.account_guarded(&mut h.conn,lease,Some(&session),None,Some("ranked"),Some(2800)).unwrap();assert_eq!(h.conn.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get::<_,u64>(0)).unwrap(),epoch);
  assert_eq!(h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get::<_,u64>(0)).unwrap(),count);
  h.conn.execute("UPDATE pc_tx_limits SET max_operations=1",[]).unwrap();let before=crate::local_runtime::transaction_tests::dump(&h.conn);
  assert_eq!(h.adapter.account_guarded(&mut h.conn,lease,Some(&session),None,Some("unranked"),Some(9000)).unwrap_err(),"safety_quota_exhausted");assert_eq!(crate::local_runtime::transaction_tests::dump(&h.conn),before);
  assert_eq!(super::super::super::sync::meta_get(&h.conn,"cached_game_mode").unwrap().as_deref(),Some("ranked"));
 }
 #[test]
 fn cold_stream_start_binds_one_real_session_and_retry_returns_its_persisted_identity(){
  let root=tempfile::tempdir().unwrap();let mut c=Connection::open(root.path().join("isolated.sqlite3")).unwrap();schema::migrate(&c).unwrap();
  crate::local_runtime::transaction_schema::migrate(&mut c,&root.path().join("backup.sqlite3")).unwrap();
  let mut adapter=Adapter::attach(&mut c).unwrap();
  let old=auth::confirm_fenced(&mut c,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();
  let package=PackageBinding{id:"dota2".into(),version:"0.1.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)};
  // Transaction fixture only: production activate_worker requires native job
  // proof. Exercise the very same durable ownership checks and lifecycle SQL.
  auth::begin_cold(&mut c,old,Owner::External,Some(package.clone())).unwrap();
  let lease=Lease{owner:Owner::External,epoch:old.epoch+1};
  auth::process_starting(&mut c,lease,&package,&uuid::Uuid::new_v4().to_string()).unwrap();
  assert_eq!(auth::confirm_fenced(&mut c,old).unwrap(),lease);
  let now=DateTime::from_timestamp(1700000000,0).unwrap();
  for streaming in [None,Some(false)]{
   assert!(adapter.cold_lifecycle(&mut c,lease,Some(&package),streaming,None,now).unwrap().session.is_none());
   assert!(store::find_open_session(&c).unwrap().is_none());
  }
  let outcome=adapter.cold_lifecycle(&mut c,lease,Some(&package),Some(true),None,now).unwrap();
  assert_eq!(outcome.stream_ended,Some(false));let id=outcome.session.unwrap();
  let saved=store::find_session(&c,&id).unwrap().unwrap();assert!(saved.is_streamed);assert!(saved.ended_at.is_none());
  assert_eq!(auth::load(&c).unwrap().session,Some(id.clone()));
  let ledger:u64=c.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();assert_eq!(ledger,1);
  let doc:String=c.query_row("SELECT receipt FROM pc_tx_receipts",[],|r|r.get(0)).unwrap();let receipt:serde_json::Value=serde_json::from_str(&doc).unwrap();
  assert_eq!(receipt["resolved_session"],id);assert_eq!(receipt["decision"],"start_new_session");
  assert_eq!(adapter.cold_lifecycle(&mut c,lease,Some(&package),Some(true),None,now).unwrap().session,Some(id));
  assert_eq!(c.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get::<_,u64>(0)).unwrap(),ledger);
  assert_eq!(c.query_row("SELECT count(*) FROM local_sessions",[],|r|r.get::<_,u64>(0)).unwrap(),1);
 }
 #[test]
 fn idle_watchdog_reuses_real_interrupted_sql_only_after_session_end(){
  let(fixture,session,matched)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
  let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
  let old_seen:String=h.conn.query_row("SELECT last_seen_at FROM local_matches WHERE local_id=?1",[&matched],|r|r.get(0)).unwrap();
  let now=lifecycle::parse_rfc3339(&old_seen).unwrap()+chrono::Duration::hours(2);
  let state=|c:&Connection|c.query_row("SELECT state FROM local_matches WHERE local_id=?1",[&matched],|r|r.get::<_,String>(0)).unwrap();
  let before=state(&h.conn);h.adapter.lifecycle_guarded(&mut h.conn,lease,&session,None,None,None,now,true).unwrap();assert_eq!(state(&h.conn),before);
  {let tx=h.conn.transaction().unwrap();Facade::new(&tx).end_session(&session,now).unwrap();tx.commit().unwrap();}
  h.adapter.lifecycle_guarded(&mut h.conn,lease,&session,None,None,None,now,true).unwrap();assert_eq!(state(&h.conn),"interrupted");
  let count:u64=h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();
  h.adapter.lifecycle_guarded(&mut h.conn,lease,&session,None,None,None,now,true).unwrap();assert_eq!(h.conn.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get::<_,u64>(0)).unwrap(),count);
 }
}

#[cfg(test)]
mod sync_bookkeeping_tests {
 use super::*;use crate::local_runtime::{transaction_authorization as auth,transaction_schema,sync};
 use companion_dota_domain::ownership::{Lease,Owner};
 struct Pin{package:PackageBinding,lease:Lease,session:Option<String>}
 impl companion_plugin_protocol::ProcessGrant for Pin{fn binding(&self)->&PackageBinding{&self.package}fn executable(&self)->&std::path::Path{std::path::Path::new("transaction-fixture")}fn permits(&self,cap:&str)->bool{matches!(cap,MATCH_EXECUTION_CAPABILITY|"backend.access")}}
 impl ExecutionGrant for Pin{fn lease(&self)->Lease{self.lease}fn session(&self)->Option<&str>{self.session.as_deref()}}
 fn ready()->(tempfile::TempDir,Connection,Adapter,Pin,DateTime<Utc>){
  let root=tempfile::tempdir().unwrap();let mut c=Connection::open(root.path().join("isolated.sqlite3")).unwrap();schema::migrate(&c).unwrap();transaction_schema::migrate(&mut c,&root.path().join("backup.sqlite3")).unwrap();let mut adapter=Adapter::attach(&mut c).unwrap();
  let old=auth::confirm_fenced(&mut c,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();let package=PackageBinding{id:"dota2".into(),version:"0.2.0".into(),executable_hash:"a".repeat(64),manifest_hash:"b".repeat(64)};
  // SQL/ownership fixture only. Native OS proof is covered by the Windows
  // real-process test, never forged by the production activation path.
  auth::begin_cold(&mut c,old,Owner::External,Some(package.clone())).unwrap();let lease=Lease{owner:Owner::External,epoch:old.epoch+1};auth::process_starting(&mut c,lease,&package,&uuid::Uuid::new_v4().to_string()).unwrap();auth::confirm_fenced(&mut c,old).unwrap();
  let mut pin=Pin{package,lease,session:None};adapter.initialize_sync(&mut c,&pin).unwrap();assert!(store::find_open_session(&c).unwrap().is_none());
  let now=Utc::now()+chrono::Duration::seconds(1);pin.session=adapter.external_lifecycle(&mut c,&pin,Some(true),None,now,false).unwrap().session;
  (root,c,adapter,pin,now+chrono::Duration::seconds(1))
 }
 #[test]
 fn server_correction_batch_matches_real_legacy_write_set_and_cursor_and_receipt_are_atomic(){
  let(root,mut c,mut adapter,pin,now)=ready();let session=pin.session.as_deref().unwrap();
  store::set_current_rating(&mut c,2400).unwrap();store::create_match(&c,session,Some("321"),105,"radiant",RankedMode::Ranked,now).unwrap();
  let m=store::find_active_match(&c,session).unwrap().unwrap();store::finalize_match(&mut c,&m.local_id,session,RankedMode::Ranked,crate::local_runtime::model::MatchResult::Win,"confirmed",now).unwrap();
  let reference=root.path().join("legacy.sqlite3");c.execute("VACUUM INTO ?1",[reference.to_str().unwrap()]).unwrap();let old=Connection::open(reference).unwrap();
  let since=adapter.corrections_since(&mut c,&pin).unwrap();let correction=sync::Correction{local_match_id:m.local_id.clone(),rating_delta:35,rating_after:Some(2435),session_rating:Some(2435),session_rating_adjustment:Some(10),corrected_at:now.to_rfc3339()};let batch=vec![correction.clone()];
  sync::apply_one_correction(&old,&m.local_id,35,Some(2435),Some(2435),Some(10)).unwrap();sync::meta_set(&old,"corrections_since",&(now+chrono::Duration::milliseconds(1)).to_rfc3339()).unwrap();
  adapter.apply_corrections(&mut c,&pin,&since,&batch).unwrap();assert_eq!(crate::local_runtime::transaction_tests::dump(&c),crate::local_runtime::transaction_tests::dump(&old));
  let revision:u64=c.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)).unwrap();let before=crate::local_runtime::transaction_tests::dump(&c);
  adapter.apply_corrections(&mut c,&pin,&since,&batch).unwrap();assert_eq!(crate::local_runtime::transaction_tests::dump(&c),before);assert_eq!(c.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get::<_,u64>(0)).unwrap(),revision);
  let since=adapter.corrections_since(&mut c,&pin).unwrap();let count:u64=c.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();c.execute("UPDATE pc_tx_limits SET max_operations=?1",[count]).unwrap();let mut next=correction;next.rating_delta=40;next.corrected_at=(now+chrono::Duration::seconds(2)).to_rfc3339();
  assert_eq!(adapter.apply_corrections(&mut c,&pin,&since,&[next.clone()]).unwrap_err(),"safety_quota_exhausted");assert_eq!(crate::local_runtime::transaction_tests::dump(&c),before);assert_eq!(adapter.corrections_since(&mut c,&pin).unwrap(),since);
  next.corrected_at="malformed".into();assert_eq!(adapter.apply_corrections(&mut c,&pin,&since,&[next]).unwrap_err(),"correction_timestamp_invalid");assert_eq!(crate::local_runtime::transaction_tests::dump(&c),before);
 }
 #[test]
 fn unknown_delivery_retains_the_original_fifo_event_uuid_and_payload_and_ack_is_idempotent(){
  let(_root,mut c,mut adapter,pin,now)=ready();let row=adapter.pending_sync(&mut c,&pin,now).unwrap().unwrap();
  let status=sync::outbox_status(&c).unwrap();assert_eq!(status.pending_count,1);assert_eq!(status.last_delivered_at,None);assert_eq!(status.unknown_delivery_count,1);
  let error:String=c.query_row("SELECT last_error FROM sync_outbox WHERE id=?1",[&row.id],|r|r.get(0)).unwrap();assert!(error.contains("Unknown"));
  assert!(adapter.pending_sync(&mut c,&pin,now).unwrap().is_none());adapter.settle_sync(&mut c,&pin,&row,"unknown",now).unwrap();
  let retry=adapter.pending_sync(&mut c,&pin,now+chrono::Duration::seconds(10)).unwrap().unwrap();assert_eq!(retry.id,row.id);assert_eq!(retry.payload,row.payload);assert_eq!(retry.attempts,1);
  adapter.settle_sync(&mut c,&pin,&retry,"delivered",now).unwrap();let revision:u64=c.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)).unwrap();
  adapter.settle_sync(&mut c,&pin,&retry,"delivered",now).unwrap();assert_eq!(c.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get::<_,u64>(0)).unwrap(),revision);
  let mut conflict=retry;conflict.payload="{}".into();assert_eq!(adapter.settle_sync(&mut c,&pin,&conflict,"delivered",now).unwrap_err(),"payload_conflict");
  assert_eq!(c.query_row("SELECT count(*) FROM sync_outbox",[],|r|r.get::<_,u64>(0)).unwrap(),1);assert_eq!(sync::outbox_status(&c).unwrap().pending_count,0);assert_eq!(sync::outbox_status(&c).unwrap().unknown_delivery_count,0);
 }
 #[test]
 fn quota_or_corrupt_receipt_refuses_admission_before_network_and_keeps_the_complete_write_set(){
  let(_root,mut c,mut adapter,pin,now)=ready();let count:u64=c.query_row("SELECT count(*) FROM pc_tx_ledger",[],|r|r.get(0)).unwrap();c.execute("UPDATE pc_tx_limits SET max_operations=?1",[count]).unwrap();
  let before=crate::local_runtime::transaction_tests::dump(&c);assert_eq!(adapter.pending_sync(&mut c,&pin,now).unwrap_err(),"safety_quota_exhausted");assert_eq!(crate::local_runtime::transaction_tests::dump(&c),before);
  c.execute("UPDATE pc_tx_limits SET max_operations=10000",[]).unwrap();let row=adapter.pending_sync(&mut c,&pin,now).unwrap().unwrap();
  c.execute("UPDATE pc_tx_receipts SET checksum=?2 WHERE operation_key=?1",params![format!("outbox-admit:{}:{}",row.id,row.attempts),"0".repeat(64)]).unwrap();
  assert_eq!(adapter.pending_sync(&mut c,&pin,now+chrono::Duration::seconds(10)).unwrap_err(),"receipt_corrupt");
  assert_eq!(sync::outbox_status(&c).unwrap().pending_count,1);
 }
}
