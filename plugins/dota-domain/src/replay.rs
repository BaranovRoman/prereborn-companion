//! In-memory analysis only. Caller supplies sequence/time; no listener or effect executor.
use serde_json::Value;
use crate::{broadcast_state::{self, BroadcastState}, contracts::*, events::{self, PendingConfirmations}, gsi};

#[derive(Default)]
pub struct Replay {
    previous: Option<Value>, pending: PendingConfirmations, sequence: Option<u64>, time: Option<u64>,
}
impl Replay {
    pub fn apply(&mut self, input: ReplayInput) -> Result<ReplayResult, String> {
        if self.sequence.is_some_and(|s| input.sequence <= s) { return Err("replay_sequence_not_increasing".into()); }
        if self.time.is_some_and(|t| input.observed_at_ms < t) { return Err("replay_time_went_backwards".into()); }
        validate(&input.snapshot)?;
        let value = serde_json::to_value(&input.snapshot).map_err(|e| e.to_string())?;
        let effective = match &self.previous {
            Some(previous) if !events::hero_identity_changed(previous, &value) => Some(previous),
            _ => { self.pending = PendingConfirmations::default(); None }
        };
        // Exact same detector and hero-boundary reset as built-in game_sounds::handle_gsi.
        let (signals, _) = events::detect_events_with_state(effective, &value, input.observed_at_ms, &mut self.pending);
        let parsed = gsi::parse(&value);
        let result = ReplayResult {
            sequence: input.sequence,
            broadcast_state: broadcast_state::resolve(BroadcastState::from_gsi(&value), input.context.session_ended, input.context.manual_summary_override),
            sound_signals: signals.into_iter().map(|e| SoundSignal { kind: e.kind, id: e.id }).collect(),
            in_match: parsed.as_ref().is_some_and(|p| p.is_in_match()), post_game: parsed.as_ref().is_some_and(|p| p.is_post_game()),
            hero_id: parsed.as_ref().and_then(|p| p.hero_id), match_id: parsed.and_then(|p| p.match_id),
            mode: "replay_only", side_effects: false,
        };
        self.previous = Some(value); self.sequence = Some(input.sequence); self.time = Some(input.observed_at_ms);
        Ok(result)
    }
}
fn validate(input: &ReplayGsi) -> Result<(), String> {
    fn text(value: &Option<String>) -> Result<(), String> {
        if value.as_ref().is_some_and(|s| s.len() > 128) { return Err("replay_field_too_long".into()); }
        Ok(())
    }
    if let Some(player) = &input.player { text(&player.activity)?; text(&player.team_name)?; }
    if let Some(map) = &input.map {
        text(&map.game_state)?; text(&map.custom_game_name)?; text(&map.win_team)?;
        if let Some(ScalarId::Text(id)) = &map.matchid { if id.len() > 128 { return Err("replay_field_too_long".into()); } }
    }
    fn signals(map: &std::collections::BTreeMap<String, Signal>) -> Result<(), String> {
        if map.len() > 32 { return Err("too_many_replay_slots".into()); }
        for (slot, signal) in map {
            if slot.len() > 64 || signal.name.as_ref().is_some_and(|s| s.len() > 128) { return Err("replay_field_too_long".into()); }
        }
        Ok(())
    }
    for map in input.items.iter().chain(input.abilities.iter()) { signals(map)?; }
    if let Some(couriers) = &input.couriers {
        if couriers.len() > 8 { return Err("too_many_replay_couriers".into()); }
        for (id, courier) in couriers { if id.len() > 64 { return Err("replay_field_too_long".into()); } signals(&courier.items)?; }
    }
    Ok(())
}
