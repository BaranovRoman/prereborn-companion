//! Public OBS observations supplied by the credential-owning host. No account,
//! connection settings, scene policy or game/session identity crosses this API.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Signed mapping metadata: semantics/default labels belong to the package.
/// A legacy field can reference only a public, non-credential extension.
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Binding{pub legacy_field:String,pub default_scene:String}
impl Binding{
 pub fn validate(&self)->Result<(),String>{
  let field=&self.legacy_field;
  if field.is_empty()||field.len()>64||!field.bytes().all(|b|b.is_ascii_lowercase()||b==b'_')||matches!(field.as_str(),"host"|"port"|"enabled"|"password")||["token","password","secret","credential","auth","cookie","key"].iter().any(|s|field.contains(s))||self.default_scene.is_empty()||self.default_scene.len()>256||self.default_scene.chars().any(char::is_control){return Err("obs_binding_denied".into());}Ok(())
 }
}

/// Semantic mappings and fresh public transport truth only. Credentials remain
/// in Companion. Plugins choose their own semantics, not a websocket method.
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SceneObservation{
 pub observed_at_ms:u64,pub config_revision:String,pub enabled:bool,
 pub bindings:BTreeMap<String,String>,pub current_scene:Option<String>,pub scenes:Vec<String>,pub streaming:Option<bool>,
}
impl SceneObservation{
 pub fn fresh(&self,now:u64)->bool{now>=self.observed_at_ms&&now-self.observed_at_ms<=3000}
 pub fn validate(&self)->Result<(),String>{
  let name=|s:&str|!s.is_empty()&&s.len()<=256&&!s.chars().any(char::is_control);
  if self.config_revision.len()!=64||!self.config_revision.bytes().all(|b|b.is_ascii_hexdigit())||self.bindings.len()>16||self.bindings.iter().any(|(k,v)|k.is_empty()||k.len()>64||!k.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')||(!v.is_empty()&&!name(v)))||self.scenes.len()>128||self.scenes.iter().any(|s|!name(s))||self.current_scene.as_ref().is_some_and(|s|!name(s)){return Err("obs_observation_invalid".into());}Ok(())
 }
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SceneIntent{pub operation_key:String,pub semantic:String,pub config_revision:String,pub context:Option<String>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SceneReceipt{pub operation_key:String,pub status:crate::audio::Status}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamObservation {
    pub observed_at_ms: u64,
    pub streaming: Option<bool>,
}
impl StreamObservation {
    /// An unavailable or old observation is UNKNOWN, never a stream-stop event.
    pub fn fresh_streaming(&self, now_ms: u64) -> Option<bool> {
        if self.observed_at_ms > now_ms || now_ms - self.observed_at_ms > 2000 {
            None
        } else {
            self.streaming
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fresh_authoritative_values_can_drive_lifecycle() {
        for streaming in [Some(true), Some(false), None] {
            let observation = StreamObservation { observed_at_ms: 10000, streaming };
            assert_eq!(observation.fresh_streaming(10000), streaming);
            assert_eq!(observation.fresh_streaming(12000), streaming);
            assert_eq!(observation.fresh_streaming(12001), None);
            assert_eq!(observation.fresh_streaming(9999), None);
        }
        assert!(serde_json::from_value::<StreamObservation>(serde_json::json!({
            "observedAtMs": 10000, "streaming": true, "password": "forbidden"
        })).is_err());
    }
}
