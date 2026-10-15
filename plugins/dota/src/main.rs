//! Dota analysis/plan worker: stdio IPC; core owns storage/transports. Replay cannot request live execution.
use companion_plugin_protocol::{read_frame, write_frame, Message, CORE_API};
use companion_dota_domain::{contracts::{ReplayInput, DOTA_API, PLUGIN_ID, REPLAY_COMMAND}, replay::Replay};
use serde_json::json;
use std::io::{self, BufReader};
mod diagnostic;
mod live_effects;

fn run() -> Result<(), String> {
    let args:Vec<_>=std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg|arg=="--worker") {
        if args.len()!=2{return Err("invalid_runtime_mode".into());}
        return run_worker(companion_dota_plugin::worker::Launch::parse(&args[1])?);
    }
    let live=args==["--live"];
    if !live && args.iter().any(|arg|arg!="--replay") {return Err("invalid_runtime_mode".into());}
    let mut input = BufReader::new(io::stdin()); let mut output = io::stdout();
    if !matches!(read_frame(&mut input)?, Some(Message::Hello { core_api: CORE_API })) { return Err("expected_compatible_hello".into()); }
    write_frame(&mut output, Message::Ready { id: PLUGIN_ID.into(), version: env!("CARGO_PKG_VERSION").into(), min_core_api: CORE_API, max_core_api: CORE_API })?;
    write_frame(&mut output, Message::State { data: json!({"mode":if live{"external"}else{"replay_only"},"effectRequests":live,"dotaApi":DOTA_API,"sideEffects":false,"liveCapabilities":[]}) })?;
    let mut replay = Replay::default();
    let mut diagnostic=diagnostic::State::default();
    let mut effect_state=live_effects::State::default();
    while let Some(message) = read_frame(&mut input)? {
        match message {
            Message::Command{id,name,args} if live && matches!(name.as_str(),"dota.live_frame"|"dota.live_recover") => {
                let request=if name=="dota.live_frame" {
                    serde_json::from_value::<companion_dota_domain::match_execution::ExecutionFrame>(args).map_err(|_|"invalid_execution_frame".to_string()).and_then(|frame|diagnostic.live_frame(frame))
                } else {
                    serde_json::from_value::<companion_dota_domain::match_execution::ExecutionRequest>(args).map_err(|_|"invalid_recovery_request".to_string()).and_then(|req|if matches!(req,companion_dota_domain::match_execution::ExecutionRequest::Recover{..}){Ok(req)}else{Err("invalid_recovery_request".into())})
                };
                match request {
                    Ok(request)=>diagnostic.exchange_mode(id,request,&mut input,&mut output,true)?,
                    Err(code)=>write_frame(&mut output,Message::Error{id:Some(id),code,message:"Execution rejected".into()})?,
                }
            },
            Message::Command{id,name,args} if live && name=="dota.live_effects" => {
                let frame=serde_json::from_value::<companion_dota_domain::match_execution::LiveEffectsFrame>(args).map_err(|_|"invalid_effect_frame")?;
                effect_state.apply(id,frame,&mut input,&mut output)?;
            },
            #[cfg(debug_assertions)]
            Message::Command{id,name,args} if name=="dota.diagnostic_frame"||name=="dota.diagnostic_recover" => {
                let request=if name=="dota.diagnostic_frame" {
                    serde_json::from_value::<companion_dota_domain::match_execution::DiagnosticFrame>(args).map_err(|_|"invalid_diagnostic_frame".to_string()).and_then(|frame|diagnostic.frame(frame))
                } else {
                    serde_json::from_value::<companion_dota_domain::match_execution::DiagnosticRequest>(args).map_err(|_|"invalid_recovery_request".to_string()).and_then(|req|if matches!(req,companion_dota_domain::match_execution::DiagnosticRequest::Recover{..}){Ok(req)}else{Err("invalid_recovery_request".into())})
                };
                match request {
                    Ok(request)=>diagnostic.exchange(id,request,&mut input,&mut output)?,
                    Err(code)=>write_frame(&mut output,Message::Error{id:Some(id),code,message:"Diagnostic request rejected".into()})?,
                }
            },
            Message::Command { id, name, args } if name == REPLAY_COMMAND => {
                let result = serde_json::from_value::<ReplayInput>(args).map_err(|_| "invalid_replay_input".to_string()).and_then(|input| replay.apply(input));
                match result {
                    Ok(result) => {
                        let data = serde_json::to_value(result).map_err(|e| e.to_string())?;
                        write_frame(&mut output, Message::Event { name: "dota.replay_analysis".into(), data: data.clone() })?;
                        write_frame(&mut output, Message::State { data: data.clone() })?;
                        write_frame(&mut output, Message::Reply { id, result: data })?;
                    },
                    Err(error) => write_frame(&mut output, Message::Error { id: Some(id), code: error, message: "Replay rejected; no effects applied".into() })?,
                }
            },
            Message::Command { id, name, args } if name == "dota.watchdog_shadow" => {
                match serde_json::from_value::<companion_dota_domain::match_shadow::Context>(args) {
                    Ok(context) => {
                        let analysis=companion_dota_domain::match_shadow::analyze(&context,&Default::default(),context.frame_sequence);
                        write_frame(&mut output, Message::Reply{id,result:json!({"matchAnalysis":analysis})})?;
                    },
                    Err(_) => write_frame(&mut output, Message::Error{id:Some(id),code:"invalid_match_context".into(),message:"Shadow rejected; no effects applied".into()})?,
                }
            },
            Message::Command { id, name, args } if name == "dota.core_read" => {
                match serde_json::from_value::<companion_dota_domain::core_read::ReadRequest>(args) {
                    Ok(request) if request.validate() => {
                        write_frame(&mut output, Message::CoreRead {id,request:serde_json::to_value(request).map_err(|e|e.to_string())?})?;
                        let Some(Message::CoreReadReply {id:reply_id,response})=read_frame(&mut input)? else {return Err("expected_core_read_reply".into());};
                        if reply_id!=id {return Err("core_read_correlation_mismatch".into());}
                        let typed:companion_dota_domain::core_read::ReadResponse=serde_json::from_value(response).map_err(|_|"invalid_core_read_response")?;
                        write_frame(&mut output, Message::Reply {id,result:serde_json::to_value(typed).map_err(|e|e.to_string())?})?;
                    },
                    _=>write_frame(&mut output,Message::Error {id:Some(id),code:"invalid_read_request".into(),message:"Read request rejected".into()})?,
                }
            },
            Message::Command { id, name, .. } if name == "dota.reset" => {
                replay = Replay::default();
                diagnostic=diagnostic::State::default();
                effect_state=live_effects::State::default();
                write_frame(&mut output, Message::Reply { id, result: json!({"reset":true,"sideEffects":false}) })?;
            },
            Message::Command { id, .. } => write_frame(&mut output, Message::Error { id: Some(id), code: "unsupported_replay_command".into(), message: "Live APIs are not connected".into() })?,
            Message::Stop => { write_frame(&mut output, Message::Stopped)?; return Ok(()); },
            _ => return Err("unexpected_message".into()),
        }
    }
    Ok(())
}
fn run_worker(launch:companion_dota_plugin::worker::Launch)->Result<(),String>{
    let mut worker=companion_dota_plugin::worker::Worker::new(launch);
    let mut input=BufReader::new(io::stdin());let mut output=io::stdout();
    if !matches!(read_frame(&mut input)?,Some(Message::Hello{core_api:CORE_API})){return Err("expected_compatible_hello".into());}
    write_frame(&mut output,Message::Ready{id:PLUGIN_ID.into(),version:env!("CARGO_PKG_VERSION").into(),min_core_api:CORE_API,max_core_api:CORE_API})?;
    while let Some(message)=read_frame(&mut input)?{
        match message {
            Message::Command{id,name,args}=>match worker.command(&name,args){
                Ok(result)=>{write_frame(&mut output,Message::State{data:worker.status()})?;write_frame(&mut output,Message::Reply{id,result})?;},
                Err(code)=>{write_frame(&mut output,Message::State{data:worker.status()})?;write_frame(&mut output,Message::Error{id:Some(id),code,message:"Dota command failed; inspect plugin status".into()})?;},
            },
            Message::Stop=>{worker.stop()?;write_frame(&mut output,Message::Stopped)?;return Ok(());},
            _=>return Err("unexpected_message".into()),
        }
    }
    worker.stop()
}
fn main() { if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); } }
