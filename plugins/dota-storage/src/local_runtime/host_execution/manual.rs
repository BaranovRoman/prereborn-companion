//! Explicit user edits on the existing transaction coordinator and real store.
//! No SQL/path/network input and no second writer. Revisions are persisted SQL
//! revisions, not fingerprints of the projected UI state.
use super::*;
use super::super::{transaction_authorization as auth,model::LocalSession};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum Edit {
    Rating{rating:i64},
    MatchDelta{local_id:String,delta:Option<i64>},
    MatchMode{local_id:String,ranked:Option<bool>},
    ContinueSession,
    EndSession,
    RecoverInterrupted,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct EditRequest {pub operation_key:String,pub expected_revision:u64,pub session:Option<String>,pub edit:Edit}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct EditReceipt {pub operation_key:String,pub before_revision:u64,pub revision:u64,pub resolved_session:Option<String>,pub session:Option<LocalSession>,pub matched:Option<LocalMatch>,pub stream_ended:bool}
impl EditRequest {
    fn validate(&self)->Result<()> {
        uuid::Uuid::parse_str(self.operation_key.strip_prefix("manual:").ok_or("invalid_operation_key")?).map_err(|_|"invalid_operation_key")?;
        if self.expected_revision>i64::MAX as u64||self.session.as_ref().is_some_and(|s|uuid::Uuid::parse_str(s).is_err()){return Err("invalid_edit_context".into());}
        match &self.edit {
            Edit::Rating{rating} if !(0..=30000).contains(rating)=>return Err("rating_out_of_range".into()),
            Edit::MatchDelta{local_id,delta}=>{uuid::Uuid::parse_str(local_id).map_err(|_|"invalid_match_identity")?;if delta.is_some_and(|v|!(-1000..=1000).contains(&v)){return Err("rating_delta_out_of_range".into());}},
            Edit::MatchMode{local_id,..}=>{uuid::Uuid::parse_str(local_id).map_err(|_|"invalid_match_identity")?;},
            _=>(),
        }Ok(())
    }
}
impl Adapter {
    pub fn manual_edit(&mut self,c:&mut Connection,pin:&impl ExecutionGrant,request:&EditRequest,now:DateTime<Utc>)->Result<EditReceipt>{
        if !pin.permits(MATCH_EXECUTION_CAPABILITY){return Err("capability_denied".into());}
        self.manual_guarded(c,pin.lease(),pin.session(),Some(pin.binding()),request,now)
    }
    fn manual_guarded(&mut self,c:&mut Connection,lease:companion_dota_domain::ownership::Lease,session:Option<&str>,package:Option<&PackageBinding>,request:&EditRequest,now:DateTime<Utc>)->Result<EditReceipt>{
        request.validate()?;self.bound(c)?;
        let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;Self::verify(&tx,&self.expected_schema)?;
        if let Some(session)=session{auth::authorize_scope(&tx,lease,session,package)?;}else{auth::authorize_unbound(&tx,lease,package)?;}
        let identity=hash(&encode(&("manual-edit-v1",package,request))?);
        let row:Option<(String,String,Option<String>,Option<String>)>=sql(tx.query_row("SELECT identity,status,CASE WHEN length(CAST(receipt AS BLOB))<=32768 THEN receipt ELSE NULL END,checksum FROM pc_tx_ledger LEFT JOIN pc_tx_receipts USING(operation_key) WHERE operation_key=?1",[&request.operation_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
        if let Some((stored,status,receipt,checksum))=row{
            if stored!=identity{return Err("payload_conflict".into());}
            if status=="unknown"{return Err("manual_result_unknown".into());}
            let (doc,checksum)=(receipt.ok_or("receipt_corrupt")?,checksum.ok_or("receipt_corrupt")?);
            if status!="completed"||hash(&doc)!=checksum{return Err("receipt_corrupt".into());}
            let receipt:EditReceipt=serde_json::from_str(&doc).map_err(|_|"receipt_corrupt")?;
            if receipt.operation_key!=request.operation_key{return Err("receipt_corrupt".into());}
            return Ok(receipt);
        }
        if request.session.as_deref()!=session{return Err("session_mismatch".into());}
        let before:u64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
        if before!=request.expected_revision{return Err("stale_revision".into());}
        if super::live_effects::quota(&tx)?.unknown!=0{return Err("unknown_effects_require_explicit_reconciliation".into());}
        let facade=Facade::new(&tx);let mut affected_session=None;let mut matched=None;let mut stream_ended=false;
        match &request.edit {
            Edit::Rating{rating}=>affected_session=sql(facade.rating(*rating))?.map(|s|s.local_id),
            Edit::MatchDelta{local_id,delta}=>{matched=Some(sql(facade.correct_delta(local_id,*delta))?.ok_or("match_missing")?);},
            Edit::MatchMode{local_id,ranked}=>{matched=Some(sql(facade.correct_mode(local_id,ranked.map(|r|if r{RankedMode::Ranked}else{RankedMode::Unranked})))?.ok_or("match_missing")?);},
            Edit::ContinueSession=>{let open=sql(store::find_open_session(&tx))?.ok_or("session_missing")?;sql(store::acknowledge_stale(&tx,&open.local_id))?;affected_session=Some(open.local_id);},
            Edit::EndSession=>{let open=sql(store::find_open_session(&tx))?.ok_or("session_missing")?;sql(facade.end_session(&open.local_id,now))?;affected_session=Some(open.local_id);stream_ended=true;},
            Edit::RecoverInterrupted=>{
                let active=sql(store::find_active_match_anywhere(&tx))?.ok_or("match_missing")?;
                if !active.last_seen_at.as_deref().and_then(companion_dota_domain::session_lifecycle::parse_rfc3339).is_some_and(|seen|rules::is_match_stale(seen,now)){return Err("active_match_not_stale".into());}
                sql(facade.interrupted(&active.local_id,now))?;matched=sql(facade.lookup_match(&active.local_id))?;
            },
        }
        let resolved=if let Some(active)=sql(store::find_active_match_anywhere(&tx))?{Some(active.session_local_id)}else{sql(store::find_open_session(&tx))?.map(|s|s.local_id).or_else(||session.map(str::to_string))};
        if let Some(resolved)=&resolved{if let Some(old)=session{auth::rebind_session_in(&tx,lease,old,package,resolved)?;}else{auth::bind_cold_session_in(&tx,lease,package,resolved)?;}}
        let affected_session=affected_session.or_else(||matched.as_ref().map(|m|m.session_local_id.clone())).or_else(||resolved.clone());
        let receipt=EditReceipt{operation_key:request.operation_key.clone(),before_revision:before,revision:sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?,resolved_session:resolved,session:affected_session.map(|id|sql(store::find_session(&tx,&id))).transpose()?.flatten(),matched,stream_ended};
        let doc=encode(&receipt)?;if doc.len()>32768{return Err("receipt_limit".into());}
        sql(tx.execute("INSERT INTO pc_tx_ledger VALUES(?1,?2,'completed')",params![request.operation_key,identity]))?;
        sql(tx.execute("INSERT INTO pc_tx_receipts VALUES(?1,?2,?3)",params![request.operation_key,doc,hash(&doc)]))?;
        sql(tx.commit())?;Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::{transaction_tests as parity,transaction_authorization as auth};
    use companion_dota_domain::ownership::{Lease,Owner};
    fn request(c:&Connection,session:&str,edit:Edit)->EditRequest{EditRequest{operation_key:format!("manual:{}",uuid::Uuid::new_v4()),expected_revision:c.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)).unwrap(),session:Some(session.into()),edit}}
    #[test]
    fn actual_user_edits_match_legacy_full_write_set_and_duplicate_does_not_enqueue_twice(){
        let(fixture,session,matched)=Fixture::seeded().unwrap();
        let old_path=fixture.root.path().join("legacy.sqlite3");std::fs::copy(&fixture.path,&old_path).unwrap();let mut old=Connection::open(old_path).unwrap();let seeded=parity::ids(&old);
        let mut h=Adapter::install(fixture).unwrap();let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();
        let now=DateTime::from_timestamp(1700000010,0).unwrap();
        for c in [&mut old,&mut h.conn]{store::finalize_match(c,&matched,&session,RankedMode::Ranked,crate::local_runtime::model::MatchResult::Win,"confirmed",now).unwrap();}
        for edit in [Edit::Rating{rating:1300},Edit::MatchDelta{local_id:matched.clone(),delta:Some(60)},Edit::MatchMode{local_id:matched.clone(),ranked:Some(false)},Edit::MatchMode{local_id:matched.clone(),ranked:None},Edit::MatchDelta{local_id:matched.clone(),delta:None},Edit::ContinueSession,Edit::EndSession]{
            match &edit{
                Edit::Rating{rating}=>{store::set_current_rating(&mut old,*rating).unwrap();},
                Edit::MatchDelta{local_id,delta}=>{store::correct_match_delta(&mut old,local_id,*delta).unwrap();},
                Edit::MatchMode{local_id,ranked}=>{store::correct_match_ranked_mode(&mut old,local_id,ranked.map(|r|if r{RankedMode::Ranked}else{RankedMode::Unranked})).unwrap();},
                Edit::ContinueSession=>store::acknowledge_stale(&old,&session).unwrap(),
                Edit::EndSession=>store::finalize_session_end(&mut old,&session,now).unwrap(),_=>unreachable!(),
            }
            let req=request(&h.conn,&session,edit);let receipt=h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap();
            assert_eq!(parity::normalized(&h.conn,&seeded),parity::normalized(&old,&seeded));
            let after=parity::dump(&h.conn);let saved=h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap();assert_eq!(encode(&saved).unwrap(),encode(&receipt).unwrap());assert_eq!(parity::dump(&h.conn),after);
        }
    }
    #[test]
    fn stale_conflicting_unknown_or_exhausted_edit_never_leaves_partial_rating_or_outbox(){
        let(fixture,session,_)=Fixture::seeded().unwrap();let mut h=Adapter::install(fixture).unwrap();
        let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();let now=DateTime::from_timestamp(1700000010,0).unwrap();
        let mut req=request(&h.conn,&session,Edit::Rating{rating:1200});let receipt=h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap();let before=parity::dump(&h.conn);
        req.edit=Edit::Rating{rating:1300};assert_eq!(h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap_err(),"payload_conflict");assert_eq!(parity::dump(&h.conn),before);
        let mut stale=request(&h.conn,&session,Edit::Rating{rating:1400});stale.expected_revision=receipt.before_revision;assert_eq!(h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&stale,now).unwrap_err(),"stale_revision");assert_eq!(parity::dump(&h.conn),before);
        let req=request(&h.conn,&session,Edit::Rating{rating:1500});h.conn.execute("UPDATE pc_tx_limits SET max_operations=1",[]).unwrap();
        assert_eq!(h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap_err(),"safety_quota_exhausted");assert_eq!(parity::dump(&h.conn),before);
        h.conn.execute("UPDATE pc_tx_limits SET max_operations=10000",[]).unwrap();
        h.conn.execute("INSERT INTO pc_tx_ledger VALUES('effect:unknown',?1,'unknown')",["a".repeat(64)]).unwrap();
        assert_eq!(h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap_err(),"unknown_effects_require_explicit_reconciliation");assert_eq!(parity::dump(&h.conn),before);
        let mut wrong=req.clone();wrong.session=None;assert_eq!(h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&wrong,now).unwrap_err(),"session_mismatch");
    }
    #[test]
    fn commit_without_reply_is_recovered_after_reopen_and_new_owner_epoch_without_new_writes(){
        let(fixture,session,_)=Fixture::seeded().unwrap();let retained=fixture.clone();let mut h=Adapter::install(fixture).unwrap();
        let lease=auth::confirm_fenced(&mut h.conn,Lease{owner:Owner::BuiltIn,epoch:1}).unwrap();auth::bind_builtin_session(&mut h.conn,lease,&session).unwrap();let now=DateTime::from_timestamp(1700000010,0).unwrap();
        let req=request(&h.conn,&session,Edit::Rating{rating:1200});let receipt=h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap();let before=parity::dump(&h.conn);drop(h);
        let mut h=Adapter::install(retained).unwrap();assert_eq!(h.adapter.manual_guarded(&mut h.conn,lease,Some(&session),None,&req,now).unwrap_err(),"ownership_fenced");
        let next=auth::confirm_fenced(&mut h.conn,lease).unwrap();auth::bind_builtin_session(&mut h.conn,next,&session).unwrap();
        let saved=h.adapter.manual_guarded(&mut h.conn,next,Some(&session),None,&req,now).unwrap();assert_eq!(encode(&saved).unwrap(),encode(&receipt).unwrap());assert_eq!(parity::dump(&h.conn),before);
    }
}
