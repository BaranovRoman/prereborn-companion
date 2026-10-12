//! Dota IPC domain API v1. Replay is implemented; LiveCoreRequest is a design contract only.
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use crate::{broadcast_state::BroadcastState, events::GameSoundEventKind};

pub const DOTA_API: u32 = 1;
pub const PLUGIN_ID: &str = "dota2";
pub const REPLAY_COMMAND: &str = "dota.replay";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayContext { #[serde(default, skip_serializing_if = "Option::is_none")] pub observer_session: Option<u64>, pub session_ended: bool, pub manual_summary_override: bool }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayInput {
    pub sequence: u64, pub observed_at_ms: u64, pub snapshot: ReplayGsi,
    #[serde(default)] pub context: ReplayContext,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayGsi {
    #[serde(skip_serializing_if = "Option::is_none")] pub player: Option<Player>,
    #[serde(skip_serializing_if = "Option::is_none")] pub map: Option<Map>,
    #[serde(skip_serializing_if = "Option::is_none")] pub hero: Option<Hero>,
    #[serde(skip_serializing_if = "Option::is_none")] pub items: Option<BTreeMap<String, Signal>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub abilities: Option<BTreeMap<String, Signal>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub couriers: Option<BTreeMap<String, Courier>>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Player { pub activity: Option<String>, pub team_name: Option<String>, pub kills: Option<i64>, pub deaths: Option<i64>, pub assists: Option<i64> }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Map { pub game_state: Option<String>, pub matchid: Option<ScalarId>, #[serde(rename = "customgamename", alias = "custom_game_name")] pub custom_game_name: Option<String>, pub win_team: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ScalarId { Text(String), Number(u64) }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hero { pub id: Option<i64> }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signal { pub name: Option<String>, pub cooldown: Option<f64>, pub charges: Option<i64> }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Courier { pub items: BTreeMap<String, Signal> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSignal { pub kind: GameSoundEventKind, pub id: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResult {
    pub sequence: u64, pub broadcast_state: BroadcastState, pub sound_signals: Vec<SoundSignal>,
    pub in_match: bool, pub post_game: bool, pub hero_id: Option<i64>, pub match_id: Option<String>,
    pub mode: &'static str, pub side_effects: bool,
}

// Legacy iteration-4 candidates. Versioned, bounded envelopes/acknowledgements now live in effects.rs.
// Proposed capabilities for a later exclusive live handover. NONE are dispatched in iteration 4.
// The core owns credential lookup, scene mapping/transport, SQLite transactions/outbox,
// deduplication and endpoint serialization. No raw SQL, URL, password or bearer token crosses IPC.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum LiveCoreRequest {
    ObsScene { sequence: u64, state: BroadcastState },
    Sound { sequence: u64, event_id: String },
    Notification { sequence: u64, text: String },
    HistoryRead { limit: u16 },
    MatchTransition { sequence: u64, match_id: String, transition: MatchTransition },
    BackendSync { sequence: u64, match_id: String },
    OverlayPublish { sequence: u64, state: BroadcastState },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchTransition { Observed, PostGamePending, Interrupted, Finalized }
