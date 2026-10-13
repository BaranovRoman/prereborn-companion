//! Same-DB durable ownership. No bootstrap/GSI switching and no package activation.
use rusqlite::{Connection,TransactionBehavior,params};
use serde::{Serialize,Deserialize};
use companion_dota_domain::{ownership::{Ownership,Phase,Lease,Owner},match_execution::{PackageBinding,Request}};
use super::host_execution::{Result,sql,encode,hash,Ticket};
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {pub(super) phase:Phase,pub(super) session:Option<String>,pub(super) package:Option<PackageBinding>}
pub(super) fn install(c:&Connection)->Result<()> {
    sql(c.execute_batch("CREATE TABLE pc_tx_owner(id INTEGER PRIMARY KEY CHECK(id=1),doc TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64));"))?;
    save(c,&Record{phase:Ownership::default().phase(),session:None,package:None})
}
pub(super) fn load(c:&Connection)->Result<Record> {
    let (doc,checksum):(Option<String>,String)=sql(c.query_row("SELECT CASE WHEN length(CAST(doc AS BLOB))<=2048 THEN doc ELSE NULL END,checksum FROM pc_tx_owner WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let doc=doc.ok_or("ownership_corrupt")?;if hash(&doc)!=checksum{return Err("ownership_corrupt".into());}
    let record:Record=serde_json::from_str(&doc).map_err(|_|"ownership_corrupt")?;Ownership::restore(record.phase).map_err(str::to_string)?;
    if record.session.as_ref().is_some_and(|s|s.is_empty()||s.len()>128)||record.package.as_ref().is_some_and(|p|p.id!="dota2"||p.version.is_empty()||p.version.len()>240||[&p.executable_hash,&p.manifest_hash].iter().any(|h|h.len()!=64||!h.bytes().all(|b|b.is_ascii_hexdigit()))){return Err("ownership_corrupt".into());}Ok(record)
}
fn save(c:&Connection,r:&Record)->Result<()> {
    Ownership::restore(r.phase).map_err(str::to_string)?;let doc=encode(r)?;if doc.len()>2048{return Err("ownership_too_large".into());}
    sql(c.execute("INSERT INTO pc_tx_owner VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc,checksum=excluded.checksum",params![doc,hash(&doc)]))?;Ok(())
}
fn change<T>(c:&mut Connection,f:impl FnOnce(&Connection,&mut Record,&mut Ownership)->Result<T>)->Result<T> {
    let tx=sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;let mut record=load(&tx)?;let mut ownership=Ownership::restore(record.phase).map_err(str::to_string)?;
    let result=f(&tx,&mut record,&mut ownership)?;record.phase=ownership.phase();save(&tx,&record)?;sql(tx.commit())?;Ok(result)
}
pub(super) fn uncertain_restart(c:&mut Connection)->Result<()> {change(c,|_,_,o|{o.uncertain_restart();Ok(())})}
pub(crate) fn phase(c:&Connection)->Result<Phase>{Ok(load(c)?.phase)}
pub(crate) fn begin(c:&mut Connection,lease:Lease,target:Owner,session:&str,package:Option<PackageBinding>)->Result<()> {
    if session.is_empty()||session.len()>128{return Err("session_mismatch".into());}
    if target==Owner::External&&package.is_none(){return Err("package_binding_required".into());}
    change(c,|_tx,r,o|{o.begin(lease,target).map_err(str::to_string)?;r.session=Some(session.into());r.package=package;Ok(())})
}
pub(crate) fn confirm_fenced(c:&mut Connection,old:Lease)->Result<Lease> {change(c,|_,_,o|o.confirm_fenced(old).map_err(str::to_string))}
pub(crate) fn crash_fenced(c:&mut Connection,old:Lease)->Result<()> {change(c,|_,_,o|o.crash_fenced(old).map_err(str::to_string))}
pub(crate) fn recover(c:&mut Connection,owner:Owner)->Result<Lease> {change(c,|_,r,o|{if owner==Owner::External&&r.package.is_none(){return Err("package_binding_required".into());}let lease=o.recover(owner).map_err(str::to_string)?;if owner==Owner::BuiltIn{r.package=None;}Ok(lease)})}
pub(crate) fn bind_builtin_session(c:&mut Connection,lease:Lease,session:&str)->Result<()> {change(c,|tx,r,o|{o.authorize(lease).map_err(str::to_string)?;if lease.owner!=Owner::BuiltIn||super::store::find_session(tx,session).map_err(|_|"storage_unavailable")?.is_none(){return Err("session_mismatch".into());}r.session=Some(session.into());r.package=None;Ok(())})}
pub(super) fn rollback_builtin_in(c:&Connection)->Result<Lease> {
    let mut r=load(c)?;let mut o=Ownership::restore(r.phase).map_err(str::to_string)?;
    match r.phase {Phase::Active(l) if l.owner==Owner::External=>o.begin(l,Owner::BuiltIn).map_err(str::to_string)?,Phase::Active(_)=>o.uncertain_restart(),Phase::Draining{target:Owner::BuiltIn,..}=>(),_=>return Err("rollback_requires_builtin_fence".into())}
    let Phase::Draining{old,..}=o.phase()else{return Err("rollback_requires_fence".into());};let next=o.confirm_fenced(old).map_err(str::to_string)?;
    r.phase=o.phase();r.package=None;save(c,&r)?;Ok(next)
}
pub(super) fn authorize(c:&Connection,lease:Lease,session:&str,package:Option<&PackageBinding>,request:&Request)->Result<()> {
    let record=load(c)?;Ownership::restore(record.phase).map_err(str::to_string)?.authorize(lease).map_err(|_|"ownership_fenced")?;
    if record.session.as_deref()!=Some(session)||record.package.as_ref()!=package{return Err("execution_scope_mismatch".into());}
    let (doc,checksum):(Option<String>,String)=sql(c.query_row("SELECT CASE WHEN length(CAST(doc AS BLOB))<=16384 THEN doc ELSE NULL END,checksum FROM pc_tx_ticket WHERE id=?1",[&request.ticket],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let doc=doc.ok_or("context_corrupt")?;if hash(&doc)!=checksum||request.binding!=checksum{return Err("context_corrupt".into());}
    let ticket:Ticket=serde_json::from_str(&doc).map_err(|_|"context_corrupt")?;
    if ticket.context.session.local_id!=session{return Err("session_mismatch".into());}Ok(())
}
