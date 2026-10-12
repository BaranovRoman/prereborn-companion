//! Future live handover contract. Not connected to the application runtime.
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Owner { BuiltIn, External }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lease { pub owner: Owner, pub epoch: u64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase { Active(Lease), Draining { old: Lease, target: Owner }, Vacant { epoch: u64 } }
pub struct Ownership { phase: Phase }
impl Default for Ownership { fn default()->Self { Self {phase:Phase::Active(Lease {owner:Owner::BuiltIn,epoch:1})} } }
impl Ownership {
    pub fn phase(&self)->Phase {self.phase}
    pub fn authorize(&self, lease:Lease)->Result<(), &'static str> {
        if self.phase==Phase::Active(lease) {Ok(())} else {Err("stale_or_inactive_owner")}
    }
    pub fn begin(&mut self, lease:Lease, target:Owner)->Result<(), &'static str> {
        self.authorize(lease)?;
        if target==lease.owner {return Err("same_owner");}
        if lease.epoch==u64::MAX {return Err("epoch_exhausted");}
        self.phase=Phase::Draining {old:lease,target}; Ok(())
    }
    // Caller must prove ingestion paused, in-flight effects drained and process reaped.
    // A timeout/crash alone MUST NOT be treated as proof; stay draining until fenced.
    pub fn confirm_fenced(&mut self, lease:Lease)->Result<Lease, &'static str> {
        let Phase::Draining {old,target}=self.phase else {return Err("not_draining")};
        if old!=lease {return Err("stale_fence_ack");}
        let next=Lease {owner:target,epoch:old.epoch.checked_add(1).ok_or("epoch_exhausted")?};
        self.phase=Phase::Active(next); Ok(next)
    }
    // After a confirmed crash fence, require an explicit recovery owner with a fresh epoch.
    pub fn crash_fenced(&mut self, lease:Lease)->Result<(), &'static str> {
        self.authorize(lease)?; self.phase=Phase::Vacant {epoch:lease.epoch}; Ok(())
    }
    pub fn recover(&mut self, owner:Owner)->Result<Lease, &'static str> {
        let Phase::Vacant {epoch}=self.phase else {return Err("not_vacant")};
        let lease=Lease {owner,epoch:epoch.checked_add(1).ok_or("epoch_exhausted")?}; self.phase=Phase::Active(lease); Ok(lease)
    }
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn exclusive_handover_stale_ack_and_rollback() {
  let mut s=Ownership::default(); let Phase::Active(old)=s.phase() else {panic!()};
  s.begin(old,Owner::External).unwrap(); assert!(s.authorize(old).is_err());
  assert!(s.confirm_fenced(Lease {epoch:0,..old}).is_err());
  let external=s.confirm_fenced(old).unwrap(); assert_eq!(external.epoch,2); assert!(s.authorize(old).is_err());
  s.begin(external,Owner::BuiltIn).unwrap(); let restored=s.confirm_fenced(external).unwrap(); assert_eq!(restored.epoch,3);
  assert!(s.authorize(external).is_err()); assert!(s.recover(Owner::External).is_err());
 }
 #[test] fn crash_reconnect_never_reuses_epoch() {
  let mut s=Ownership::default(); let Phase::Active(old)=s.phase() else {panic!()};
  s.crash_fenced(old).unwrap(); assert!(s.authorize(old).is_err());
  let new=s.recover(Owner::BuiltIn).unwrap(); assert!(new.epoch>old.epoch); assert!(s.authorize(old).is_err());
 }
}
