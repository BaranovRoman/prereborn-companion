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
            match_analysis:input.match_context.as_ref().map(|context|crate::match_shadow::analyze(context,&input.snapshot,input.sequence)),
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
#[cfg(test)]
mod blood_grenade_capture_tests {
    use super::*;
    use serde_json::json;
    // Real 0.2.5 item trace (hero demo, Techies): the grenade appears with
    // 2 charges, then one use shows cooldown 0 -> 10 and charges 2 -> 1.
    fn frame(items: serde_json::Value) -> crate::contracts::ReplayGsi {
        crate::projection::project(&json!({"hero":{"id":105},"player":{"activity":"playing"},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"},"items":items})).unwrap()
    }
    /// Frames are (ms, slot0 item or None, stash0 item or None, hero health).
    fn last_grenade(frames: &[(u64, Option<&str>, Option<&str>, i64)]) -> Vec<String> {
        let mut replay = Replay::default();let mut signals = Vec::new();
        for (i, (ms, slot, stash, health)) in frames.iter().enumerate() {
            let item = |name: &Option<&str>| match name { Some(n) => json!({"name":n,"cooldown":0,"charges":1}), None => json!({"name":"empty"}) };
            let raw = json!({"hero":{"id":105,"health":health},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"},"items":{"slot0":item(slot),"stash0":item(stash)}});
            let result = replay.apply(crate::contracts::ReplayInput { sequence: i as u64 + 1, observed_at_ms: *ms, snapshot: crate::projection::project(&raw).unwrap(), context: Default::default(), match_context: None }).unwrap();
            signals.extend(result.sound_signals.into_iter().map(|s| s.id));
        }
        signals
    }
    #[test]
    fn the_last_grenade_counts_only_with_the_health_cost_as_positive_evidence() {
        let g = Some("item_blood_grenade");
        let used = vec!["item_blood_grenade".to_string()];
        assert_eq!(last_grenade(&[(1000,g,None,600),(1100,None,None,525)]), used, "cost in the same frame");
        assert_eq!(last_grenade(&[(1000,g,None,600),(1100,None,None,600),(1500,None,None,525)]), used, "cost in a later frame");
        assert_eq!(last_grenade(&[(1000,g,None,600),(1100,None,None,410)]), used, "extra damage from enemies");
        assert_eq!(last_grenade(&[(1000,g,None,600),(1100,None,None,530)]), used, "a little regeneration");
        assert_eq!(last_grenade(&[(1000,g,None,2),(1100,None,None,1)]), used, "cannot kill: cost capped at health - 1");
        assert!(last_grenade(&[(1000,g,None,600),(1100,None,None,600),(1600,None,None,600)]).is_empty(), "sold or dropped: no health cost");
        assert!(last_grenade(&[(1000,g,None,600),(1100,None,None,590)]).is_empty(), "small chip damage is not the cost");
        assert!(last_grenade(&[(1000,g,None,600),(1100,None,g,500)]).is_empty(), "moved to stash while taking damage");
        assert!(last_grenade(&[(1000,g,None,600),(1100,None,None,600),(2300,None,None,500)]).is_empty(), "health lost after the window");
        assert!(last_grenade(&[(1000,g,None,1),(1100,None,None,1)]).is_empty(), "at 1 HP nothing is decided before the window");
        assert_eq!(last_grenade(&[(1000,g,None,1),(1100,None,None,1),(2200,None,None,1)]), used, "thrown at 1 HP counts once not moved");
        assert!(last_grenade(&[(1000,g,None,1),(1100,None,None,1),(1500,None,g,1),(2200,None,g,1)]).is_empty(), "moved at 1 HP is not a throw");
    }
    #[test]
    fn a_blood_grenade_use_from_the_real_trace_emits_one_item_signal() {
        let mut replay = Replay::default();
        let frames = [
            json!({"slot0":{"name":"empty"},"teleport0":{"name":"item_tpscroll","cooldown":95,"charges":1}}),
            json!({"slot0":{"name":"item_blood_grenade","cooldown":0,"charges":2},"teleport0":{"name":"item_tpscroll","cooldown":93,"charges":1}}),
            json!({"slot0":{"name":"item_blood_grenade","cooldown":10,"charges":1},"teleport0":{"name":"item_tpscroll","cooldown":92,"charges":1}}),
        ];
        let mut signals = Vec::new();
        for (i, items) in frames.into_iter().enumerate() {
            let result = replay.apply(crate::contracts::ReplayInput { sequence: i as u64 + 1, observed_at_ms: (i as u64 + 1) * 1000, snapshot: frame(items), context: Default::default(), match_context: None }).unwrap();
            signals.extend(result.sound_signals.into_iter().map(|s| s.id));
        }
        assert_eq!(signals, vec!["item_blood_grenade".to_string()]);
    }
}
