//! Core OBS transport observation only. Installed packages own scene policy.
use std::time::{Duration,Instant};
use serde_json::{json,Value};
use tauri::{AppHandle,Emitter,Manager};
use tungstenite::Message;
#[cfg(test)]use tungstenite::WebSocket;
use crate::core::obs_transport::{read_event_or_timeout,read_json,ObsSocket};
pub(crate) use crate::core::obs_transport::ObsConfig;
use crate::{state::AppState,storage};
fn retry_delay(attempt:u32)->Duration{Duration::from_secs(2u64.saturating_pow(attempt.min(5)).min(30))}
pub fn test_connection(config:&ObsConfig)->Result<Vec<String>,String>{
 config.validate()?;Ok(crate::core::obs_transport::snapshot_before(&config.connection(),Instant::now()+Duration::from_millis(1500))?.scenes)
}
pub fn init(app:AppHandle){std::thread::spawn(move||{
 let mut attempt=0u32;let mut last_error=None;
 loop{
  let config=app.state::<AppState>().0.lock().unwrap().obs_config.clone();
  let result=watch_stream_state_once(&config,Duration::from_secs(20),|streaming,_|{
   let state=app.state::<AppState>();let mut inner=state.0.lock().unwrap();
   if inner.obs_config.host!=config.host||inner.obs_config.port!=config.port||inner.obs_config.password!=config.password{return;}
   inner.obs_connected=true;inner.obs_last_error=None;inner.obs_streaming=Some(streaming);inner.obs_streaming_confirmed_at=Some(chrono::Utc::now().to_rfc3339());drop(inner);
   let _=app.emit("obs-status",state.snapshot());
  },||{let state=app.state::<AppState>();let inner=state.0.lock().unwrap();inner.obs_config.host==config.host&&inner.obs_config.port==config.port&&inner.obs_config.password==config.password});
  if let Err(error)=result{
   let state=app.state::<AppState>();let mut inner=state.0.lock().unwrap();
   if inner.obs_config.host==config.host&&inner.obs_config.port==config.port&&inner.obs_config.password==config.password{inner.obs_connected=false;inner.obs_last_error=Some(error.clone());inner.obs_streaming=None;}
   drop(inner);let _=app.emit("obs-status",state.snapshot());
   if last_error.as_ref()!=Some(&error){storage::append_rolling_log(&app,"OBS stream observer disconnected; retrying.");last_error=Some(error);}
  }
  attempt=attempt.saturating_add(1);std::thread::sleep(retry_delay(attempt));
 }
});}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamingObservationSource {
    /// The one-time fetch right after (re)connecting.
    Initial,
    /// A live `StreamStateChanged` event.
    Event,
    /// WK-122 P0 fix - the periodic self-probe fired after a read-timeout
    /// silence (see `watch_stream_state_once`'s `None` arm).
    Heartbeat,
}

// WK-122 P0 fix - like `request`, but tolerant of an Event message (op 5)
// arriving interleaved with the response, because it reads from a
// connection that is actually subscribed to events (see
// `watch_stream_state_once`) - `request`'s single blind `read_json` call is
// only safe on the short-lived, effectively-unsubscribed connections
// `switch_scene`/`test_connection` use. A `StreamStateChanged` seen while
// waiting is reported immediately through the callback (never silently
// dropped in favor of the request/response exchange) rather than misread as
// the request's own response.
fn request_on_event_socket<F: FnMut(bool, StreamingObservationSource)>(
    socket: &mut ObsSocket,
    request_type: &str,
    request_data: Value,
    on_streaming_known: &mut F,
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

    loop {
        let message = read_json(socket)?;
        match message.get("op").and_then(Value::as_i64) {
            Some(7) => {
                let ok = message
                    .pointer("/d/requestStatus/result")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !ok {
                    let code = message
                        .pointer("/d/requestStatus/code")
                        .and_then(Value::as_i64);
                    let comment = message
                        .pointer("/d/requestStatus/comment")
                        .and_then(Value::as_str)
                        .unwrap_or("OBS не указал причину ошибки");
                    return Err(match code {
                        Some(code) => format!("OBS {request_type}: {comment} (код {code})"),
                        None => format!("OBS {request_type}: {comment}"),
                    });
                }
                return Ok(message);
            }
            Some(5) => {
                if message.pointer("/d/eventType").and_then(Value::as_str) == Some("StreamStateChanged") {
                    if let Some(active) = message
                        .pointer("/d/eventData/outputActive")
                        .and_then(Value::as_bool)
                    {
                        on_streaming_known(active, StreamingObservationSource::Event);
                    }
                }
                // Some other Outputs-category event - keep waiting for the
                // actual request response.
            }
            _ => {} // stray Hello/other op - not our concern here
        }
    }
}

