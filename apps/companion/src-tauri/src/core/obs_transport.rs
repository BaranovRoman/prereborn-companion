// OBS WebSocket transport only: no scene policy, GSI or game/session types.
use std::net::TcpStream;
use std::time::{Duration,Instant};

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

#[derive(Clone,Debug,serde::Serialize,serde::Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct PublicSnapshot {
    pub current_scene:String,
    pub scenes:Vec<String>,
    pub streaming:bool,
    pub observed_at_ms:u64,
}
fn scene_name(value:&Value)->Result<String,String>{
    value.as_str().filter(|s|!s.is_empty()&&s.len()<=256&&!s.chars().any(char::is_control)).map(str::to_string).ok_or("obs_scene_response_invalid".into())
}
/// Fresh, bounded authoritative state. No password/host/provider metadata or
/// cached values are returned to a plugin. Failure never becomes streaming=false.
pub(crate) fn snapshot_before(config:&ConnectionSettings<'_>,deadline:Instant)->Result<PublicSnapshot,String>{
    let mut socket=open_before(config,deadline)?;
    let result=request_before(&mut socket,"GetSceneList",json!({}),Some(deadline))?;
    let items=result.pointer("/d/responseData/scenes").and_then(Value::as_array).filter(|a|a.len()<=128).ok_or("obs_scene_list_limit")?;
    let mut scenes=Vec::with_capacity(items.len());
    for item in items {let name=scene_name(&item["sceneName"])?;if scenes.contains(&name){return Err("obs_scene_list_invalid".into());}scenes.push(name);}
    let result=request_before(&mut socket,"GetCurrentProgramScene",json!({}),Some(deadline))?;
    let current_scene=scene_name(&result["d"]["responseData"]["currentProgramSceneName"])?;
    let result=request_before(&mut socket,"GetStreamStatus",json!({}),Some(deadline))?;
    let streaming=result.pointer("/d/responseData/outputActive").and_then(Value::as_bool).ok_or("obs_stream_state_invalid")?;
    let observed_at_ms=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"clock_unavailable")?.as_millis().try_into().map_err(|_|"clock_unavailable")?;
    let snapshot=PublicSnapshot{current_scene,scenes,streaming,observed_at_ms};
    if serde_json::to_vec(&snapshot).map_err(|_|"obs_state_encoding_failed")?.len()>24576{return Err("obs_public_state_limit".into());}Ok(snapshot)
}
pub(crate) fn program_scene_before(config:&ConnectionSettings<'_>,deadline:Instant)->Result<String,String>{
    let mut socket=open_before(config,deadline)?;
    let response=request_before(&mut socket,"GetCurrentProgramScene",json!({}),Some(deadline))?;
    scene_name(&response["d"]["responseData"]["currentProgramSceneName"])
}
pub(crate) fn stream_status_before(config:&ConnectionSettings<'_>,deadline:Instant)->Result<bool,String>{
    let mut socket=open_before(config,deadline)?;
    let response=request_before(&mut socket,"GetStreamStatus",json!({}),Some(deadline))?;
    response.pointer("/d/responseData/outputActive").and_then(Value::as_bool).ok_or("obs_stream_state_invalid".into())
}
pub(crate) fn set_program_scene_before(config:&ConnectionSettings<'_>,desired:&str,deadline:Instant)->Result<(),String>{
    scene_name(&Value::String(desired.into()))?;
    let mut socket=open_before(config,deadline)?;
    request_before(&mut socket,"SetCurrentProgramScene",json!({"sceneName":desired}),Some(deadline))?;Ok(())
}
/// Exactly the existing observe -> at most one write -> observe rule. True
/// confirms desired state, never exactly-once command delivery. Cached state,
/// write ACK alone and blind retry cannot establish this result.
pub(crate) fn reconcile_scene(desired:&str,mut observe:impl FnMut()->Result<String,String>,mut switch:impl FnMut()->Result<(),String>)->bool{
    reconcile_scene_status(desired,&mut observe,&mut switch)==companion_plugin_protocol::audio::Status::Completed
}
pub(crate) fn reconcile_scene_status(desired:&str,mut observe:impl FnMut()->Result<String,String>,mut switch:impl FnMut()->Result<(),String>)->companion_plugin_protocol::audio::Status{
    use companion_plugin_protocol::audio::Status;
    match observe(){Ok(scene) if scene==desired=>return Status::Completed,Err(_)=>return Status::Cancelled,_=>()}
    let _=switch();
    if matches!(observe(),Ok(scene) if scene==desired){Status::Completed}else{Status::Unknown}
}

