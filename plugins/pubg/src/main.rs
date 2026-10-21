//! PUBG worker: stdio IPC with the Companion host. The only mode is the
//! installed live worker (`--worker <launch>`).
use companion_plugin_protocol::{read_frame, write_frame, Message, CORE_API};
use companion_pubg_plugin::{worker::{Launch, Worker}, PLUGIN_ID};
use std::io::{self, BufReader};

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 || args[0] != "--worker" { return Err("invalid_runtime_mode".into()); }
    let mut worker = Worker::new(Launch::parse(&args[1])?);
    let mut input = BufReader::new(io::stdin());
    let mut output = io::stdout();
    if !matches!(read_frame(&mut input)?, Some(Message::Hello { core_api: CORE_API })) { return Err("expected_compatible_hello".into()); }
    write_frame(&mut output, Message::Ready { id: PLUGIN_ID.into(), version: env!("CARGO_PKG_VERSION").into(), min_core_api: CORE_API, max_core_api: CORE_API })?;
    while let Some(message) = read_frame(&mut input)? {
        match message {
            Message::Command { id, name, args } => {
                let result = (|| {
                    if name == "host.poll" {
                        // One reverse read per poll; the host does the HTTP call.
                        if let Some(request) = worker.backend_request()? {
                            write_frame(&mut output, Message::CoreRead { id, request: serde_json::to_value(&request).map_err(|_| "invalid_backend_request")? })?;
                            let Some(Message::CoreReadReply { id: reply_id, response }) = read_frame(&mut input)? else { return Err("expected_core_read_reply".into()); };
                            if reply_id != id { return Err("core_read_correlation_mismatch".into()); }
                            let response = serde_json::from_value(response).map_err(|_| "invalid_backend_response")?;
                            worker.backend_response(&request, response)?;
                        }
                    }
                    worker.command(&name, args)
                })();
                write_frame(&mut output, Message::State { data: worker.status() })?;
                match result {
                    Ok(result) => write_frame(&mut output, Message::Reply { id, result })?,
                    Err(code) => write_frame(&mut output, Message::Error { id: Some(id), code, message: "PUBG command failed".into() })?,
                }
            },
            Message::Stop => { worker.stop(); write_frame(&mut output, Message::Stopped)?; return Ok(()); },
            _ => return Err("unexpected_message".into()),
        }
    }
    worker.stop();
    Ok(())
}

fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