const EVENT_SUBSCRIPTION_OUTPUTS: u32 = 1 << 6;

fn fetch_stream_status<F: FnMut(bool, StreamingObservationSource)>(
    socket: &mut ObsSocket,
    on_streaming_known: &mut F,
) -> Result<bool, String> {
    let response = request_on_event_socket(socket, "GetStreamStatus", json!({}), on_streaming_known)?;
    response
        .pointer("/d/responseData/outputActive")
        .and_then(Value::as_bool)
        .ok_or_else(|| "OBS: GetStreamStatus response missing outputActive".to_string())
}

fn watch_stream_state_once<F: FnMut(bool, StreamingObservationSource)>(
    config: &ObsConfig,
    read_timeout: Duration,
    mut on_streaming_known: F,
    mut current: impl FnMut()->bool,
) -> Result<(), String> {
    let mut socket = crate::core::obs_transport::open(&config.connection(),Some(read_timeout),Some(EVENT_SUBSCRIPTION_OUTPUTS))?;
    // WK-112 rule #5: every (re)connect always re-fetches GetStreamStatus
    // and reconciles from OBS's real, current answer - never from an
    // assumption that whatever we knew before the disconnect still holds.
    let streaming = fetch_stream_status(&mut socket, &mut on_streaming_known)?;
    on_streaming_known(streaming, StreamingObservationSource::Initial);

    loop {
        if !current(){return Err("obs_configuration_changed".into());}
        match read_event_or_timeout(&mut socket)? {
            Some(message) => {
                if message.get("op").and_then(Value::as_i64) != Some(5) {
                    continue; // not an Event message (e.g. a stray Hello/other op) - ignore
                }
                if message.pointer("/d/eventType").and_then(Value::as_str) != Some("StreamStateChanged") {
                    continue; // some other Outputs-category event (e.g. RecordStateChanged) - not our concern
                }
                if let Some(active) = message
                    .pointer("/d/eventData/outputActive")
                    .and_then(Value::as_bool)
                {
                    on_streaming_known(active, StreamingObservationSource::Event);
                }
            }
            None => {
                // WK-122 P0 fix - no event arrived for a full
                // `read_timeout` window. Rather than keep blocking
                // indefinitely, actively re-probe on the SAME connection: a
                // successful GetStreamStatus both re-confirms the current
                // truth (self-healing a missed StreamStateChanged too) and
                // proves the connection is genuinely still alive; a failure
                // here propagates as a real `Err`, which the caller's
                // backoff loop reconnects from. This is what bounds the
                // worst-case staleness window instead of leaving it
                // unbounded.
                let streaming = fetch_stream_status(&mut socket, &mut on_streaming_known)?;
                on_streaming_known(streaming, StreamingObservationSource::Heartbeat);
            }
        }
    }
}


#[cfg(test)]
mod tests{use super::*;
    mod stream_state_watcher_p0_regression {
        use super::*;
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};

        fn fake_hello_and_identify(ws: &mut WebSocket<TcpStream>) {
            ws.send(Message::Text(json!({ "op": 0, "d": { "rpcVersion": 1 } }).to_string().into()))
                .unwrap();
            loop {
                if let Message::Text(text) = ws.read().unwrap() {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(value.get("op").and_then(Value::as_i64), Some(1), "expected an Identify (op 1)");
                    break;
                }
            }
            ws.send(Message::Text(json!({ "op": 2, "d": { "negotiatedRpcVersion": 1 } }).to_string().into()))
                .unwrap();
        }

