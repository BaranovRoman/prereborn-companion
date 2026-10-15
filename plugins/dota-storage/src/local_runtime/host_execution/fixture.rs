//! Test-only owning adapter; all execution delegates to the production implementation.
use super::*;
pub(super) struct FixtureAdapter {pub conn:Connection,pub adapter:Adapter,_fixture:Fixture}
impl Adapter {
    pub(super) fn install(fixture:Fixture)->Result<FixtureAdapter>{FixtureAdapter::install(fixture)}
}
impl FixtureAdapter {
    fn install(fixture:Fixture)->Result<Self> {
        let mut conn=fixture.connect()?;super::super::transaction_schema::migrate(&mut conn,&fixture.root.path().join("verified-backup.sqlite3"))?;
        let adapter=Adapter::attach(&mut conn)?;Ok(Self{conn,adapter,_fixture:fixture})
    }
    pub(super) fn prepare(&mut self,session:&str,snapshot:ReplayGsi,mode:RankedMode,now:DateTime<Utc>,sequence:u64)->Result<Prepared>{self.adapter.prepare(&mut self.conn,session,snapshot,mode,now,sequence)}
    pub(super) fn execute(&mut self,req:&Request)->Result<Response>{self.adapter.execute(&mut self.conn,req)}
    pub(super) fn execute_fault(&mut self,req:&Request,fault:Fault)->Result<Response>{self.adapter.execute_fault(&mut self.conn,req,fault)}
    pub(super) fn execute_guarded(&mut self,req:&Request,fault:Fault,guard:&dyn Fn(&Connection)->Result<()>)->Result<Response>{self.adapter.execute_guarded(&mut self.conn,req,fault,guard)}
    pub(super) fn recover(&mut self,req:&Request)->Result<Response>{self.adapter.recover(&mut self.conn,req)}
    pub(super) fn recover_guarded(&mut self,req:&Request,guard:&dyn Fn(&Connection)->Result<()>)->Result<Response>{self.adapter.recover_guarded(&mut self.conn,req,guard)}
    pub(super) fn retain_unknown(&mut self,req:&Request)->Result<()>{self.adapter.retain_unknown(&mut self.conn,req)}
}
