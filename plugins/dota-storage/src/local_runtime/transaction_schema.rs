//! Explicit additive safety migration. NOT called by schema::migrate or startup.
use std::{path::{Path,PathBuf},fs::{File,OpenOptions}};
use rusqlite::{Connection,TransactionBehavior,OpenFlags};
use sha2::{Digest,Sha256};
use super::{host_execution::{self as execution,Result,sql,signature,integrity,reference},schema};

pub fn claim(conn:&Connection)->Result<(PathBuf,File)> {
    let path=std::fs::canonicalize(conn.path().ok_or("coordinator_requires_file")?).map_err(|_|"coordinator_requires_file")?;
    let lock_path=path.with_extension("sqlite3.transaction-coordinator.lock");
    let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path).map_err(|_|"coordinator_lock_failed")?;
    lock.try_lock().map_err(|_|"second_coordinator_denied")?;Ok((path,lock))
}
pub fn version(conn:&Connection)->Result<()> {
    let legacy:i64=sql(conn.query_row("PRAGMA user_version",[],|r|r.get(0)))?;
    let safety:i64=sql(conn.query_row("SELECT version FROM pc_tx_meta WHERE id=1",[],|r|r.get(0)))?;
    if legacy!=schema::version()||safety!=1{return Err("schema_incompatible".into());}
    let valid:i64=sql(conn.query_row("SELECT count(*) FROM pc_tx_limits WHERE id=1 AND typeof(max_operations)='integer' AND max_operations>0 AND max_operations<=1000000 AND typeof(max_tickets)='integer' AND max_tickets>0 AND max_tickets<=1000000 AND typeof(max_revisions)='integer' AND max_revisions>0 AND max_revisions<=1000000 AND typeof(max_receipt_bytes)='integer' AND max_receipt_bytes>0 AND max_receipt_bytes<=1073741824 AND typeof(max_ticket_bytes)='integer' AND max_ticket_bytes>0 AND max_ticket_bytes<=1073741824",[],|r|r.get(0)))?;
    if valid!=1{return Err("safety_policy_invalid".into());}
    let usage:i64=sql(conn.query_row("SELECT count(*) FROM pc_tx_usage WHERE kind IN ('pc_tx_ledger','pc_tx_receipts','pc_tx_ticket','pc_tx_revision') AND typeof(entries)='integer' AND entries>=0 AND typeof(bytes)='integer' AND bytes>=0",[],|r|r.get(0)))?;
    if usage!=4{return Err("quota_accounting_corrupt".into());}Ok(())
}
fn legacy(conn:&Connection)->Result<()> {
    integrity(conn)?;let expected=reference()?;
    let current:i64=sql(conn.query_row("PRAGMA user_version",[],|r|r.get(0)))?;
    if current!=schema::version()||signature(conn,true)?!=signature(&expected,true)?{return Err("schema_incompatible".into());}Ok(())
}
pub fn validate(conn:&Connection)->Result<()> {
    legacy(conn)?;version(conn)?;let expected=reference()?;execution::reserved(&expected)?;
    if signature(conn,false)?!=signature(&expected,false)?{return Err("schema_incompatible".into());}
    super::transaction_authorization::load(conn)?;
    for (table,column) in [("pc_tx_ledger","identity"),("pc_tx_receipts","receipt"),("pc_tx_ticket","doc"),("pc_tx_revision","id")] {
        let actual:(i64,i64)=sql(conn.query_row(&format!("SELECT count(*),coalesce(sum(length(CAST({column} AS BLOB))),0) FROM {table}"),[],|r|Ok((r.get(0)?,r.get(1)?))))?;
        let usage:(i64,i64)=sql(conn.query_row("SELECT entries,bytes FROM pc_tx_usage WHERE kind=?1",[table],|r|Ok((r.get(0)?,r.get(1)?))))?;
        if actual!=usage{return Err("quota_accounting_corrupt".into());}
    }Ok(())
}
// A backup/rollback identity, NEVER used as a match revision or execution precondition.
fn data_identity(conn:&Connection)->Result<String> {
    let mut hash=Sha256::new();let mut tables=sql(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'pc_tx_%' ORDER BY name"))?;
    let names:Vec<String>=sql(sql(tables.query_map([],|r|r.get(0)))?.collect())?;
    for name in names {
        hash.update((name.len() as u64).to_le_bytes());hash.update(name.as_bytes());
        let mut statement=sql(conn.prepare(&format!("SELECT rowid,* FROM {name} ORDER BY rowid")))?;let columns=statement.column_count();let mut rows=sql(statement.query([]))?;
        while let Some(row)=sql(rows.next())? {for i in 0..columns {use rusqlite::types::ValueRef;
            let bytes=match sql(row.get_ref(i))? {ValueRef::Null=>vec![0],ValueRef::Integer(n)=>[vec![1],n.to_le_bytes().to_vec()].concat(),ValueRef::Real(n)=>[vec![2],n.to_bits().to_le_bytes().to_vec()].concat(),ValueRef::Text(s)=>[vec![3],s.to_vec()].concat(),ValueRef::Blob(s)=>[vec![4],s.to_vec()].concat()};
            hash.update((bytes.len() as u64).to_le_bytes());hash.update(bytes);
        }}
    }Ok(format!("{:x}",hash.finalize()))
}
fn backup(path:&Path)->Result<Connection> {
    if path.symlink_metadata().map_err(|_|"backup_unavailable")?.file_type().is_symlink(){return Err("backup_invalid".into());}
    let conn=sql(Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY))?;legacy(&conn)?;
    let reserved:i64=sql(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc_tx_%'",[],|r|r.get(0)))?;
    if reserved!=0{return Err("backup_not_legacy".into());}Ok(conn)
}
pub fn migrate(conn:&mut Connection,backup_path:&Path)->Result<()> {
    let (_path,_lock)=claim(conn)?;legacy(conn)?;
    let present:i64=sql(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc_tx_%'",[],|r|r.get(0)))?;
    if present!=0{return validate(conn);}
    if backup_path.exists(){return Err("backup_already_exists".into());}
    // SQLite copies a consistent committed snapshot, including committed WAL pages.
    sql(conn.execute("VACUUM main INTO ?1",[backup_path.to_str().ok_or("backup_path_invalid")?]))?;
    let copy=backup(backup_path)?;let baseline=data_identity(&copy)?;
    let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;legacy(&tx)?;
    if data_identity(&tx)?!=baseline{return Err("source_changed_after_backup".into());}
    execution::reserved(&tx)?;sql(tx.execute("UPDATE pc_tx_meta SET baseline=?1 WHERE id=1",[baseline]))?;
    validate(&tx)?;sql(tx.commit())
}
pub fn restore_before_writes(conn:&mut Connection,backup_path:&Path)->Result<()> {
    let (_path,_lock)=claim(conn)?;let copy=backup(backup_path)?;
    let tx=sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;validate(&tx)?;
    let (baseline,writes):(String,i64)=sql(tx.query_row("SELECT baseline,new_writes FROM pc_tx_meta WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let epoch:i64=sql(tx.query_row("SELECT value FROM pc_tx_epoch WHERE id=1",[],|r|r.get(0)))?;
    if writes!=0||epoch!=0||data_identity(&copy)?!=baseline||data_identity(&tx)?!=baseline{return Err("unsafe_backup_restore_denied".into());}
    // Already identical to the validated backup: no file replacement, WAL race or safety-table drop.
    // The retained ownership epoch advances; runtime rollback also retains every receipt/key.
    super::transaction_authorization::rollback_builtin_in(&tx)?;sql(tx.commit())
}
pub fn activation_preflight(conn:&Connection,backup_path:&Path)->Result<()> {
    validate(conn)?;
    let copy=backup(backup_path)?;
    let baseline:String=sql(conn.query_row("SELECT baseline FROM pc_tx_meta WHERE id=1",[],|r|r.get(0)))?;
    if data_identity(&copy)?!=baseline{return Err("backup_identity_mismatch".into());}Ok(())
}
pub fn namespace_prepared(c:&Connection)->Result<bool> {
 let count:i64=sql(c.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'pc_tx_%'",[],|r|r.get(0)))?;
 if count!=0{version(c)?;return Ok(true);}
 let base:i64=sql(c.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('local_sessions','local_matches','sync_meta','sync_outbox')",[],|r|r.get(0)))?;
 let v:i64=sql(c.query_row("PRAGMA user_version",[],|r|r.get(0)))?;
 if base!=4||v!=schema::version(){return Err("schema_incompatible".into());}Ok(false)
}
#[cfg(test)] mod tests;