        /// Waits for the next `GetStreamStatus` request (op 6) and answers
        /// it - the `requestId` echoed back is a fixed placeholder since the
        /// real client (`request_on_event_socket`) never validates it.
        fn respond_to_next_get_stream_status(ws: &mut WebSocket<TcpStream>, output_active: bool) {
            loop {
                if let Message::Text(text) = ws.read().unwrap() {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value.get("op").and_then(Value::as_i64) == Some(6) {
                        break;
                    }
                }
            }
            ws.send(Message::Text(
                json!({
                    "op": 7,
                    "d": {
                        "requestType": "GetStreamStatus",
                        "requestId": "fake-server",
                        "requestStatus": { "result": true, "code": 100 },
                        "responseData": { "outputActive": output_active }
                    }
                })
                .to_string()
                .into(),
            ))
            .unwrap();
        }

        fn fake_obs_config(port: u16) -> ObsConfig {
            ObsConfig {
                enabled: true,
                host: "127.0.0.1".into(),
                port,
                password: String::new(),
                ..Default::default()
            }
        }

        fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) {
            let start = Instant::now();
            while !condition() {
                assert!(start.elapsed() < timeout, "condition not met within {timeout:?}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        // The actual root-cause regression: before the fix, a connection
        // that stops producing bytes in either direction after a successful
        // handshake (a half-open TCP connection - machine sleep/wake, OBS
        // killed without a clean close, a network path change) left
        // `read_json` blocked in `socket.read()` forever, since no read
        // timeout was ever set on this socket. No error, no reconnect, no
        // further streaming-truth observation - for the rest of the
        // process's life - while OBS scene automation (a totally separate,
        // always-fresh short-lived connection per switch) kept working the
        // whole time. This is the "match played, scenes changed correctly,
        // match never appeared in history" report end to end.
        #[test]
        fn a_connection_that_stops_responding_entirely_surfaces_as_an_error_within_one_read_timeout_not_never() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();

            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = tungstenite::accept(stream).unwrap();
                fake_hello_and_identify(&mut ws);
                respond_to_next_get_stream_status(&mut ws, true);
                // True zombie from here: never read, never write, never
                // close. Before the fix this would hang the caller forever;
                // after the fix it must surface as an `Err` within roughly
                // one read timeout.
                std::thread::sleep(Duration::from_secs(5));
            });

            let config = fake_obs_config(port);
            let start = Instant::now();
            let result = watch_stream_state_once(&config, Duration::from_millis(150), |_, _| {},||true);

            assert!(result.is_err(), "a connection that never responds again must surface as an error, not hang forever");
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "must detect the dead connection within a bounded time (~read_timeout), not hang - took {:?}",
                start.elapsed()
            );
        }

        // The self-healing half of the fix: even when a `StreamStateChanged`
        // event is never sent at all (simulating one getting lost, or OBS
        // flipping state during exactly the connection's blind spot), the
        // periodic heartbeat re-probe must still pick up the correct current
        // truth on its own, without needing that event.
        #[test]
        fn heartbeat_reprobe_self_heals_a_missed_stream_state_change_with_no_event_ever_sent() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();

            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = tungstenite::accept(stream).unwrap();
                fake_hello_and_identify(&mut ws);
                respond_to_next_get_stream_status(&mut ws, true); // the Initial fetch
                // Deliberately never sends a StreamStateChanged event - the
                // heartbeat re-probe below is what must surface this.
                respond_to_next_get_stream_status(&mut ws, false); // answers the heartbeat's own GetStreamStatus
                std::thread::sleep(Duration::from_secs(2)); // keep the socket open past the test's assertions
            });

            let config = fake_obs_config(port);
            let observations: Arc<Mutex<Vec<(bool, StreamingObservationSource)>>> = Arc::new(Mutex::new(Vec::new()));
            let observations_for_watcher = observations.clone();
            std::thread::spawn(move || {
                let _ = watch_stream_state_once(&config, Duration::from_millis(100), |streaming, source| {
                    observations_for_watcher.lock().unwrap().push((streaming, source));
                },||true);
            });

            wait_until(Duration::from_secs(2), || {
                observations.lock().unwrap().contains(&(true, StreamingObservationSource::Initial))
            });
            wait_until(Duration::from_secs(2), || {
                observations.lock().unwrap().contains(&(false, StreamingObservationSource::Heartbeat))
            });
            // And, just as important, never via a (never-sent) Event -
            // proving the heartbeat path, not a lucky Event delivery, is
            // what actually caught this.
            assert!(
                !observations.lock().unwrap().contains(&(false, StreamingObservationSource::Event)),
                "no StreamStateChanged event was ever sent by the fake server; the correction must come from the heartbeat"
            );
        }
    }
}
