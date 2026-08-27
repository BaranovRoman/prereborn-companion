// WK-107 forensic writeup - source: a real production diagnostics export
// (Companion 0.5.29, Dota 2 "Hero Demo Tool" session, Techies + Tango +
// Blood Grenade), the first real GSI capture this feature has ever been
// checked against. Every transition below is copied from the capture's
// `diffs/*.json`, not inferred.
//
// item_tango (slot0, `ItemSignal::ChargesOrConsumed`): charges 3 -> 2, no
// cooldown field ever appears. Confirms the WK-106 signal exactly as
// implemented - already live in production (0.5.29) before this capture.
//
// item_blood_grenade (slot1, `ItemSignal::ChargesOrConsumed`): charges 1 ->
// 2 once (a regen tick, correctly ignored - `curr < prev` is false), then
// on real use: can_cast true->false, charges 2->1, cooldown 0->10,
// max_cooldown 0->11, all in the same tick. `charges` decreasing is the
// only field ChargesOrConsumed checks, so the simultaneous cooldown start
// needed no detector change - only a new catalog entry.
//
// techies_sticky_bomb / techies_suicide ("Blast Off!") (`AbilitySignal::
// Cooldown`): both show a plain 0 -> N cooldown start on cast
// (0->7/0->8 max_cooldown, and 0->25/0->26 max_cooldown respectively) and
// tick back down on recovery with no repeat event - confirms WK-106's
// original ability signal unchanged.
//
// techies_land_mines ("Proximity Mines", `AbilitySignal::Charges`): never
// shows a `cooldown` change at all - it's charge-gated
// (`charges`/`charge_cooldown`/`max_charges`). The real cast is
// charge_cooldown 0->15 with charges 3->2 in the same tick. A cooldown-only
// detector could never have found this ability - this is the one real gap
// the capture found in WK-106's generic ability detector.
//
// techies_reactive_tazer (`AbilitySignal::ToggleActivateRename`): no
// cooldown pulse at all (stays 0) - GSI instead renames the ability slot's
// own `name` from "techies_reactive_tazer" to "techies_reactive_tazer_stop"
// while toggled active (max_cooldown ticks 0->1, not itself used as a
// signal). This is the second real gap: the original detector required
// `previous_name == current_name` to consider *any* transition, so a
// same-slot rename was invisible to it by construction. Fixed via
// `catalog::canonicalize_ability_name` (treats the "_stop" variant as the
// same ability) plus this signal (fires only on the confirmed base->alias
// direction). The reverse (deactivation) rename was never observed in this
// short capture and is deliberately left undetected rather than guessed at.
//
// level-up transitions (e.g. ability0/ability1 level 0->4, ability3 level
// 0->3, via the Hero Demo tool's auto-level) never coincide with a
// cooldown/charges change in the same tick in this capture, and none of the
// three signals above look at `level` at all - confirmed to never fire.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::{self, AbilitySignal, ItemSignal};

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
                let prev_charges = previous_item.get("charges").and_then(Value::as_i64);
                if current_name == Some(previous_name) {
                    let current_item = current_item.expect("current_name implies current_item exists");
                    let curr_charges = current_item.get("charges").and_then(Value::as_i64);
                    matches!((prev_charges, curr_charges), (Some(prev), Some(curr)) if curr < prev)
                } else {
                    // The item left this slot entirely (current is "empty",
                    // missing, or - conservatively - anything else). Only
                    // "genuinely gone" (empty/missing) counts as a use; a
                    // *different* item now occupying the slot is a
                    // sell/swap, not a use, and is excluded below.
                    //
                    // WK-107 self-review - a charge-tracked item that drains
                    // to 0 and only *then* disappears from its slot on a
                    // later tick would otherwise fire twice for the same
                    // real use: once when charges hit 0 (the branch above,
                    // on an earlier tick), and again here when the slot
                    // empties. `prev_charges > 0` (or absent entirely, for
                    // single-instance consumables that never carry a
                    // `charges` field at all - see the test below) is
                    // required so a charge reaching 0 is the one and only
                    // moment that gets reported; the slot vanishing
                    // afterward is just cleanup, not a second use.
                    matches!(current_name, None | Some("empty")) && prev_charges.map_or(true, |charges| charges > 0)
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

// WK-107 - previous_name/current_name are compared through
// `canonicalize_ability_name` (identity for every ability except the one
// confirmed Reactive Tazer alias, see catalog.rs) so a toggle-rename inside
// the same slot is recognized as a continuation of the same ability, not as
// "a different ability now occupies this slot".
fn detect_ability_events(previous: &Value, current: &Value, events: &mut Vec<GameSoundEvent>) {
    let previous_slots = ability_slots(previous);
    for (slot, current_ability) in ability_slots(current) {
        let Some(raw_current_name) = current_ability.get("name").and_then(Value::as_str) else { continue };
        let canonical_id = catalog::canonicalize_ability_name(raw_current_name);
        let Some(catalog_entry) = catalog::find_ability(canonical_id) else { continue };
        if !catalog_entry.supported {
            continue;
        }
        let Some(previous_ability) = previous_slots.iter().find(|(s, _)| *s == slot).map(|(_, v)| v) else { continue };
        let Some(raw_previous_name) = previous_ability.get("name").and_then(Value::as_str) else { continue };
        if catalog::canonicalize_ability_name(raw_previous_name) != canonical_id {
            continue;
        }

        let used = match catalog_entry.signal {
            // Cooldown going from "not on cooldown" to "on cooldown" - the
            // WK-106 signal, confirmed unchanged by the WK-107 capture for
            // every ability that still uses it (e.g. Techies' Sticky Bomb,
            // Blast Off!).
            Some(AbilitySignal::Cooldown) => {
                let prev_cd = previous_ability.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
                let curr_cd = current_ability.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
                prev_cd <= 0.0 && curr_cd > 0.0
            }
            // WK-107 - charge-based ultimate (Techies' Proximity Mines):
            // `cooldown` never changes, a cast is a `charges` decrease
            // instead. Mirrors ItemSignal::ChargesOrConsumed's charges
            // check - see events::detect_item_events.
            Some(AbilitySignal::Charges) => {
                let prev_charges = previous_ability.get("charges").and_then(Value::as_i64);
                let curr_charges = current_ability.get("charges").and_then(Value::as_i64);
                matches!((prev_charges, curr_charges), (Some(prev), Some(curr)) if curr < prev)
            }
            // WK-107 - toggle ability whose GSI `name` itself flips to the
            // confirmed "active" alias (Techies' Reactive Tazer). Fires
            // exactly once, on the confirmed activation direction (raw name
            // changes from the base name to the alias). The reverse
            // (deactivation rename) isn't proven by the capture this is
            // based on, so it deliberately does not fire here either -
            // `raw_previous_name != raw_current_name` alone is not enough,
            // it must specifically land on the known alias.
            Some(AbilitySignal::ToggleActivateRename) => {
                raw_previous_name != raw_current_name
                    && catalog_entry.toggle_active_alias == Some(raw_current_name)
            }
            None => false,
        };

        if used {
            events.push(GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: canonical_id.to_string() });
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

    // WK-107 self-review - a charge-tracked item draining to 0 and only
    // *then* disappearing from its slot on a later tick must not fire twice
    // for the same real use (once when charges hit 0, again when the slot
    // empties).
    #[test]
    fn charge_reaching_zero_then_the_slot_emptying_on_a_later_tick_fires_only_once() {
        let holding_one_charge = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } }));
        let charges_hit_zero = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 0 } } }));
        let slot_now_empty = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));

        let first_tick = detect_events(Some(&holding_one_charge), &charges_hit_zero);
        assert_eq!(first_tick, vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_tango".into() }]);

        // The slot clearing out on a later tick is cleanup, not a second use.
        let second_tick = detect_events(Some(&charges_hit_zero), &slot_now_empty);
        assert!(second_tick.is_empty());
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

    // WK-107 - regression tests built from the exact before/after values in
    // the real production diagnostics capture this feature is now based on
    // (see the module doc comment above for the full forensic writeup and
    // source citation). Hero id 105 is Techies' real GSI hero.id from that
    // capture. Every `json!` fixture below is a sanitized/trimmed copy of
    // the capture's actual field values, not an invented shape.
    mod wk107_capture_confirmed {
        use super::*;

        #[test]
        fn blood_grenade_use_is_exactly_one_item_used_event() {
            let prev = with_hero(
                105,
                json!({ "items": { "slot1": { "name": "item_blood_grenade", "can_cast": true, "charges": 2, "cooldown": 0, "max_cooldown": 0 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "items": { "slot1": { "name": "item_blood_grenade", "can_cast": false, "charges": 1, "cooldown": 10, "max_cooldown": 11 } } }),
            );
            assert_eq!(
                detect_events(Some(&prev), &curr),
                vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_blood_grenade".into() }]
            );
        }

        #[test]
        fn blood_grenade_charge_regen_tick_does_not_fire() {
            // Real capture: charges 1 -> 2 (a regen tick, not a use).
            let prev = with_hero(105, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1 } } }));
            let curr = with_hero(105, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 2 } } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        #[test]
        fn blood_grenade_cooldown_recovering_all_the_way_to_zero_never_fires_a_second_event() {
            // charges stays at 1 throughout (only the cooldown counts down,
            // exactly as the real capture shows for the ticks it covers:
            // 10 -> 9 -> 8 -> 7; extended here to a full 10 -> 0 recovery -
            // ChargesOrConsumed never even looks at `cooldown`, so this is
            // the same mechanism the capture already confirms, not a new
            // unproven assumption).
            let cooldowns = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
            for window in cooldowns.windows(2) {
                let prev = with_hero(
                    105,
                    json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": window[0] } } }),
                );
                let curr = with_hero(
                    105,
                    json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": window[1] } } }),
                );
                assert!(detect_events(Some(&prev), &curr).is_empty(), "cooldown {} -> {} must not fire", window[0], window[1]);
            }
        }

        #[test]
        fn techies_sticky_bomb_cast_is_exactly_one_ability_cast_event() {
            let prev = with_hero(
                105,
                json!({ "abilities": { "ability0": { "name": "techies_sticky_bomb", "can_cast": true, "cooldown": 0, "max_cooldown": 0, "level": 4 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability0": { "name": "techies_sticky_bomb", "can_cast": false, "cooldown": 7, "max_cooldown": 8, "level": 4 } } }),
            );
            assert_eq!(
                detect_events(Some(&prev), &curr),
                vec![GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "techies_sticky_bomb".into() }]
            );
        }

        #[test]
        fn techies_blast_off_cast_is_exactly_one_ability_cast_event() {
            let prev = with_hero(
                105,
                json!({ "abilities": { "ability2": { "name": "techies_suicide", "can_cast": true, "cooldown": 0, "max_cooldown": 0 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability2": { "name": "techies_suicide", "can_cast": false, "cooldown": 25, "max_cooldown": 26 } } }),
            );
            assert_eq!(
                detect_events(Some(&prev), &curr),
                vec![GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "techies_suicide".into() }]
            );
        }

        #[test]
        fn techies_proximity_mines_cast_is_exactly_one_ability_cast_event() {
            // Real capture: charge-based ultimate - `cooldown` never
            // changes, the cast signal is `charges` decreasing.
            let prev = with_hero(
                105,
                json!({ "abilities": { "ability3": { "name": "techies_land_mines", "can_cast": true, "cooldown": 0, "charges": 3, "charge_cooldown": 0, "max_charges": 3 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability3": { "name": "techies_land_mines", "can_cast": true, "cooldown": 0, "charges": 2, "charge_cooldown": 15, "max_charges": 3 } } }),
            );
            assert_eq!(
                detect_events(Some(&prev), &curr),
                vec![GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "techies_land_mines".into() }]
            );
        }

        #[test]
        fn techies_reactive_tazer_activation_rename_is_exactly_one_ability_cast_event() {
            // Real capture: no cooldown pulse at all - GSI renames the slot
            // from the base name to the "_stop" variant while active.
            let prev = with_hero(
                105,
                json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer", "can_cast": true, "cooldown": 0, "max_cooldown": 0 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer_stop", "can_cast": true, "cooldown": 0, "max_cooldown": 1 } } }),
            );
            assert_eq!(
                detect_events(Some(&prev), &curr),
                vec![GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "techies_reactive_tazer".into() }]
            );
        }

        #[test]
        fn repeated_active_tazer_tick_does_not_duplicate_the_cast_event() {
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer_stop", "can_cast": true, "cooldown": 0, "max_cooldown": 1 } } }),
            );
            assert!(detect_events(Some(&curr), &curr).is_empty());
        }

        #[test]
        fn tazer_deactivation_rename_back_to_the_base_name_does_not_fire_a_second_sound() {
            // задача: "не воспроизводи второй звук только из-за rename". The
            // reverse direction isn't proven by the capture either, so it's
            // deliberately not modeled - this pins that it stays silent.
            let prev = with_hero(
                105,
                json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer_stop", "can_cast": true, "cooldown": 0, "max_cooldown": 1 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer", "can_cast": true, "cooldown": 0, "max_cooldown": 0 } } }),
            );
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        #[test]
        fn learning_an_ability_level_up_alone_never_fires_a_cast() {
            // Real capture: Hero Demo auto-levels abilities (level 0 -> N)
            // with no cooldown/charges change in the same tick.
            let prev = with_hero(
                105,
                json!({ "abilities": { "ability0": { "name": "techies_sticky_bomb", "can_cast": false, "cooldown": 0, "level": 0 } } }),
            );
            let curr = with_hero(
                105,
                json!({ "abilities": { "ability0": { "name": "techies_sticky_bomb", "can_cast": true, "cooldown": 0, "level": 4 } } }),
            );
            assert!(detect_events(Some(&prev), &curr).is_empty());

            let prev_mines = with_hero(105, json!({ "abilities": { "ability3": { "name": "techies_land_mines", "can_cast": false, "cooldown": 0, "level": 0 } } }));
            let curr_mines = with_hero(
                105,
                json!({ "abilities": { "ability3": { "name": "techies_land_mines", "can_cast": true, "cooldown": 0, "level": 3, "charges": 3, "charge_cooldown": 0, "max_charges": 3 } } }),
            );
            assert!(detect_events(Some(&prev_mines), &curr_mines).is_empty());
        }

        #[test]
        fn techies_abilities_never_fire_on_the_initial_snapshot_or_after_a_reconnect() {
            let curr = with_hero(
                105,
                json!({
                    "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 10 } },
                    "abilities": {
                        "ability0": { "name": "techies_sticky_bomb", "cooldown": 7 },
                        "ability1": { "name": "techies_reactive_tazer_stop", "cooldown": 0 },
                        "ability3": { "name": "techies_land_mines", "charges": 2, "charge_cooldown": 15 }
                    }
                }),
            );
            assert!(detect_events(None, &curr).is_empty());

            // Reconnect after a hero swap - same guarantee via hero_identity_changed.
            let previous_other_hero = with_hero(1, json!({}));
            assert!(hero_identity_changed(&previous_other_hero, &curr));
        }
    }
}
