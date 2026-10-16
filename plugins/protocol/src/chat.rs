//! Read-only public chat projection; no account IDs, credentials or new connection.
use serde::{Deserialize,Serialize};
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Snapshot{pub observed_at_ms:u64,pub data:Chat}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Chat{pub account_connected:bool,pub configured:bool,pub display_name:Option<String>,pub connected:bool,pub state:String,pub messages:Vec<Message>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Message{pub id:String,pub author:String,pub color:Option<String>,pub text:String,pub received_at:String}
fn field(value:&serde_json::Value,key:&str,max:usize)->Option<String>{value.get(key)?.as_str().filter(|text|text.len()<=max).map(str::to_string)}
impl Snapshot{
 pub fn project(value:&serde_json::Value,observed_at_ms:u64)->Option<Self>{
  let state=field(value,"state",32)?;
  if !matches!(state.as_str(),"connected"|"reconnecting"|"reauth_required"|"unavailable"){return None;}
  let mut messages:Vec<Message>=value.get("messages").and_then(serde_json::Value::as_array).into_iter().flatten().rev().take(20).filter_map(|item|Some(Message{
   id:field(item,"id",128)?,author:field(item,"author",128)?,color:field(item,"color",32),text:field(item,"text",2048)?,received_at:field(item,"receivedAt",64)?,
  })).collect();messages.reverse();
  let mut snapshot=Self{observed_at_ms,data:Chat{account_connected:value.get("accountConnected")?.as_bool()?,configured:value.get("configured")?.as_bool()?,display_name:field(value,"displayName",128),connected:value.get("connected")?.as_bool()?,state,messages}};
  while serde_json::to_vec(&snapshot).ok()?.len()>8192{if snapshot.data.messages.is_empty(){return None;}snapshot.data.messages.remove(0);}
  Some(snapshot)
 }
 pub fn fresh(&self,now:u64)->bool{self.observed_at_ms<=now&&now-self.observed_at_ms<=5000&&self.data.messages.len()<=20&&serde_json::to_vec(self).is_ok_and(|data|data.len()<=8192)}
}
#[cfg(test)]mod tests{use super::*;use serde_json::json;
 #[test]fn public_chat_is_bounded_fresh_and_drops_ungranted_identity_and_secret_fields(){
  let raw=json!({"accountConnected":true,"configured":true,"connected":true,"state":"connected","displayName":"Channel","accessToken":"private","messages":(0..50).map(|n|json!({"id":n.to_string(),"author":"Viewer","userId":"private-account-id","color":null,"text":"x".repeat(1000),"receivedAt":"2026-10-16T00:00:00Z"})).collect::<Vec<_>>()});
  let snapshot=Snapshot::project(&raw,100).unwrap();let encoded=serde_json::to_string(&snapshot).unwrap();assert!(encoded.len()<=8192);assert!(!encoded.contains("private"));assert!(snapshot.fresh(5100));assert!(!snapshot.fresh(5101));assert!(!snapshot.fresh(99));assert_eq!(snapshot.data.messages.last().unwrap().id,"49");
 }
}
