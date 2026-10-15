//! Plugin-owned localhost ingress. ACK precedes projection/analysis, as in the
//! working legacy listener. No HTTP/SQLite/audio/OBS work on the consumer's IPC lock.
use companion_dota_domain::{contracts::ReplayGsi,projection::project};
use serde::Serialize;
use std::{io::Read,sync::{Arc,Mutex,mpsc::{self,Receiver,SyncSender},atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
const MAX_BODY:usize=512*1024;
const CAPACITY:usize=64;
pub struct Frame {pub sequence:u64,pub observed_at_ms:u64,pub snapshot:ReplayGsi}
#[derive(Default)]
struct Counters {received:AtomicU64,accepted:AtomicU64,rejected:AtomicU64,dropped:AtomicU64,sequence:AtomicU64,error:Mutex<Option<&'static str>>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status {pub received:u64,pub accepted:u64,pub rejected:u64,pub dropped:u64,pub last_sequence:u64,pub last_error:Option<&'static str>}
pub struct Listener {server:Arc<tiny_http::Server>,stop:Arc<AtomicBool>,admission:Arc<AtomicBool>,counters:Arc<Counters>,frames:Receiver<Frame>}
impl Listener {
 /// Bind before ownership admission. A second listener fails, never retries
 /// against another live owner or quietly takes a different endpoint.
 pub fn bind()->Result<Self,String>{Self::bind_address("127.0.0.1:3665")}
 fn bind_address(address:&str)->Result<Self,String>{
  let server=Arc::new(tiny_http::Server::http(address).map_err(|_|"gsi_bind_failed")?);
  let (tx,frames)=mpsc::sync_channel(CAPACITY);
  let counters=Arc::new(Counters::default());let stop=Arc::new(AtomicBool::new(false));let admission=Arc::new(AtomicBool::new(false));
  let listener=Self{server:server.clone(),stop:stop.clone(),admission:admission.clone(),counters:counters.clone(),frames};
  // Caller starts consumption only after its durable owner admission.
  std::thread::spawn(move||{
   let mut last_time=0;
   while !stop.load(Ordering::Acquire) {
    let request=match server.recv_timeout(Duration::from_millis(100)) {Ok(Some(r))=>r,Ok(None)=>continue,Err(_)=>{Self::error(&counters,"gsi_listener_failed");stop.store(true,Ordering::Release);break;}};
    Self::request(request,&tx,&counters,&stop,&admission,&mut last_time);
   }
  });Ok(listener)
 }
 fn error(c:&Counters,code:&'static str){if let Ok(mut e)=c.error.lock(){*e=Some(code);}}
 fn reject(c:&Counters,code:&'static str){c.rejected.fetch_add(1,Ordering::Relaxed);Self::error(c,code);}
 fn request(mut request:tiny_http::Request,tx:&SyncSender<Frame>,c:&Counters,stop:&AtomicBool,admission:&AtomicBool,last_time:&mut u64){
  c.received.fetch_add(1,Ordering::Relaxed);
  if request.method()!=&tiny_http::Method::Post||request.url()!="/" {let _=request.respond(tiny_http::Response::empty(405));Self::reject(c,"gsi_method_or_path");return;}
  if request.body_length().is_some_and(|n|n>MAX_BODY){let _=request.respond(tiny_http::Response::empty(413));Self::reject(c,"gsi_body_too_large");return;}
  let mut body=Vec::new();let read=request.as_reader().take((MAX_BODY+1) as u64).read_to_end(&mut body);
  if read.is_err()||body.len()>MAX_BODY{let _=request.respond(tiny_http::Response::empty(413));Self::reject(c,"gsi_body_invalid");return;}
  // Response first: processing time must not extend Valve's throttle interval.
  let _=request.respond(tiny_http::Response::from_string("{\"status\":\"ok\"}"));
  if stop.load(Ordering::Acquire)||!admission.load(Ordering::Acquire){return;}
  let raw:serde_json::Value=match serde_json::from_slice(&body){Ok(v)=>v,Err(_)=>{Self::reject(c,"gsi_json_invalid");return;}};
  let snapshot=match project(&raw){Ok(v)=>v,Err(code)=>{Self::reject(c,code);return;}};
  let sequence=match c.sequence.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|n.checked_add(1)){Ok(n)=>n+1,Err(_)=>{Self::reject(c,"gsi_sequence_exhausted");stop.store(true,Ordering::Release);return;}};
  let now=SystemTime::now().duration_since(UNIX_EPOCH).map(|d|d.as_millis().min(u128::from(u64::MAX)) as u64).unwrap_or(*last_time);
  *last_time=now.max(*last_time);
  match tx.try_send(Frame{sequence,observed_at_ms:*last_time,snapshot}) {
   Ok(())=>{c.accepted.fetch_add(1,Ordering::Relaxed);},
   Err(_)=>{c.dropped.fetch_add(1,Ordering::Relaxed);Self::error(c,"gsi_queue_overflow");stop.store(true,Ordering::Release);},
  }
 }
 pub fn start_admission(&self)->Result<(),String>{if self.failed(){return Err("gsi_listener_failed".into());}self.admission.store(true,Ordering::Release);Ok(())}
 pub fn next(&self)->Option<Frame>{self.frames.try_recv().ok()}
 pub fn status(&self)->Status{let c=&self.counters;Status{received:c.received.load(Ordering::Relaxed),accepted:c.accepted.load(Ordering::Relaxed),rejected:c.rejected.load(Ordering::Relaxed),dropped:c.dropped.load(Ordering::Relaxed),last_sequence:c.sequence.load(Ordering::Relaxed),last_error:c.error.lock().ok().and_then(|v|*v)}}
 pub fn failed(&self)->bool{self.stop.load(Ordering::Acquire)}
}
impl Drop for Listener {fn drop(&mut self){self.stop.store(true,Ordering::Release);self.server.unblock();}}

#[cfg(test)]
mod tests {
 use super::*;
 use std::{io::{Read,Write},net::TcpStream,time::Instant};
 fn send(listener:&Listener,body:&str){
  let address=listener.server.server_addr().to_ip().unwrap();let mut stream=TcpStream::connect(address).unwrap();
  stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
  write!(stream,"POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
  let mut response=String::new();stream.read_to_string(&mut response).unwrap();assert!(response.starts_with("HTTP/1.1 200"));
 }
 fn wait(listener:&Listener,expected:u64){let until=Instant::now()+Duration::from_secs(2);while listener.status().accepted+listener.status().rejected+listener.status().dropped<expected{assert!(Instant::now()<until);std::thread::sleep(Duration::from_millis(1));}}
 #[test]
 fn only_fresh_admitted_whitelisted_frames_are_queued_and_rejection_stays_visible(){
  let listener=Listener::bind_address("127.0.0.1:0").unwrap();
  let body=include_str!("../../../dota-domain/src/fixtures/techies-inventory.json");
  send(&listener,body);assert!(listener.next().is_none());assert_eq!(listener.status().last_sequence,0);
  listener.start_admission().unwrap();send(&listener,body);wait(&listener,1);
  let frame=listener.next().unwrap();assert_eq!(frame.sequence,1);assert!(frame.observed_at_ms>0);
  assert!(!serde_json::to_string(&frame.snapshot).unwrap().contains("SENSITIVE_FIXTURE"));
  send(&listener,"{\"items\":{\"stash6\":{}}}");wait(&listener,2);assert_eq!(listener.status().last_error,Some("invalid_item_slot"));
  send(&listener,body);wait(&listener,3);assert_eq!(listener.next().unwrap().sequence,2);
  assert_eq!(listener.status().last_error,Some("invalid_item_slot"));assert_eq!(listener.status().rejected,1);
 }
 #[test]
 fn bounded_queue_loss_closes_admission_instead_of_continuing_with_a_gap(){
  let listener=Listener::bind_address("127.0.0.1:0").unwrap();listener.start_admission().unwrap();
  for _ in 0..=CAPACITY {send(&listener,"{\"hero\":{\"id\":105}}");}
  wait(&listener,(CAPACITY+1) as u64);
  assert!(listener.failed());assert!(listener.start_admission().is_err());
  assert_eq!(listener.status().accepted,CAPACITY as u64);assert_eq!(listener.status().dropped,1);assert_eq!(listener.status().last_error,Some("gsi_queue_overflow"));
 }
}
