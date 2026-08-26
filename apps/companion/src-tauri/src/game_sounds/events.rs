use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::{self, ItemSignal};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameSoundEventKind {
    ItemUsed,
    AbilityCast,
}

// Normalized game event handed to the sound reaction engine
// (game_sounds::mod's handle_gsi) - the one boundary the task calls for
// between raw GSI and "a sound should maybe play". `id` is the item/ability
// internal name (already the catalog's own lookup key - see catalog.rs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameSoundEvent {
    pub kind: GameSoundEventKind,
    pub id: String,
}

/// Pure `fn(prev, current) -> Vec<event>` - same idiom as
/// `obs::BroadcastScene::from_gsi` (see obs.rs), so this is unit-testable
/// with plain `json!` fixtures and no AppHandle/IO. `previous` is `None` on
/// the very first tick after Companion starts *and* is deliberately reset to
/// `None` by the caller whenever the hero identity changes (new match/
/// reconnect after a hero swap - see game_sounds::mod's handle_gsi) - both
/// cases must never synthesize events from a diff against a stale or
/// nonexistent baseline, which is exactly what returning early here
/// guarantees.
pub fn detect_events(previous: Option<&Value>, current: &Value) -> Vec<GameSoundEvent> {
    let Some(previous) = previous else {
        return Vec::new();
    };
    let mut events = Vec::new();
    detect_item_events(previous, current, &mut events);
    detect_ability_events(previous, current, &mut events);
    events
}

/// True once `previous`/`current` can no longer be meaningfully diffed
/// against each other - a different hero (new match, or GSI reconnecting
/// mid-swap) makes every item/ability slot comparison meaningless, so the
/// caller must treat this tick as if there were no previous snapshot at all
/// rather than let a stale baseline produce a ghost event.
pub fn hero_identity_changed(previous: &Value, current: &Value) -> bool {
    let prev_id = previous.pointer("/hero/id").and_then(Value::as_i64);
    let curr_id = current.pointer("/hero/id").and_then(Value::as_i64);
    match (prev_id, curr_id) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    }
}

fn item_slots(payload: &Value) -> Vec<(String, Value)> {
    payload
        .get("items")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(slot, value)| (slot.clone(), value.clone()))
        .collect()
}

fn detect_item_events(previous: &Value, current: &Value, events: &mut Vec<GameSoundEvent>) {
    // A tick where the `items` section is missing entirely (e.g. GSI
    // briefly stops sending it around a match ending/menu transition) must
    // never be read as "every previously-held item just got consumed" -
    // that's exactly the kind of undiscoverable transition the task says to
    // skip rather than guess at. Only diffed when this tick actually says
    // something about items; a per-slot "empty" (items present, this one
    // slot genuinely emptied) is unaffected and still detected below.
    if current.get("items").and_then(Value::as_object).is_none() {
        return;
    }
    let previous_slots = item_slots(previous);
    let current_slots = item_slots(current);
    // Union of slot keys from both snapshots, not just current's - a
    // ChargesOrConsumed item that's fully used up disappears from its slot
    // entirely (current reports "empty"), so the transition only shows up
    // by also looking at what *previous* had there.
    let mut slot_keys: Vec<&str> = previous_slots.iter().chain(current_slots.iter()).map(|(s, _)| s.as_str()).collect();
    slot_keys.sort_unstable();
    slot_keys.dedup();

    for slot in slot_keys {
        let previous_item = previous_slots.iter().find(|(s, _)| s == slot).map(|(_, v)| v);
        let current_item = current_slots.iter().find(|(s, _)| s == slot).map(|(_, v)| v);
        let Some(previous_item) = previous_item else { continue };
        let Some(previous_name) = previous_item.get("name").and_then(Value::as_str) else { continue };
        if previous_name == "empty" {
            continue;
        }
        let Some(catalog_entry) = catalog::find_item(previous_name) else { continue };
        if !catalog_entry.supported {
            continue;
        }
        let current_name = current_item.and_then(|v| v.get("name")).and_then(Value::as_str);

        let used = match catalog_entry.signal {
            Some(ItemSignal::Cooldown) => {
                // Cooldown items are never consumed from the slot - only a
                // same-item cooldown-start transition counts.
                if current_name != Some(previous_name) {
                    false
                } else {
                    let current_item = current_item.expect("current_name implies current_item exists");
                    let prev_cd = previous_item.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
                    let curr_cd = current_item.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
                    prev_cd <= 0.0 && curr_cd > 0.0
                }
            }
            Some(ItemSignal::ChargesOrConsumed) => {
                if current_name == Some(previous_name) {
                    let current_item = current_item.expect("current_name implies current_item exists");
                    let prev_charges = previous_item.get("charges").and_then(Value::as_i64);
                    let curr_charges = current_item.get("charges").and_then(Value::as_i64);
                    matches!((prev_charges, curr_charges), (Some(prev), Some(curr)) if curr < prev)
                } else {
                    // The item left this slot entirely (current is "empty",
                    // missing, or - conservatively - anything else). Only
                    // "genuinely gone" (empty/missing) counts as a use; a
                    // *different* item now occupying the slot is a
                    // sell/swap, not a use, and is excluded below.
                    matches!(current_name, None | Some("empty"))
                }
            }
            None => false,
        };

        if used {
            events.push(GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: previous_name.to_string() });
        }
    }
}

fn ability_slots(payload: &Value) -> Vec<(String, Value)> {
    payload
        .get("abilities")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(slot, value)| (slot.clone(), value.clone()))
        .collect()
}

