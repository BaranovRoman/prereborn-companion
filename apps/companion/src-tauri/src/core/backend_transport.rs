//! Generic fixed-origin authenticated resource transport; no game payload types.
use std::time::Duration;

/// One bounded request per existing worker. Polling returns immediately while
/// network IO runs; repeating a pending key never starts a second HTTP call.
#[derive(Default)]
pub(crate) struct PendingRequest { job:Option<RequestJob> }
struct RequestJob {
    identity:Vec<u8>, thread:std::thread::JoinHandle<()>,
    reply:std::sync::mpsc::Receiver<companion_plugin_protocol::backend::Response>,
    result:Option<companion_plugin_protocol::backend::Response>,
}
impl PendingRequest {
    pub(crate) fn poll<F>(&mut self,request:&companion_plugin_protocol::backend::Request,perform:F)->Result<companion_plugin_protocol::backend::Response,String>
    where F:FnOnce()->companion_plugin_protocol::backend::Response+Send+'static {
        use companion_plugin_protocol::backend::Response;
        request.validate()?;
        let identity=serde_json::to_vec(request).map_err(|_|"invalid_backend_request")?;
        if let Some(job)=&mut self.job {
            if job.identity!=identity {
                if !job.thread.is_finished(){return Err("backend_request_in_flight".into());}
                self.finish()?;
            } else {
                if !job.thread.is_finished(){return Ok(Response::failed(request,"backend_request_pending"));}
                if job.result.is_none(){job.result=Some(job.reply.try_recv().unwrap_or_else(|_|Response::failed(request,"backend_result_unknown")));}
                return Ok(job.result.as_ref().unwrap().clone());
            }
        }
        let(tx,rx)=std::sync::mpsc::sync_channel(1);
        let thread=std::thread::Builder::new().name("plugin-resource".into()).spawn(move||{let _=tx.send(perform());}).map_err(|_|"backend_thread_unavailable")?;
        self.job=Some(RequestJob{identity,thread,reply:rx,result:None});
        Ok(Response::failed(request,"backend_request_pending"))
    }
    fn finish(&mut self)->Result<(),String>{
        if let Some(job)=self.job.take(){job.thread.join().map_err(|_|"backend_result_unknown")?;}Ok(())
    }
    /// Never confirm a process scope stopped while it still owns host IO.
    pub(crate) fn drain(&mut self,timeout:Duration)->Result<(),String>{
        let deadline=std::time::Instant::now()+timeout;
        while self.job.as_ref().is_some_and(|job|!job.thread.is_finished()) {
            if std::time::Instant::now()>=deadline{return Err("backend_stop_unproven".into());}
            std::thread::sleep(Duration::from_millis(5));
        }
        self.finish()
    }
}

