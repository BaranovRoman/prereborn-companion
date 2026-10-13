//! Replay-only Dota worker: stdio IPC, no sockets, SQLite, filesystem writes or account services.
use companion_plugin_protocol::{read_frame, write_frame, Message, CORE_API};
use companion_dota_domain::{contracts::{ReplayInput, DOTA_API, PLUGIN_ID, REPLAY_COMMAND}, replay::Replay};
use serde_json::json;
use std::io::{self, BufReader};

fn run() -> Result<(), String> {
    if std::env::args().skip(1).any(|arg| arg != "--replay") { return Err("live_mode_not_implemented".into()); }
    let mut input = BufReader::new(io::stdin()); let mut output = io::stdout();
    if !matches!(read_frame(&mut input)?, Some(Message::Hello { core_api: CORE_API })) { return Err("expected_compatible_hello".into()); }
    write_frame(&mut output, Message::Ready { id: PLUGIN_ID.into(), version: env!("CARGO_PKG_VERSION").into(), min_core_api: CORE_API, max_core_api: CORE_API })?;
    write_frame(&mut output, Message::State { data: json!({"mode":"replay_only","dotaApi":DOTA_API,"sideEffects":false,"liveCapabilities":[]}) })?;
    let mut replay = Replay::default();
    while let Some(message) = read_frame(&mut input)? {
        match message {
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
            Message::Command { id, name, .. } if name == "dota.reset" => { replay = Replay::default(); write_frame(&mut output, Message::Reply { id, result: json!({"reset":true,"sideEffects":false}) })?; },
            Message::Command { id, .. } => write_frame(&mut output, Message::Error { id: Some(id), code: "unsupported_replay_command".into(), message: "Live APIs are not connected".into() })?,
            Message::Stop => { write_frame(&mut output, Message::Stopped)?; return Ok(()); },
            _ => return Err("unexpected_message".into()),
        }
    }
    Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); } }
