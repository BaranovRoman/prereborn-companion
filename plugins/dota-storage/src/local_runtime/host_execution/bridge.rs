//! Fixture-only diagnostic driver; reuses Runtime, Ownership and the transaction adapter.
use super::*;
use companion_plugin_protocol::runtime::Runtime;
use companion_dota_domain::ownership::{Ownership,Phase,Owner,Lease};

#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticOwner {phase:Phase,session:String,run:String}
fn owner(c:&Connection)->Result<Option<DiagnosticOwner>> {
    let raw:Option<Option<String>>=sql(c.query_row("SELECT CASE WHEN length(CAST(doc AS BLOB))<=1024 THEN doc ELSE NULL END FROM pc_tx_diagnostic_owner WHERE id=1",[],|r|r.get(0)).optional())?;
    raw.map(|raw|serde_json::from_str(&raw.ok_or("owner_corrupt")?).map_err(|_|"owner_corrupt".into())).transpose()
}
fn save(c:&Connection,value:&DiagnosticOwner)->Result<()> {
    sql(c.execute("INSERT INTO pc_tx_diagnostic_owner VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc",[encode(value)?]))?;Ok(())
}
fn epoch(phase:Phase)->u64 {match phase {Phase::Active(l)=>l.epoch,Phase::Draining{old,..}=>old.epoch,Phase::Vacant{epoch}=>epoch}}
fn binary()->PathBuf {PathBuf::from(std::env::var_os("COMPANION_TEST_PLUGIN_DIR").unwrap_or_else(||std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/debug").into_os_string())).join(if cfg!(windows){"companion-dota-plugin.exe"}else{"companion-dota-plugin"})}

struct Host {
    runtime:Runtime,adapter:FixtureAdapter,scope:DiagnosticScope,expected:Option<Prepared>,confirmed:Option<Receipt>,owns_process:bool,blocked:bool,last_sequence:Option<u64>,
}
impl Host {
    fn open(fixture:Fixture,session:&str)->Result<Self> {
        let mut adapter=Adapter::install(fixture)?;
        let tx=sql(adapter.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut value=owner(&tx)?.unwrap_or(DiagnosticOwner{phase:Phase::Vacant{epoch:1},session:session.into(),run:String::new()});
        if value.session!=session{return Err("session_mismatch".into());}
        let mut ownership=Ownership::restore(value.phase).map_err(str::to_string)?;
        ownership.uncertain_restart();value.phase=ownership.phase();save(&tx,&value)?;sql(tx.commit())?;
        Ok(Self{runtime:Runtime::default(),scope:DiagnosticScope{session:session.into(),epoch:epoch(value.phase),run:value.run},adapter,expected:None,confirmed:None,owns_process:false,blocked:false,last_sequence:None})
    }
    fn start(&mut self)->Result<()> {
        if self.owns_process{return Err("already_running".into());}
        let tx=sql(self.adapter.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut value=owner(&tx)?.ok_or("owner_missing")?;
        let mut ownership=Ownership::restore(value.phase).map_err(str::to_string)?;
        let lease=ownership.recover(Owner::External).map_err(str::to_string)?;
        value.phase=ownership.phase();value.run=uuid::Uuid::new_v4().to_string();save(&tx,&value)?;sql(tx.commit())?;
        self.scope=DiagnosticScope{session:value.session,epoch:lease.epoch,run:value.run};self.expected=None;self.confirmed=None;self.blocked=false;self.last_sequence=None;
        match self.runtime.start_expected(&binary(),&[],"dota2",Some("0.1.0")) {
            Ok(_)=>{self.owns_process=true;Ok(())},
            Err(error)=>{self.draining()?;Err(error)},
        }
    }
    fn draining(&mut self)->Result<()> {
        let tx=sql(self.adapter.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut value=owner(&tx)?.ok_or("owner_missing")?;
        if value.run!=self.scope.run || epoch(value.phase)!=self.scope.epoch{return Err("stale_host".into());}
        let mut ownership=Ownership::restore(value.phase).map_err(str::to_string)?;ownership.uncertain_restart();value.phase=ownership.phase();save(&tx,&value)?;sql(tx.commit())?;
        self.expected=None;self.confirmed=None;Ok(())
    }
    // Only the trusted fixture harness may confirm an orphan was reaped after host crash.
    // A plugin reply, timeout or freshly-created Runtime is never accepted as fence proof.
    fn confirm_reaped(&mut self)->Result<()> {
        let tx=sql(self.adapter.conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut value=owner(&tx)?.ok_or("owner_missing")?;
        if value.run!=self.scope.run || epoch(value.phase)!=self.scope.epoch{return Err("stale_fence_confirmation".into());}
        let mut ownership=Ownership::restore(value.phase).map_err(str::to_string)?;
        match value.phase {
            Phase::Draining{old,..}=>{let lease=ownership.confirm_fenced(old).map_err(str::to_string)?;ownership.crash_fenced(lease).map_err(str::to_string)?;},
            Phase::Active(lease)=>ownership.crash_fenced(lease).map_err(str::to_string)?,
            Phase::Vacant{..}=>(),
        }
        value.phase=ownership.phase();save(&tx,&value)?;sql(tx.commit())?;self.owns_process=false;self.expected=None;self.confirmed=None;Ok(())
    }
    fn restart(&mut self)->Result<()> {
        if !self.owns_process{return Err("fence_confirmation_required".into());}
        let _=self.runtime.stop();self.runtime.stop()?; // stop/fail reaps owned child before confirming.
        self.confirm_reaped()?;self.start()
    }
    fn frame(&mut self,snapshot:ReplayGsi,at:DateTime<Utc>,sequence:u64,key:&str)->Result<DiagnosticFrame> {
        if self.blocked{return Err("diagnostic_reset_required".into());}
        if self.expected.is_some(){return Err("pending_frame_requires_reset".into());}
        if self.last_sequence.is_some_and(|last|sequence<=last){return Err("stale_frame".into());}
        let prepared=self.adapter.prepare(&self.scope.session,snapshot,RankedMode::Ranked,at,sequence)?;
        if let Some(receipt)=&self.confirmed {
            let session=receipt.session.as_ref().ok_or("missing_receipt_context")?;
            if receipt.after.as_ref()!=Some(&prepared.data.preconditions) || receipt.current_context!=prepared.data.context.active
                || session.ended_at.is_some()!=prepared.data.context.session.ended {return Err("stale_receipt_context".into());}
        }
        let frame=DiagnosticFrame{scope:self.scope.clone(),ticket:prepared.ticket.clone(),binding:prepared.binding.clone(),preconditions:prepared.data.preconditions.clone(),operation_key:key.into(),correlation_id:format!("frame:{sequence}"),context:prepared.data.context.clone(),snapshot:prepared.data.snapshot.clone(),core_context:None};
        self.expected=Some(prepared);Ok(frame)
    }
    fn roundtrip(&mut self,name:&str,args:serde_json::Value,fault:Fault)->Result<serde_json::Value> {
        let adapter=&mut self.adapter;let expected=self.expected.clone();let scope=self.scope.clone();let mut sent:Option<DiagnosticReply>=None;
        let result=self.runtime.command_diagnostic(name.into(),args,&[DIAGNOSTIC_CAPABILITY],|raw| {
            let request:DiagnosticRequest=serde_json::from_value(raw).map_err(|_|"invalid_diagnostic_request")?;
            let correct_kind=matches!((&request,name),(DiagnosticRequest::Execute{..},"dota.diagnostic_frame")|(DiagnosticRequest::Recover{..},"dota.diagnostic_recover"));
            let response=if correct_kind {dispatch(adapter,&scope,expected.as_ref(),&request,fault)}else{Err("unauthorized_request_kind".into())};
            let reply=match response {Ok(response)=>DiagnosticReply::Result{response},Err(code)=>DiagnosticReply::Denied{code}};
            let encoded=serde_json::to_value(&reply).map_err(|_|"invalid_diagnostic_reply")?;sent=Some(reply);Ok(encoded)
        });
        match result {
            Ok(value)=>{
                let received:DiagnosticReply=match serde_json::from_value(value["reply"].clone()) {Ok(reply)=>reply,Err(_)=>{self.draining()?;return Err("invalid_receipt_ack".into());}};
                let Some(sent)=sent else{self.draining()?;return Err("missing_reverse_request".into());};
                if encode(&received)?!=encode(&sent)? {self.draining()?;return Err("receipt_ack_mismatch".into());}
                let next=match received {DiagnosticReply::Result{response} if response.status==Status::Completed=>response.receipt,_=>None};
                let older=self.confirmed.as_ref().zip(next.as_ref()).is_some_and(|(old,new)|old.after.as_ref().zip(new.after.as_ref()).is_some_and(|(old,new)|new.epoch<old.epoch));
                if !older {self.confirmed=next;}self.blocked=self.confirmed.is_none();
                if name=="dota.diagnostic_frame" {if !self.blocked {self.last_sequence=expected.as_ref().map(|p|p.data.context.frame_sequence);}self.expected=None;}
                Ok(value)
            },
            Err(error)=>{self.draining()?;Err(error)},
        }
    }
}
fn dispatch(adapter:&mut FixtureAdapter,scope:&DiagnosticScope,expected:Option<&Prepared>,request:&DiagnosticRequest,fault:Fault)->Result<Response> {
    if !request.bounded(){return Err("invalid_diagnostic_request".into());}
    let (incoming,operation)=match request {DiagnosticRequest::Execute{scope,request,..}|DiagnosticRequest::Recover{scope,request}=>(scope,request)};
    let guard=|c:&Connection|->Result<()> {
        let current=owner(c)?.ok_or("owner_missing")?;
        let lease=Lease{owner:Owner::External,epoch:incoming.epoch};
        Ownership::restore(current.phase).map_err(str::to_string)?.authorize(lease).map_err(|_|"ownership_fenced")?;
        if incoming.session!=scope.session || incoming.session!=current.session{return Err("session_mismatch".into());}
        if incoming.run!=current.run || incoming!=scope{return Err("run_fenced".into());}
        let (raw,checksum):(Option<String>,String)=sql(c.query_row("SELECT CASE WHEN length(CAST(doc AS BLOB))<=16384 THEN doc ELSE NULL END,checksum FROM pc_tx_ticket WHERE id=?1",[&operation.ticket],|r|Ok((r.get(0)?,r.get(1)?))))?;
        let raw=raw.ok_or("context_corrupt")?;if hash(&raw)!=checksum || operation.binding!=checksum{return Err("context_corrupt".into());}
        let ticket:Ticket=serde_json::from_str(&raw).map_err(|_|"context_corrupt")?;
        if ticket.context.session.local_id!=incoming.session{return Err("session_mismatch".into());}
        if let DiagnosticRequest::Execute{sequence,snapshot_identity,..}=request {
            let expected=expected.ok_or("unsolicited_execution")?;
            if operation.ticket!=expected.ticket || *sequence!=ticket.context.frame_sequence || snapshot_identity!=&ticket.context.snapshot_identity
                || snapshot_identity!=&rules::snapshot_identity(&ticket.snapshot) {return Err("snapshot_mismatch".into());}
        }
        Ok(())
    };
    match request {
        DiagnosticRequest::Execute{..}=>adapter.execute_guarded(operation,fault,&guard),
        DiagnosticRequest::Recover{..}=>adapter.recover_guarded(operation,&guard),
    }
}

#[cfg(test)]
mod tests;
