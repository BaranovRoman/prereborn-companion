use companion_plugin_protocol::{read_frame, write_frame, Message, CORE_API};
use serde_json::json;
use std::io::{self, BufReader};

fn run() -> Result<(), String> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut input = BufReader::new(io::stdin());
    let mut output = io::stdout();
    if !matches!(read_frame(&mut input)?, Some(Message::Hello { core_api: CORE_API })) {
        return Err("expected_hello".into());
    }
    // Explicit fault fixtures for lifecycle tests; never enabled by the UI.
    match mode.as_str() {
        "exit" => std::process::exit(23),
        "hang" => loop { std::thread::sleep(std::time::Duration::from_secs(1)); },
        "malformed" => { use std::io::Write; writeln!(output, "not-json").unwrap(); return Ok(()); }
        "protocol" => { use std::io::Write; writeln!(output, "{{\"protocol\":99,\"message\":{{\"type\":\"stopped\"}}}}").unwrap(); return Ok(()); }
        _ => {}
    }
    write_frame(&mut output, Message::Ready {
        id: "hello".into(), version: env!("CARGO_PKG_VERSION").into(),
        min_core_api: if mode == "incompatible" { 2 } else { 1 }, max_core_api: 1,
    })?;
    write_frame(&mut output, Message::State { data: json!({"greetings": 0}) })?;
    let mut greetings = 0;
    while let Some(message) = read_frame(&mut input)? {
        match message {
            Message::Command { id, name, args } if name == "greet" => {
                greetings += 1;
                let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("World");
                let result = json!({"text": format!("Hello, {text}!"), "greetings": greetings});
                write_frame(&mut output, Message::Event { name: "greeted".into(), data: result.clone() })?;
                write_frame(&mut output, Message::State { data: json!({"greetings": greetings}) })?;
                write_frame(&mut output, Message::Reply { id, result })?;
            }
            Message::Command { name, .. } if name == "crash" => std::process::exit(42),
            Message::Command { name, .. } if name == "hang" => loop { std::thread::sleep(std::time::Duration::from_secs(1)); },
            Message::Command { id, .. } => write_frame(&mut output, Message::Error { id: Some(id), code: "unknown_command".into(), message: "Unknown command".into() })?,
            Message::Stop => { write_frame(&mut output, Message::Stopped)?; return Ok(()); }
            _ => return Err("unexpected_message".into()),
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
