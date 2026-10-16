//! Generic fixed-origin authenticated resource transport; no game payload types.
use std::time::Duration;

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
