//! Public OBS observations supplied by the credential-owning host. No account,
//! connection settings, scene policy or game/session identity crosses this API.
use serde::{Deserialize, Serialize};

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
