// OBS WebSocket transport only. Scene policy, GSI and stream-session ownership
// remain in the built-in Dota adapter; this layer knows only host/port/password.
use std::net::TcpStream;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

pub(crate) type ObsSocket = WebSocket<MaybeTlsStream<TcpStream>>;

// Borrowed credentials, deliberately without Debug or serialization.
pub(crate) struct ConnectionSettings<'a> {
    pub host: &'a str,
    pub port: u16,
    pub password: &'a str,
}

pub(crate) fn read_json(socket: &mut ObsSocket) -> Result<Value, String> {
    loop {
        match socket.read().map_err(|e| format!("OBS WebSocket: {e}"))? {
            Message::Text(text) => {
                return serde_json::from_str(&text)
                    .map_err(|e| format!("Некорректный ответ OBS: {e}"))
            }
            Message::Ping(data) => socket
                .send(Message::Pong(data))
                .map_err(|e| format!("OBS WebSocket: {e}"))?,
            Message::Close(_) => return Err("OBS закрыл соединение".into()),
            _ => {}
        }
    }
}

// WK-122 P0 fix - like `read_json`, but distinguishes "no message arrived
// within this socket's read timeout" (`Ok(None)`) from a genuine fatal
// disconnect (`Err`). Used only by the stream-state watcher's persistent
// event loop (see `run_stream_state_watcher_once`), where a read timeout is
// the intended mechanism for periodically re-confirming OBS's streaming
// truth rather than an error condition - every other caller (`request`,
// `open`'s hello/identify) keeps using plain `read_json` unchanged, where a
// timeout is and remains a real error.
pub(crate) fn read_event_or_timeout(socket: &mut ObsSocket) -> Result<Option<Value>, String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                return serde_json::from_str(&text)
                    .map(Some)
                    .map_err(|e| format!("Некорректный ответ OBS: {e}"));
            }
            Ok(Message::Ping(data)) => socket
                .send(Message::Pong(data))
                .map_err(|e| format!("OBS WebSocket: {e}"))?,
            Ok(Message::Close(_)) => return Err("OBS закрыл соединение".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref io_error))
                if matches!(
                    io_error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(format!("OBS WebSocket: {error}")),
        }
    }
}

