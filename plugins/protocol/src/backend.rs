//! Exact resources granted by a signed package, not a URL/HTTP proxy.
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::collections::{BTreeMap,BTreeSet};
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="UPPERCASE")]
pub enum Method{Get,Post,Put}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Resource{pub path:String,pub method:Method,#[serde(default)]pub query_keys:Vec<String>,pub max_request:u32,pub max_response:u32}
impl Resource{
 pub fn validate(&self)->Result<(),String>{
  let path=self.path.strip_prefix("/stream/companion/").ok_or("backend_resource_denied")?;
  if path.is_empty()||self.path.len()>160||path.split('/').count()>6||path.split('/').any(|s|s.is_empty()||!s.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b"-_".contains(&b))||matches!(s,"auth"|"login"|"logout"|"refresh"|"token"|"tokens"|"credentials"))
   ||self.max_request>8192||self.max_response==0||self.max_response>24576||self.query_keys.len()>8||self.query_keys.iter().collect::<BTreeSet<_>>().len()!=self.query_keys.len()||self.query_keys.iter().any(|k|!name(k)){return Err("backend_resource_denied".into());}Ok(())
 }
 pub fn authorize(&self,request:&Request)->Result<(),String>{
  self.validate()?;request.validate()?;
  let size=request.body.as_ref().map(serde_json::to_vec).transpose().map_err(|_|"invalid_backend_request")?.map_or(0,|v|v.len());
  if request.query.keys().any(|k|!self.query_keys.contains(k))||(self.method==Method::Get&&request.body.is_some())||size>self.max_request as usize{return Err("backend_request_denied".into());}Ok(())
 }
}
fn name(s:&str)->bool{!s.is_empty()&&s.len()<=64&&s.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b"-_".contains(&b))}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Request{pub resource:String,pub operation_key:String,#[serde(default)]pub query:BTreeMap<String,String>,pub body:Option<Value>}
impl Request{
 pub fn validate(&self)->Result<(),String>{
  if !name(&self.resource)||self.operation_key.is_empty()||self.operation_key.len()>128||!self.operation_key.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_:".contains(&b))||self.query.len()>8||self.query.iter().any(|(k,v)|!name(k)||v.len()>128||v.chars().any(char::is_control))||serde_json::to_vec(self).map_err(|_|"invalid_backend_request")?.len()>8192{return Err("invalid_backend_request".into());}Ok(())
 }
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Response{pub operation_key:String,pub status:Option<u16>,pub body:Option<Value>,pub error:Option<String>}
impl Response{pub fn failed(request:&Request,code:&str)->Self{Self{operation_key:request.operation_key.clone(),status:None,body:None,error:Some(code.into())}}}
pub fn public_response(value:&Value)->bool{
 fn safe(value:&Value,depth:u32)->bool{
  if depth>24{return false;}
  match value{
   Value::Object(map)=>map.iter().all(|(key,value)|{let key=key.to_ascii_lowercase();!["token","password","authorization","authentication","secret","credential","cookie"].iter().any(|part|key.contains(part))&&!matches!(key.as_str(),"apikey"|"api_key"|"streamkey"|"stream_key")&&safe(value,depth+1)}),
   Value::Array(values)=>values.len()<=1024&&values.iter().all(|v|safe(v,depth+1)),_=>true,
  }
 }safe(value,0)
}
#[cfg(test)]mod tests{
 use super::*;
 fn resource()->Resource{Resource{path:"/stream/companion/account-settings".into(),method:Method::Get,query_keys:vec![],max_request:4,max_response:24576}}
 #[test]fn signature_scoped_resources_never_accept_a_url_secret_route_method_or_ungranted_query(){
  let request=Request{resource:"account".into(),operation_key:"account:1".into(),query:Default::default(),body:None};resource().authorize(&request).unwrap();
  for path in ["https://evil.test","/auth/token","/stream/companion/../auth","/stream/companion/session/refresh","/stream/companion/account-settings?token=secret","/stream/companion//account-settings"]{let mut grant=resource();grant.path=path.into();assert!(grant.authorize(&request).is_err());}
  let mut injected=request.clone();injected.query.insert("url".into(),"https://evil.test".into());assert!(resource().authorize(&injected).is_err());
  let mut injected=request;injected.body=Some(serde_json::json!({}));assert!(resource().authorize(&injected).is_err());
 }
 #[test]fn unexpected_credentials_in_an_otherwise_allowed_response_are_not_exported(){
  assert!(public_response(&serde_json::json!({"gameMode":"ranked","currentMmr":2300})));
  for key in ["access_token","accessToken","refreshToken","password","authorization","companionToken","twitchAccessToken","clientSecret","apiKey","streamKey","Cookie"]{assert!(!public_response(&serde_json::json!({"nested":[{(key):"secret"}]})));}
 }
}
