use companion_dota_domain::{contracts::ReplayInput, replay::Replay, broadcast_state::BroadcastState};
use serde_json::{json, Value};
fn frame(sequence: u64, charges: i64, hero: i64) -> ReplayInput {
    serde_json::from_value(json!({"sequence":sequence,"observedAtMs":sequence*100,
        "snapshot":{"player":{"activity":"playing"},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":42},
        "hero":{"id":hero},"items":{"slot0":{"name":"item_tango","charges":charges}}}})).unwrap()
}
#[test] fn baseline_use_duplicate_relocation_hero_reset_and_summary() {
    let mut replay = Replay::default();
    assert!(replay.apply(frame(1,3,105)).unwrap().sound_signals.is_empty());
    let used = replay.apply(frame(2,2,105)).unwrap();
    assert_eq!(used.sound_signals[0].id,"item_tango"); assert!(used.in_match); assert_eq!(used.match_id.as_deref(),Some("42"));
    assert_eq!(used.broadcast_state,BroadcastState::Gameplay); assert!(!used.side_effects);
    assert!(replay.apply(frame(2,1,105)).is_err());
    assert!(replay.apply(frame(3,1,106)).unwrap().sound_signals.is_empty());
    let mut summary = frame(4,1,106); summary.context.session_ended=true;
    assert_eq!(replay.apply(summary).unwrap().broadcast_state,BroadcastState::PostStream);
}
#[test] fn disappearance_and_time_rollback_never_synthesize_use() {
    let mut replay=Replay::default(); replay.apply(frame(1,1,105)).unwrap();
    let mut missing=frame(2,1,105); missing.snapshot.items=Some(Default::default());
    assert!(replay.apply(missing).unwrap().sound_signals.is_empty());
    let mut late=frame(3,0,105); late.observed_at_ms=1;
    assert_eq!(replay.apply(late).unwrap_err(),"replay_time_went_backwards");
    assert!(replay.apply(frame(3,1,105)).unwrap().sound_signals.is_empty());
}
#[test] fn secrets_and_undeclared_fields_cannot_enter_replay_schema() {
    let baseline=serde_json::to_value(frame(1,3,105)).unwrap();
    for pointer in ["auth", "companionToken", "obsPassword", "backendUrl"] {
        let mut input=baseline.clone(); input["snapshot"][pointer]=json!("secret");
        assert!(serde_json::from_value::<ReplayInput>(input).is_err());
    }
    let mut input=baseline; input["snapshot"]["player"]["steamid"]=Value::String("private-account".into());
    assert!(serde_json::from_value::<ReplayInput>(input).is_err());
}
#[test] fn rejected_oversized_field_does_not_advance_replay_state() {
    let mut replay = Replay::default();
    replay.apply(frame(1,3,105)).unwrap();
    let mut oversized = frame(2,2,105);
    oversized.snapshot.player.as_mut().unwrap().activity = Some("x".repeat(129));
    assert_eq!(replay.apply(oversized).unwrap_err(), "replay_field_too_long");
    assert_eq!(replay.apply(frame(2,2,105)).unwrap().sound_signals[0].id, "item_tango");
}