fn authentication(password: &str, salt: &str, challenge: &str) -> String {
    let secret = BASE64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    BASE64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

// WK-112 - `read_timeout`/`event_subscriptions` are the two knobs the new
// stream-state watcher needs that the existing short-lived request/response
// callers (`test_connection`, `switch_scene`) don't: a persistent
// event-listening connection must block indefinitely on `read()` waiting
// for the next unsolicited event (a 4s read timeout - fine for "wait for
// the one response we expect" - would time out every few seconds with
// nothing wrong, and be indistinguishable from a real disconnect once
// converted to a `String` error, causing a busy reconnect loop) and must
// explicitly subscribe to OBS's Outputs event category (`StreamStateChanged`
// lives there) since it never sends further requests after the initial one
// to receive anything unsolicited on. `None`/`None` for both keeps the two
// existing callers' behavior byte-for-byte unchanged.
pub(crate) fn open(
    config: &ConnectionSettings<'_>,
    read_timeout: Option<Duration>,
    event_subscriptions: Option<u32>,
) -> Result<ObsSocket, String> {
    let url = format!("ws://{}:{}", config.host, config.port);
    let (mut socket, _) =
        connect(&url).map_err(|e| format!("Не удалось подключиться к OBS: {e}"))?;
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(read_timeout);
        let _ = stream.set_write_timeout(Some(Duration::from_secs(4)));
    }
    let hello = read_json(&mut socket)?;
    if hello.get("op").and_then(Value::as_i64) != Some(0) {
        return Err("OBS не прислал Hello".into());
    }
    let auth = hello
        .pointer("/d/authentication")
        .and_then(Value::as_object)
        .map(|value| {
            let salt = value
                .get("salt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let challenge = value
                .get("challenge")
                .and_then(Value::as_str)
                .unwrap_or_default();
            authentication(config.password, salt, challenge)
        });
    let mut identify = json!({ "op": 1, "d": { "rpcVersion": 1 } });
    if let Some(auth) = auth {
        identify["d"]["authentication"] = Value::String(auth);
    }
    if let Some(subscriptions) = event_subscriptions {
        identify["d"]["eventSubscriptions"] = Value::from(subscriptions);
    }
    socket
        .send(Message::Text(identify.to_string().into()))
        .map_err(|e| format!("OBS WebSocket: {e}"))?;
    let identified = read_json(&mut socket)?;
    if identified.get("op").and_then(Value::as_i64) != Some(2) {
        return Err("OBS отклонил пароль или версию WebSocket".into());
    }
    Ok(socket)
}

pub(crate) fn request(
    socket: &mut ObsSocket,
    request_type: &str,
    request_data: Value,
) -> Result<Value, String> {
    let request_id = format!(
        "companion-{}",
        chrono::Local::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
    );
    socket
        .send(Message::Text(
            json!({
                "op": 6,
                "d": {
                    "requestType": request_type,
                    "requestId": request_id,
                    "requestData": request_data
                }
            })
            .to_string()
            .into(),
        ))
        .map_err(|e| format!("OBS WebSocket: {e}"))?;
    let response = read_json(socket)?;
    let ok = response
        .pointer("/d/requestStatus/result")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !ok {
        // WK-115 audit - the request's own `requestType`/`code` used to be
        // dropped here, leaving only the (sometimes absent) `comment` behind
        // a generic "неизвестная ошибка" - impossible to tell "OBS refused
        // the password" from "the scene doesn't exist" from the log alone.
        // `code` is what `is_resource_not_found` below keys off (604 =
        // obs-websocket's RESOURCE_NOT_FOUND) to detect a missing Post
        // Stream scene specifically, rather than guessing from `comment`'s
        // free-text wording.
        let code = response
            .pointer("/d/requestStatus/code")
            .and_then(Value::as_i64);
        let comment = response
            .pointer("/d/requestStatus/comment")
            .and_then(Value::as_str)
            .unwrap_or("OBS не указал причину ошибки");
        return Err(match code {
            Some(code) => format!("OBS {request_type}: {comment} (код {code})"),
            None => format!("OBS {request_type}: {comment}"),
        });
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn authenticated_handshake_preserves_subscription_and_request_wire_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            socket.send(Message::Text(json!({"op": 0, "d": {
                "authentication": {"salt": "test-salt", "challenge": "test-challenge"}
            }}).to_string().into())).unwrap();
            let identify: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(identify, json!({"op": 1, "d": {
                "rpcVersion": 1, "eventSubscriptions": 64,
                "authentication": "zBIloly70ANx+T9nUkQVuTCqTUuHtfrqEdn8XDQ3m/s="
            }}));
            socket.send(Message::Text(json!({"op": 2, "d": {"negotiatedRpcVersion": 1}}).to_string().into())).unwrap();
            let command: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(command["op"], 6);
            assert_eq!(command["d"]["requestType"], "GetStreamStatus");
            assert_eq!(command["d"]["requestData"], json!({}));
            assert!(command["d"]["requestId"].as_str().unwrap().starts_with("companion-"));
            socket.send(Message::Text(json!({"op": 7, "d": {
                "requestId": command["d"]["requestId"],
                "requestStatus": {"result": true, "code": 100},
                "responseData": {"outputActive": true}
            }}).to_string().into())).unwrap();
        });
        let mut socket = open(&ConnectionSettings {
            host: "127.0.0.1", port, password: "test-password",
        }, Some(Duration::from_secs(4)), Some(64)).unwrap();
        let response = request(&mut socket, "GetStreamStatus", json!({})).unwrap();
        assert_eq!(response["d"]["responseData"]["outputActive"], true);
        server.join().unwrap();
    }
}