pub(crate) fn request_plugin_resource(origin:&str,token:&str,resource:&companion_plugin_protocol::backend::Resource,request:&companion_plugin_protocol::backend::Request)->companion_plugin_protocol::backend::Response{
    use companion_plugin_protocol::backend::{Method,Response};
    use std::io::Read;
    if resource.authorize(request).is_err(){return Response::failed(request,"backend_resource_denied");}
    let client=match reqwest::blocking::Client::builder().timeout(Duration::from_millis(1000)).connect_timeout(Duration::from_millis(500)).redirect(reqwest::redirect::Policy::none()).build(){Ok(client)=>client,Err(_)=>return Response::failed(request,"backend_client_unavailable")};
    let url=format!("{origin}{}",resource.path);
    let mut call=match resource.method{Method::Get=>client.get(url),Method::Post=>client.post(url),Method::Put=>client.put(url)}.bearer_auth(token).query(&request.query);
    if let Some(body)=&request.body{call=call.json(body);}
    let response=match call.send(){Ok(response)=>response,Err(_)=>return Response::failed(request,"backend_result_unknown")};let status=response.status();
    if !status.is_success(){return Response{operation_key:request.operation_key.clone(),status:Some(status.as_u16()),body:None,error:Some("backend_http_rejected".into())};}
    let mut bytes=Vec::new();if response.take(u64::from(resource.max_response)+1).read_to_end(&mut bytes).is_err(){return Response::failed(request,"backend_result_unknown");}
    if bytes.len()>resource.max_response as usize{return Response::failed(request,"backend_response_limit");}
    let body=if bytes.is_empty(){None}else{match serde_json::from_slice(&bytes){Ok(value) if companion_plugin_protocol::backend::public_response(&value)=>Some(value),_=>return Response::failed(request,"backend_response_invalid")}};
    Response{operation_key:request.operation_key.clone(),status:Some(status.as_u16()),body,error:None}
}
#[cfg(test)]mod plugin_resource_tests{
 use super::*;use companion_plugin_protocol::backend::{Resource,Method,Request};use std::{net::TcpListener,io::{Read,Write}};
 fn request()->Request{Request{resource:"account".into(),operation_key:"account:1".into(),query:Default::default(),body:None}}
 fn resource()->Resource{Resource{path:"/stream/companion/account-settings".into(),method:Method::Get,query_keys:vec![],max_request:0,max_response:1024}}
 #[test]
 fn pending_network_io_does_not_block_frames_or_duplicate_a_call_and_drain_requires_exit(){
  use std::sync::{Arc,atomic::{AtomicUsize,Ordering},mpsc};
  let mut pending=PendingRequest::default();let calls=Arc::new(AtomicUsize::new(0));let count=calls.clone();
  let request=request();let call=request.clone();let(tx,rx)=mpsc::sync_channel(1);
  let start=std::time::Instant::now();
  assert_eq!(pending.poll(&request,move||{count.fetch_add(1,Ordering::SeqCst);rx.recv().unwrap();companion_plugin_protocol::backend::Response{operation_key:call.operation_key,status:Some(200),body:Some(serde_json::json!({"ok":true})),error:None}}).unwrap().error.as_deref(),Some("backend_request_pending"));
  assert!(start.elapsed()<Duration::from_millis(100));
  for _ in 0..20{assert_eq!(pending.poll(&request,||panic!("duplicate HTTP call")).unwrap().error.as_deref(),Some("backend_request_pending"));}
  let mut other=request.clone();other.body=Some(serde_json::json!({"changed":true}));
  assert_eq!(pending.poll(&other,||panic!("conflicting call")).unwrap_err(),"backend_request_in_flight");
  assert_eq!(pending.drain(Duration::from_millis(5)).unwrap_err(),"backend_stop_unproven");
  tx.send(()).unwrap();
  let deadline=std::time::Instant::now()+Duration::from_secs(2);
  loop{let response=pending.poll(&request,||panic!("duplicate HTTP call")).unwrap();if response.error.is_none(){assert_eq!(response.status,Some(200));break;}assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(5));}
  assert_eq!(calls.load(Ordering::SeqCst),1);
  assert_eq!(pending.poll(&request,||panic!("completed HTTP retry")).unwrap().body,Some(serde_json::json!({"ok":true})));
  pending.drain(Duration::from_secs(1)).unwrap();
 }
 #[test]
 fn exact_authenticated_route_is_bounded_and_neither_redirects_nor_secret_json_are_exported(){
  for (status,body,expected) in [(200,r#"{"gameMode":"ranked","currentMmr":2300}"#,None),(200,r#"{"profile":{"accessToken":"must not escape"}}"#,Some("backend_response_invalid")),(200,"oversized",Some("backend_response_limit")),(302,"",Some("backend_http_rejected"))]{
   let listener=TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
   let server=std::thread::spawn(move||{let(mut stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut bytes=Vec::new();let mut block=[0;1024];loop{let n=stream.read(&mut block).unwrap();assert!(n>0);bytes.extend_from_slice(&block[..n]);if bytes.windows(4).any(|w|w==b"\r\n\r\n"){break;}assert!(bytes.len()<8192);}
    let text=String::from_utf8(bytes).unwrap();assert!(text.starts_with("GET /api/stream/companion/account-settings HTTP/1.1"));assert!(text.to_ascii_lowercase().contains("authorization: bearer unit-credential"));
    let body=if body=="oversized"{"x".repeat(1025)}else{body.to_string()};write!(stream,"HTTP/1.1 {status} test\r\nLocation: https://invalid.test/must-not-follow\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
   });
   let response=request_plugin_resource(&format!("http://127.0.0.1:{port}/api"),"unit-credential",&resource(),&request());server.join().unwrap();assert_eq!(response.error.as_deref(),expected);
   let encoded=serde_json::to_string(&response).unwrap();assert!(!encoded.contains("unit-credential"));assert!(!encoded.contains("must not escape"));
   if expected.is_none(){assert_eq!(response.body.unwrap()["currentMmr"],2300);}else{assert!(response.body.is_none());}
  }
 }
 #[test]
 fn a_manifest_route_or_query_violation_is_rejected_before_network_io(){
  let mut resource=resource();resource.path="/stream/companion/auth/token".into();let result=request_plugin_resource("http://127.0.0.1:1/api","unit-credential",&resource,&request());assert_eq!(result.error.as_deref(),Some("backend_resource_denied"));
 }
}
