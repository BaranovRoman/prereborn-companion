use std::time::Instant;

// Shared account, connectivity and chat data; no game contracts.
#[derive(Debug, Default)]
pub struct CoreState {
    pub log_dir: Option<String>,
    pub obs_config: crate::core::obs_transport::ObsConfig,
    pub obs_connected: bool,
    pub obs_last_error: Option<String>,
    pub obs_streaming: Option<bool>,
    pub obs_streaming_confirmed_at: Option<String>,

    pub companion_token: Option<String>,
    // Whether at least one send attempt has completed (success or failure)
    // since Companion started or since the token was last (re)saved - lets
    // `snapshot()` tell "never checked yet" (Waiting) apart from "checked
    // and it failed" (Recovering/Unavailable), which a single bool cannot.
    pub backend_attempted: bool,
    // Consecutive failed send attempts. Reset to 0 on any success or on
    // token save. Compared against `backend::MAX_RETRY_ATTEMPT` (the same
    // cap the WK-78 backoff itself uses) to distinguish a transient blip
    // (still Recovering) from a sustained outage (Unavailable).
    pub backend_consecutive_failures: u32,
    pub backend_last_sent_at: Option<String>,
    pub backend_last_error: Option<String>,
    // Reliability pass - set the moment `backend_consecutive_failures` goes
    // from 0 to 1 (see backend::record_connectivity), cleared on the next
    // success. Lets a recovery log line report how long the backend was
    // actually degraded, instead of just that it recovered - see the
    // connectivity report for why `backend_state` needed a connectivity
    // signal from more than just the legacy gsi-state heartbeat.
    pub backend_degraded_since: Option<Instant>,
    /// Normalized bounded Twitch chat status returned to the existing Chat
    /// UI. The localhost overlay reuses this cache; it never opens another
    /// Twitch connection.
    pub twitch_chat: Option<serde_json::Value>,
    pub twitch_chat_observed_at_ms: Option<u64>,
    pub twitch_chat_authority: Option<String>,
}

impl CoreState {
    pub fn plugin_chat(&self,now:u64)->Option<companion_plugin_protocol::chat::Snapshot>{
        use sha2::{Digest,Sha256};
        let token=self.companion_token.as_ref()?;
        if self.twitch_chat_authority.as_deref()!=Some(format!("{:x}",Sha256::digest(token.as_bytes())).as_str()){return None;}
        let snapshot=companion_plugin_protocol::chat::Snapshot::project(self.twitch_chat.as_ref()?,self.twitch_chat_observed_at_ms?)?;
        snapshot.fresh(now).then_some(snapshot)
    }
}
#[cfg(test)]mod chat_tests{use super::*;use sha2::{Digest,Sha256};
 #[test]fn an_account_change_or_expired_observation_never_exports_the_old_chat(){
  let mut core=CoreState::default();core.companion_token=Some("original".into());core.twitch_chat_authority=Some(format!("{:x}",Sha256::digest(b"original")));core.twitch_chat_observed_at_ms=Some(100);
  core.twitch_chat=Some(serde_json::json!({"accountConnected":true,"configured":true,"connected":true,"state":"connected","messages":[]}));
  assert!(core.plugin_chat(100).is_some());assert!(core.plugin_chat(5101).is_none());core.companion_token=Some("replacement".into());assert!(core.plugin_chat(100).is_none());core.companion_token=None;assert!(core.plugin_chat(100).is_none());
 }
}