fn detect_ability_events(previous: &Value, current: &Value, events: &mut Vec<GameSoundEvent>) {
    let previous_slots = ability_slots(previous);
    for (slot, current_ability) in ability_slots(current) {
        let Some(name) = current_ability.get("name").and_then(Value::as_str) else { continue };
        let Some(catalog_entry) = catalog::find_ability(name) else { continue };
        if !catalog_entry.supported {
            continue;
        }
        let Some(previous_ability) = previous_slots.iter().find(|(s, _)| *s == slot).map(|(_, v)| v) else { continue };
        let previous_name = previous_ability.get("name").and_then(Value::as_str);
        if previous_name != Some(name) {
            continue;
        }

        // Only signal this repo can defend without a real capture: cooldown
        // going from "not on cooldown" to "on cooldown" - see catalog.rs's
        // module doc comment and the WK-106 research report. Every ability
        // in the catalog with `supported: true` was hand-picked specifically
        // because it has a real, non-zero cooldown (see the reasons attached
        // to each unsupported entry for the abilities this deliberately
        // excludes: toggles/passives with no such transition).
        let prev_cd = previous_ability.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
        let curr_cd = current_ability.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
        if prev_cd <= 0.0 && curr_cd > 0.0 {
            events.push(GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: name.to_string() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with_hero(hero_id: i64, extra: Value) -> Value {
        let mut payload = json!({ "hero": { "id": hero_id } });
        if let (Some(obj), Some(extra_obj)) = (payload.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        payload
    }

    #[test]
    fn initial_snapshot_never_emits_an_event() {
        let current = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } }));
        assert!(detect_events(None, &current).is_empty());
    }

    #[test]
    fn item_charge_transition_emits_exactly_one_item_used_event() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } }));
        let events = detect_events(Some(&prev), &curr);
        assert_eq!(events, vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_tango".into() }]);
    }

    #[test]
    fn repeated_identical_snapshot_does_not_emit_a_second_event() {
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } }));
        // Same snapshot compared against itself - no charge drop happened.
        assert!(detect_events(Some(&curr), &curr).is_empty());
    }

    #[test]
    fn consumed_single_charge_item_disappearing_from_the_slot_emits_one_event() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_flask" } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));
        let events = detect_events(Some(&prev), &curr);
        assert_eq!(events, vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_flask".into() }]);
    }

    #[test]
    fn item_cooldown_starting_emits_one_event() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_blink", "cooldown": 0 } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "item_blink", "cooldown": 12 } } }));
        let events = detect_events(Some(&prev), &curr);
        assert_eq!(events, vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_blink".into() }]);
    }

    #[test]
    fn item_cooldown_still_counting_down_does_not_emit_a_second_event() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_blink", "cooldown": 12 } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "item_blink", "cooldown": 9 } } }));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn unsupported_item_never_emits_an_event() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_yasha" } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn unknown_item_not_in_the_catalog_never_emits_an_event() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_totally_unknown", "charges": 2 } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "item_totally_unknown", "charges": 1 } } }));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn a_different_item_now_in_the_slot_is_not_treated_as_a_use() {
        // slot0 went from Tango to Healing Salve - a purchase/swap, not a use.
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "item_flask" } } }));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn items_section_missing_entirely_is_not_treated_as_every_held_item_being_used() {
        // A tick where Dota's GSI payload simply omits `items` (e.g. around
        // a match ending/menu transition) must never be read as "every
        // previously-held item just got consumed" - it carries no
        // information about items at all, so nothing can be proven.
        let prev = with_hero(1, json!({
            "items": {
                "slot0": { "name": "item_tango", "charges": 2 },
                "slot1": { "name": "item_flask" }
            }
        }));
        let curr = with_hero(1, json!({}));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn ability_cooldown_transition_emits_one_ability_cast_event() {
        let prev = with_hero(1, json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 0 } } }));
        let curr = with_hero(1, json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 13 } } }));
        let events = detect_events(Some(&prev), &curr);
        assert_eq!(events, vec![GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "pudge_meat_hook".into() }]);
    }

    #[test]
    fn repeated_cooldown_snapshot_does_not_duplicate_the_ability_event() {
        let prev = with_hero(1, json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 13 } } }));
        let curr = with_hero(1, json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 13 } } }));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn ambiguous_toggle_ability_with_no_cooldown_is_never_reported_as_a_cast() {
        // pudge_rot is catalogued unsupported precisely because it has no
        // cooldown - a bare on/off `level`/state change must never surface
        // as ability.cast even if some other field flips.
        let prev = with_hero(1, json!({ "abilities": { "ability0": { "name": "pudge_rot", "cooldown": 0, "level": 1 } } }));
        let curr = with_hero(1, json!({ "abilities": { "ability0": { "name": "pudge_rot", "cooldown": 0, "level": 2 } } }));
        assert!(detect_events(Some(&prev), &curr).is_empty());
    }

    #[test]
    fn reconnect_after_a_hero_swap_is_flagged_so_the_caller_resets_its_baseline() {
        let previous_match = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } }));
        let new_match = with_hero(2, json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } }));
        assert!(hero_identity_changed(&previous_match, &new_match));
    }

    #[test]
    fn same_hero_across_ticks_is_not_flagged_as_identity_change() {
        let a = with_hero(1, json!({}));
        let b = with_hero(1, json!({}));
        assert!(!hero_identity_changed(&a, &b));
    }

    #[test]
    fn reconnect_ghost_event_is_avoided_by_treating_a_reset_baseline_as_no_previous() {
        // Simulates game_sounds::mod's handle_gsi: hero swapped, so the
        // caller passes None instead of the stale previous snapshot -
        // detect_events itself is what guarantees no event comes out of it.
        let stale_previous = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } }));
        let new_match_first_tick = with_hero(2, json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } }));
        assert!(hero_identity_changed(&stale_previous, &new_match_first_tick));
        assert!(detect_events(None, &new_match_first_tick).is_empty());
    }
}
