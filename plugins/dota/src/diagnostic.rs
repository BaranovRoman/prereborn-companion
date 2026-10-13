//! Debug IPC only: compute a plan; the worker never opens a database or performs effects.
use companion_dota_domain::{match_execution::*,match_shadow,effects::Status};
use companion_plugin_protocol::{Message,read_frame,write_frame};
use std::io::{BufRead,Write};

#[derive(Default)]
pub struct State {confirmed:Option<(DiagnosticScope,Receipt)>,sequence:Option<u64>,blocked:bool}
impl State {
    pub fn frame(&mut self,input:DiagnosticFrame)->Result<DiagnosticRequest,String> {
        if self.blocked{return Err("diagnostic_reset_required".into());}
        if input.scope.session!=input.context.session.local_id{return Err("session_mismatch".into());}
        if self.sequence.is_some_and(|s|input.context.frame_sequence<=s){return Err("stale_frame".into());}
        if let Some((scope,receipt))=&self.confirmed {
            let session=receipt.session.as_ref().ok_or("missing_session_receipt")?;
            if scope!=&input.scope || receipt.after.as_ref()!=Some(&input.preconditions)
                || input.context.active!=receipt.current_context || input.context.session.local_id!=session.local_id
                || input.context.session.ended!=session.ended_at.is_some() || input.context.session.streamed!=session.streamed {
                return Err("receipt_context_mismatch".into());
            }
        }
        let analysis=match_shadow::analyze(&input.context,&input.snapshot,input.context.frame_sequence);
        if !analysis.conclusive{return Err("unbound_snapshot".into());}
        let request=Request{api:EXECUTION_API,operation_key:input.operation_key,correlation_id:input.correlation_id,
            ticket:input.ticket,binding:input.binding,preconditions:input.preconditions,plan:analysis.detector.ok_or("missing_plan")?};
        if !request.bounded(){return Err("invalid_request".into());}
        Ok(DiagnosticRequest::Execute{scope:input.scope,sequence:input.context.frame_sequence,snapshot_identity:input.context.snapshot_identity,request})
    }
    pub fn exchange(&mut self,id:u64,request:DiagnosticRequest,input:&mut impl BufRead,output:&mut impl Write)->Result<(),String> {
        if !request.bounded(){return Err("invalid_diagnostic_request".into());}
        let (scope,operation,sequence)=match &request {
            DiagnosticRequest::Execute{scope,request,sequence,..}=>(scope,request,Some(*sequence)),
            DiagnosticRequest::Recover{scope,request}=>(scope,request,None),
        };
        if !operation.bounded(){return Err("invalid_request".into());}
        write_frame(output,Message::DiagnosticExecute{id,request:serde_json::to_value(&request).map_err(|_|"invalid_request")?})?;
        let Some(Message::DiagnosticReceipt{id:reply_id,response})=read_frame(input)? else{return Err("expected_diagnostic_receipt".into());};
        if reply_id!=id{return Err("diagnostic_correlation_mismatch".into());}
        let reply:DiagnosticReply=serde_json::from_value(response).map_err(|_|"invalid_diagnostic_receipt")?;
        self.blocked=true;
        if let DiagnosticReply::Result{response}=&reply {
            if response.correlation_id!=operation.correlation_id{return Err("receipt_correlation_mismatch".into());}
            if response.status==Status::Completed {
                let receipt=response.receipt.as_ref().ok_or("missing_receipt")?;
                if receipt.status!=Status::Completed || receipt.operation_key!=operation.operation_key || receipt.before!=operation.preconditions
                    || receipt.after.is_none() || receipt.session.as_ref().is_none_or(|s|s.local_id!=scope.session)
                    || receipt.current_context.as_ref().is_some_and(|m|m.session_local_id!=scope.session) {
                    return Err("invalid_confirmed_receipt".into());
                }
                let older=self.confirmed.as_ref().is_some_and(|(prior_scope,prior)|prior_scope==scope
                    && prior.after.as_ref().zip(receipt.after.as_ref()).is_some_and(|(old,new)|new.epoch<old.epoch));
                let same_scope=self.confirmed.as_ref().is_some_and(|(prior,_)|prior==scope);
                if !older {self.confirmed=Some((scope.clone(),receipt.clone()));if sequence.is_some()||!same_scope {self.sequence=sequence;}}
                self.blocked=false;
            }
        }
        let context=self.confirmed.as_ref().filter(|_|!self.blocked).map(|(_,r)|(&r.current_context,&r.after));
        write_frame(output,Message::Reply{id,result:serde_json::json!({"reply":reply,"request":request,"confirmedContext":context,"sideEffects":false})})
    }
}
