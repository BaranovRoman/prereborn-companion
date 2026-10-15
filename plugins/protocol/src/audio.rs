//! Opaque playback scope/receipts, independent of game/session algorithms.
use serde::{Serialize, Deserialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Scope { pub instance:String, pub generation:u32, pub epoch:u64, pub session:Option<String> }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Token { pub id:String, pub scope:Scope }
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Status { Queued, Playing, Completed, Cancelled, Unknown }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Fence { pub instance:String, pub generation:u32, pub request_id:String,pub playback_ids:Vec<String> }
impl Token {
    pub fn matches_context(&self, epoch: u64, session: Option<&str>) -> bool {
        self.scope.epoch == epoch && self.scope.session.as_deref() == session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_wire_shape_and_optional_context_are_unchanged() {
        let raw = r#"{"id":"playback","scope":{"instance":"instance","generation":1,"epoch":2,"session":null}}"#;
        let token:Token=serde_json::from_str(raw).unwrap();
        assert_eq!(serde_json::to_string(&token).unwrap(),raw);
        assert!(token.matches_context(2,None));
        assert!(!token.matches_context(3,None));
        assert!(!token.matches_context(2,Some("other")));
        let mut bound=token;bound.scope.session=Some("session".into());
        assert!(bound.matches_context(2,Some("session")));
        assert!(!bound.matches_context(2,None));
        assert!(serde_json::from_str::<Token>(&raw.replace("\"id\":", "\"unexpected\":true,\"id\":")).is_err());
    }
}
