use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, Read, Write};

pub const PROTOCOL: u32 = 1;
pub const CORE_API: u32 = 1;
pub const MAX_FRAME: usize = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub protocol: u32,
    pub message: Message,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Message {
    Hello { core_api: u32 },
    Ready { id: String, version: String, min_core_api: u32, max_core_api: u32 },
    Command { id: u64, name: String, args: Value },
    Reply { id: u64, result: Value },
    Event { name: String, data: Value },
    State { data: Value },
    Stop,
    Stopped,
    Error { id: Option<u64>, code: String, message: String },
}

pub fn write_frame(writer: &mut impl Write, message: Message) -> Result<(), String> {
    let bytes = serde_json::to_vec(&Frame { protocol: PROTOCOL, message }).map_err(|e| e.to_string())?;
    if bytes.len() + 1 > MAX_FRAME { return Err("frame_too_large".into()); }
    writer.write_all(&bytes).and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush()).map_err(|e| e.to_string())
}

pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<Message>, String> {
    let mut bytes = Vec::new();
    reader.take((MAX_FRAME + 1) as u64).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
    if bytes.is_empty() { return Ok(None); }
    if bytes.len() > MAX_FRAME { return Err("frame_too_large".into()); }
    if bytes.last() != Some(&b'\n') { return Err("truncated_frame".into()); }
    let frame: Frame = serde_json::from_slice(&bytes).map_err(|_| "invalid_frame".to_string())?;
    if frame.protocol != PROTOCOL { return Err("incompatible_protocol".into()); }
    Ok(Some(frame.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelopes_round_trip_and_reject_bad_versions_and_partial_or_large_frames() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, Message::Command { id: 7, name: "greet".into(), args: Value::Null }).unwrap();
        assert!(matches!(read_frame(&mut &bytes[..]).unwrap(), Some(Message::Command { id: 7, .. })));
        assert_eq!(read_frame(&mut &b"{\"protocol\":2,\"message\":{\"type\":\"stop\"}}\n"[..]).unwrap_err(), "incompatible_protocol");
        assert_eq!(read_frame(&mut &b"{}"[..]).unwrap_err(), "truncated_frame");
        assert_eq!(read_frame(&mut &vec![b'x'; MAX_FRAME + 1][..]).unwrap_err(), "frame_too_large");
        assert_eq!(read_frame(&mut &b"{\"protocol\":1,\"message\":{\"type\":\"unknown\"}}\n"[..]).unwrap_err(), "invalid_frame");
        assert!(read_frame(&mut &b""[..]).unwrap().is_none());
    }
}