pub(crate) fn read_json(socket: &mut ObsSocket) -> Result<Value, String> {
    read_before(socket,None)
}
fn read_before(socket:&mut ObsSocket,deadline:Option<Instant>)->Result<Value,String> {
    loop {
        socket_deadline(socket,deadline)?;
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
    identify(&mut socket,config,event_subscriptions,None)?;
    Ok(socket)
}
// External transport has one absolute deadline including connect, HTTP/OBS
// handshakes and request. Hostnames would require unbounded synchronous DNS;
// legacy transport is unchanged, the gated external beta requires a literal IP.
pub(crate) fn open_before(config:&ConnectionSettings<'_>,deadline:Instant)->Result<ObsSocket,String> {
 let ip:std::net::IpAddr=if config.host=="localhost" {std::net::Ipv4Addr::LOCALHOST.into()}else{config.host.parse().map_err(|_|"external_obs_requires_literal_address")?};
 let address=std::net::SocketAddr::new(ip,config.port);let remaining=deadline.checked_duration_since(Instant::now()).ok_or("OBS deadline elapsed")?;
 let stream=TcpStream::connect_timeout(&address,remaining).map_err(|_|"OBS connect unavailable")?;
 let remaining=deadline.checked_duration_since(Instant::now()).filter(|v|!v.is_zero()).ok_or("OBS deadline elapsed")?;
 // An owned-socket deadline also bounds continuous Ping/partial HTTP traffic,
 // unlike a per-read timeout. It cannot close another OBS/Twitch connection.
 let timeout_socket=stream.try_clone().map_err(|_|"OBS deadline unavailable")?;
 std::thread::spawn(move||{std::thread::sleep(remaining);let _=timeout_socket.shutdown(std::net::Shutdown::Both);});
 stream.set_read_timeout(Some(remaining)).map_err(|_|"OBS timeout unavailable")?;stream.set_write_timeout(Some(remaining)).map_err(|_|"OBS timeout unavailable")?;
 let url=format!("ws://{address}");let (mut socket,_)=tungstenite::client::client_with_config(url.as_str(),MaybeTlsStream::Plain(stream),Some(tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(65536)).max_frame_size(Some(65536)))).map_err(|_|"OBS handshake unavailable")?;
 identify(&mut socket,config,None,Some(deadline))?;Ok(socket)
}
fn socket_deadline(socket:&mut ObsSocket,deadline:Option<Instant>)->Result<(),String> {
 if let Some(deadline)=deadline {
  let remaining=deadline.checked_duration_since(Instant::now()).filter(|v|!v.is_zero()).ok_or("OBS deadline elapsed")?;
  if let MaybeTlsStream::Plain(stream)=socket.get_mut(){stream.set_read_timeout(Some(remaining)).map_err(|_|"OBS timeout unavailable")?;stream.set_write_timeout(Some(remaining)).map_err(|_|"OBS timeout unavailable")?;}
 }
 Ok(())
}
fn identify(socket:&mut ObsSocket,config:&ConnectionSettings<'_>,event_subscriptions:Option<u32>,deadline:Option<Instant>)->Result<(),String> {
    let hello = read_before(socket,deadline)?;
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
    socket_deadline(socket,deadline)?;
    socket
        .send(Message::Text(identify.to_string().into()))
        .map_err(|e| format!("OBS WebSocket: {e}"))?;
    let identified = read_before(socket,deadline)?;
    if identified.get("op").and_then(Value::as_i64) != Some(2) {
        return Err("OBS отклонил пароль или версию WebSocket".into());
    }
    Ok(())
}

