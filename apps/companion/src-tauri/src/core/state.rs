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
}
