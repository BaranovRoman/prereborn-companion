// Temporary, safe TTS pipeline instrumentation (see mod.rs docs for the
// same "passive observer, off unless a diagnostics session is running"
// contract GSI capture already follows). Goal: find where latency
// accumulates between a chat message appearing and its speech actually
// starting, even when the queue is empty and messages arrive sparsely -
// see TwitchChatPage.tsx (frontend stages) and tts.rs (Piper sidecar
// stages) for where these events are produced.
//
// Correlation is by `message_id` with a `source` tag, not a single merged
// record built by one side waiting on the other - the frontend and the
// Piper sidecar each write only the timestamps they directly observe, as
// soon as they observe them. Reading tts-trace.json means grouping by
// message_id after the fact, not joining live. This keeps the
// instrumentation itself from being able to add latency to the very path
// it's measuring (every write here is fire-and-forget on the caller side).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsTraceSource {
    Frontend,
    PiperSidecar,
    SileroSidecar,
}

/// One record per (message_id, source) - e.g. one message that used Piper
/// produces exactly two of these: one written by the frontend (queue/
/// playback timestamps) and one written by the Rust sidecar (synthesis
/// timestamps). `stages` holds named monotonic-ms-since-something
/// timestamps (the exact field names requested: receivedAt, queuedAt,
/// drainPickedAt, synthesisRequestedAt, sidecarWriteAt,
/// synthesisCompletedAt, audioReadyAt, playbackRequestedAt,
/// actualPlaybackStartedAt, playbackEndedAt, ...) - a map rather than a
/// rigid struct because the two sources' stage sets don't overlap and
/// forcing one shared struct would make every record mostly-null.
/// `detail` is free-form additional context that doesn't fit a single
/// timestamp (queue sizes, poll counts, wav byte length, sidecar age, ...).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsTraceEvent {
    pub message_id: String,
    pub source: TtsTraceSource,
    pub local_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub stages: BTreeMap<String, f64>,
    #[serde(skip_serializing_if = "Value::is_null", default)]
    pub detail: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json_with_stage_map_and_detail() {
        let mut stages = BTreeMap::new();
        stages.insert("receivedAt".to_string(), 0.0);
        stages.insert("queuedAt".to_string(), 1.2);
        let event = TtsTraceEvent {
            message_id: "msg-1".to_string(),
            source: TtsTraceSource::Frontend,
            local_time: "2026-08-19T10:00:00+03:00".to_string(),
            engine: Some("piper".to_string()),
            stages,
            detail: serde_json::json!({ "queueSizeAfter": 1 }),
        };
        let json = serde_json::to_string(&event).unwrap();
        let restored: TtsTraceEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.message_id, "msg-1");
        assert_eq!(restored.source, TtsTraceSource::Frontend);
        assert_eq!(restored.stages.get("queuedAt"), Some(&1.2));
        assert_eq!(restored.detail["queueSizeAfter"], serde_json::json!(1));
    }

    #[test]
    fn detail_is_omitted_when_null() {
        let event = TtsTraceEvent {
            message_id: "msg-2".to_string(),
            source: TtsTraceSource::PiperSidecar,
            local_time: "now".to_string(),
            engine: None,
            stages: BTreeMap::new(),
            detail: Value::Null,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("\"detail\""));
        assert!(!json.contains("\"engine\""));
    }
}