pub(crate) fn request(
    socket: &mut ObsSocket,
    request_type: &str,
    request_data: Value,
) -> Result<Value, String> {
    request_before(socket,request_type,request_data,None)
}
pub(crate) fn request_before(socket:&mut ObsSocket,request_type:&str,request_data:Value,deadline:Option<Instant>)->Result<Value,String> {
    socket_deadline(socket,deadline)?;
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
    let response = read_before(socket,deadline)?;
    if response.get("op").and_then(Value::as_i64)!=Some(7)||response.pointer("/d/requestId").and_then(Value::as_str)!=Some(request_id.as_str()) {
        return Err("OBS response correlation mismatch".into());
    }
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
    fn lifecycle_stream_observation_requires_correlated_typed_obs_truth() {
        for (wire,expected) in [(json!(true),Some(true)),(json!(false),Some(false)),(json!("false"),None),(Value::Null,None)] {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
            let server=std::thread::spawn(move||{
                let (stream,_)=listener.accept().unwrap();let mut socket=tungstenite::accept(stream).unwrap();
                socket.send(Message::Text(json!({"op":0,"d":{}}).to_string().into())).unwrap();let _=socket.read().unwrap();
                socket.send(Message::Text(json!({"op":2,"d":{}}).to_string().into())).unwrap();
                let request:Value=serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();assert_eq!(request["d"]["requestType"],"GetStreamStatus");
                socket.send(Message::Text(json!({"op":7,"d":{"requestId":request["d"]["requestId"],"requestStatus":{"result":true},"responseData":{"outputActive":wire}}}).to_string().into())).unwrap();
            });
            let result=stream_status_before(&ConnectionSettings{host:"127.0.0.1",port,password:"not exported"},Instant::now()+Duration::from_secs(2));
            assert_eq!(result.ok(),expected);server.join().unwrap();
        }
    }

    #[test]
    fn fresh_public_snapshot_has_real_stream_and_scene_state_but_no_credentials_or_raw_response() {
        for valid_stream in [true,false] {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
            let server=std::thread::spawn(move||{
                let (stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut socket=tungstenite::accept(stream).unwrap();
                socket.send(Message::Text(json!({"op":0,"d":{}}).to_string().into())).unwrap();
                let _:Value=serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
                socket.send(Message::Text(json!({"op":2,"d":{}}).to_string().into())).unwrap();
                for (name,data) in [
                    ("GetSceneList",json!({"scenes":[{"sceneName":"Scene A","sourceUuid":"not exported"}]})),
                    ("GetCurrentProgramScene",json!({"currentProgramSceneName":"Scene A"})),
                    ("GetStreamStatus",if valid_stream{json!({"outputActive":true,"outputBytes":123,"secret":"not exported"})}else{json!({"outputActive":"false"})}),
                ] {
                    let request:Value=serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();assert_eq!(request["d"]["requestType"],name);
                    socket.send(Message::Text(json!({"op":7,"d":{"requestId":request["d"]["requestId"],"requestStatus":{"result":true},"responseData":data}}).to_string().into())).unwrap();
                }
            });
            let result=snapshot_before(&ConnectionSettings{host:"127.0.0.1",port,password:"credential-only-in-core"},Instant::now()+Duration::from_secs(2));
            server.join().unwrap();
            if valid_stream{
                let snapshot=result.unwrap();assert!(snapshot.streaming);assert_eq!(snapshot.current_scene,"Scene A");assert_eq!(snapshot.scenes,vec!["Scene A"]);
                let encoded=serde_json::to_string(&snapshot).unwrap();assert!(!encoded.contains("credential"));assert!(!encoded.contains("sourceUuid"));assert!(!encoded.contains("outputBytes"));assert!(!encoded.contains("not exported"));
            }else{assert_eq!(result.unwrap_err(),"obs_stream_state_invalid");}
        }
    }
    #[test]
    fn reconciliation_never_trusts_write_ack_or_cached_state_or_retries_an_ambiguous_write(){
        assert_eq!(reconcile_scene_status("desired",||Err("not connected before any write".into()),||panic!("blind write")),companion_plugin_protocol::audio::Status::Cancelled);
        assert!(!reconcile_scene("desired",||Err("unreachable".into()),||panic!("blind write")));
        assert!(reconcile_scene("desired",||Ok("desired".into()),||panic!("duplicate write")));
        let mut observations=[Ok("other".into()),Ok("desired".into())].into_iter();let mut writes=0;
        assert!(reconcile_scene("desired",||observations.next().unwrap(),||{writes+=1;Err("reply lost".into())}));assert_eq!(writes,1);
        let mut observations=[Ok("other".into()),Err("unreachable".into())].into_iter();let mut writes=0;
        assert!(!reconcile_scene("desired",||observations.next().unwrap(),||{writes+=1;Ok(())}));assert_eq!(writes,1);
    }

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
#[cfg(test)]
mod external_deadline_tests {
 use super::*;use std::net::TcpListener;
 #[test]
 fn authoritative_scene_is_correlated_and_wrong_reply_is_not_confirmation() {
  for correct in [true,false] {
   let listener=TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
   let server=std::thread::spawn(move||{
    let (stream,_)=listener.accept().unwrap();let mut ws=tungstenite::accept(stream).unwrap();
    ws.send(Message::Text(json!({"op":0,"d":{}}).to_string().into())).unwrap();let _=ws.read().unwrap();ws.send(Message::Text(json!({"op":2,"d":{}}).to_string().into())).unwrap();
    let req:Value=serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();assert_eq!(req["d"]["requestType"],"GetCurrentProgramScene");
    ws.send(Message::Text(json!({"op":7,"d":{"requestId":if correct{req["d"]["requestId"].clone()}else{json!("stale-request")},"requestStatus":{"result":true},"responseData":{"currentProgramSceneName":"desired"}}}).to_string().into())).unwrap();
   });
   let deadline=Instant::now()+Duration::from_secs(1);let mut ws=open_before(&ConnectionSettings{host:"127.0.0.1",port,password:""},deadline).unwrap();
   let result=request_before(&mut ws,"GetCurrentProgramScene",json!({}),Some(deadline));assert_eq!(result.is_ok(),correct);server.join().unwrap();
  }
 }
 #[test]
 fn hung_handshake_and_expired_deadline_are_bounded_without_dns() {
  let listener=TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
  let server=std::thread::spawn(move||{let (stream,_)=listener.accept().unwrap();let _ws=tungstenite::accept(stream).unwrap();std::thread::sleep(Duration::from_millis(200));});
  let start=Instant::now();assert!(open_before(&ConnectionSettings{host:"127.0.0.1",port,password:""},start+Duration::from_millis(50)).is_err());assert!(start.elapsed()<Duration::from_millis(180));server.join().unwrap();
  assert!(open_before(&ConnectionSettings{host:"not-a-literal.invalid",port,password:""},Instant::now()+Duration::from_secs(1)).is_err());
 }
}
