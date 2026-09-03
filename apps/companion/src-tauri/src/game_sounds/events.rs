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
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::{self, AbilitySignal, AbilityStatus, ItemSignal};

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

/// Convenience wrapper for callers (and the many tests) that don't care
/// about item-vanish reconciliation diagnostics (see `PendingConfirmations`)
/// - a fresh, empty window state every call. Every signal that can actually
/// emit an event (cooldown start, same-slot charges decrease, ability
/// casts) is decided from a single previous/current pair exactly as before,
/// so this remains a fully correct entry point for those - it just can't
/// observe multi-tick reconciliation *diagnostics*, which never affect
/// whether an event fires anyway (see `detect_item_events`'s "ABSENCE IS
/// NOT EVIDENCE" doc comment).
pub fn detect_events(previous: Option<&Value>, current: &Value) -> Vec<GameSoundEvent> {
    let mut pending = PendingConfirmations::default();
    detect_events_with_state(previous, current, 0, &mut pending).0
}

/// The real entry point `game_sounds::mod::handle_gsi` uses - identical to
/// `detect_events` except it threads a caller-owned `PendingConfirmations`
/// (persisted in `AppState`, reset on hero-identity change) and the current
/// wall-clock time through, purely so item-vanish reconciliation
/// diagnostics (see `PendingNote`) can span multiple real GSI ticks -
/// **this has no effect on which events fire**, only on the accuracy of the
/// forensic log `handle_gsi` writes. `previous` being `None` (first tick
/// ever, or the caller having just reset it after a hero swap - see
/// `hero_identity_changed`) must never synthesize an event from a stale or
/// nonexistent baseline, so item/ability detection is skipped entirely on
/// such a tick, exactly like the old two-argument function.
///
/// Returns `(events, pending_notes)` - `pending_notes` is diagnostics-only
/// (see `PendingNote`), describing any pending-candidate lifecycle change
/// this tick caused, for `handle_gsi`'s rolling-log breadcrumb.
pub fn detect_events_with_state(
    previous: Option<&Value>,
    current: &Value,
    now_ms: u64,
    pending: &mut PendingConfirmations,
) -> (Vec<GameSoundEvent>, Vec<PendingNote>) {
    let mut events = Vec::new();
    let mut notes = Vec::new();
    if let Some(previous) = previous {
        detect_item_events(previous, current, now_ms, pending, &mut events, &mut notes);
        detect_ability_events(previous, current, &mut events);
    }
    (events, notes)
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

// WK-138 audit finding, superseding part of the WK-108/WK-109 design below,
// itself revised once more after a first-pass fix was correctly rejected
// (see the "absence is not evidence" note further down).
//
// WK-108's original root-cause diagnosis was correct (GSI's `items` section
// has no stable per-instance identity, so a slot-level diff alone cannot
// tell "consumed" apart from "moved elsewhere"), but its fix and WK-109's
// follow-up fix both only ever looked at the *same* GSI tick's snapshot to
// rule out a relocation. Two concrete gaps that leaves open, found by
// re-auditing this function against real production reports of false
// Blood Grenade sounds on selling, buying, and courier transitions:
//
// 1. There is no guarantee a relocation's source-slot-clears and
//    destination-slot-fills land in the exact same GSI payload - ordinary
//    hero<->backpack<->stash bookkeeping can legitimately straddle two
//    ticks. A same-tick-only check reads that as "vanished with no trace",
//    i.e. exactly the shape this function treats as a use.
// 2. Courier state is NOT part of the `items` section Dota 2 GSI sends at
//    all - it's a separate, additively-enabled `"couriers"` data section
//    (see gsi/config.rs). WK-108's own test fixture used a `"courier0"`
//    key *inside* `items` to model "item arrived at courier" - that shape
//    was never confirmed against real GSI and was fictional. The real
//    `couriers` schema (courier health/position/owner plus a nested
//    `items.item<N>.name` map) is confirmed here against the long-
//    maintained, widely-used community GSI client antonpup/Dota2GSI's
//    `Courier`/`CourierItem` node classes - a well-established third-party
//    reference, not a guess - and is now parsed (see `courier_item_names`
//    below).
//
// ABSENCE IS NOT EVIDENCE - the critical correction this function's first
// WK-138 revision got wrong. That revision replaced the same-tick-only
// fallback with a bounded timer: if an ambiguous vanish didn't reappear
// anywhere within a short window, it was confirmed as "used". That is
// still absence-based inference - it just delays the same invalid leap
// ("we haven't seen it in N ms" -> "therefore it was consumed") instead of
// removing it. It fails exactly the cases it was meant to fix: a courier
// carry longer than the window, or selling the last charge, both still
// vanish-and-never-reappear and would still have fired a false "used".
//
// The corrected model: a same-slot charges decrease remains the ONLY
// signal that ever emits `ItemUsed` for a `ChargesOrConsumed` item - it is
// real positive evidence (the item provably still exists, one fewer charge
// than before) and requires no inference about anything absent. A vanish
// with no same-slot decrease is *never* treated as use, at any point, no
// matter how long it stays unexplained - `PendingConfirmations` still
// tracks it, but purely to enrich diagnostics (did it later show up
// somewhere - `items` OR now `couriers` - explaining the vanish, or did it
// stay unexplained) for the eventual real-Dota capture this feature still
// needs. Expiry discards a candidate silently; it never manufactures an
// event. This is a deliberate, accepted false-negative for two real cases
// current GSI evidence cannot resolve any other way:
//   - a real courier carry, however long, since courier cargo is
//     observable *while the courier still holds the item*, but this
//     function has no way to prove a courier round-trip is still
//     genuinely in progress versus having simply ended in a sale;
//   - selling the very last charge of an item, which produces the exact
//     same "vanished, never seen again" shape as consuming it - no GSI
//     field distinguishes the two.
// Per this task's explicit product policy: a missed ambiguous real use is
// an acceptable, correct outcome; a false "used" broadcast sound is not.
//
// Applies only to `ItemSignal::ChargesOrConsumed` (Cooldown items were
// never at risk - see that branch, unchanged).
const RELOCATION_RECONCILIATION_WINDOW_MS: u64 = 2_000;

/// Why a pending vanish candidate's lifecycle changed this tick - purely a
/// diagnostics/testing aid (see `game_sounds::mod::handle_gsi`'s rolling-log
/// breadcrumb for pending transitions, задача п.10's "structural facts, not
/// raw payloads" requirement). Never consulted to decide whether an event
/// fires - see the module-level "ABSENCE IS NOT EVIDENCE" note above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingReason {
    /// First seen missing this tick with no positive relocation evidence -
    /// registered, not yet explained either way.
    VanishAwaitingReconciliation,
    /// Reappeared somewhere (`items` or a courier's cargo) before the
    /// reconciliation window elapsed - a proven relocation.
    ReappearedCancelled,
    /// Never reappeared anywhere for the full reconciliation window -
    /// discarded silently. This is NOT confirmation of a use; no event is
    /// ever emitted for this outcome (see the module-level doc comment
    /// above `detect_item_events`).
    DiscardedNoPositiveEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNote {
    pub item_name: String,
    pub reason: PendingReason,
}

/// Per-item-name "vanished, not yet explained" state that survives across
/// GSI ticks - diagnostics/reconciliation bookkeeping only (see
/// `PendingReason`'s doc comment: this NEVER causes an event to fire, by
/// design). `game_sounds::mod::handle_gsi` owns one long-lived instance of
/// this per Companion session (reset alongside `game_sounds_previous_gsi`
/// on every hero-identity change - see that module - so a candidate can
/// never leak diagnostics across a match boundary).
#[derive(Debug, Clone, Default)]
pub struct PendingConfirmations(HashMap<String, u64>);

impl PendingConfirmations {
    fn register_if_absent(&mut self, item_name: &str, now_ms: u64, notes: &mut Vec<PendingNote>) {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.0.entry(item_name.to_string()) {
            entry.insert(now_ms);
            notes.push(PendingNote { item_name: item_name.to_string(), reason: PendingReason::VanishAwaitingReconciliation });
        }
        // Already pending - the window is measured from the FIRST tick it
        // went missing, not re-armed on every subsequent tick it's still
        // absent, so this is deliberately a no-op when already registered.
    }

    fn cancel(&mut self, item_name: &str, notes: &mut Vec<PendingNote>) {
        if self.0.remove(item_name).is_some() {
            notes.push(PendingNote { item_name: item_name.to_string(), reason: PendingReason::ReappearedCancelled });
        }
    }

    #[cfg(test)]
    fn is_pending(&self, item_name: &str) -> bool {
        self.0.contains_key(item_name)
    }
}

/// Reconciles every currently-pending candidate against this tick's full
/// set of observed item names (from `items` AND courier cargo) - called
/// once per tick, independent of whichever slot(s) the per-slot loop in
/// `detect_item_events` happened to touch, so a candidate still gets a
/// chance to be explained even on a tick where its own (now long-empty)
/// source slot isn't revisited at all. Never pushes an `ItemUsed` event -
/// see the module-level "ABSENCE IS NOT EVIDENCE" doc comment above
/// `detect_item_events`.
fn resolve_pending(
    current_item_names: &std::collections::HashSet<&str>,
    now_ms: u64,
    pending: &mut PendingConfirmations,
    notes: &mut Vec<PendingNote>,
) {
    let mut discarded: Vec<String> = Vec::new();
    let mut reappeared: Vec<String> = Vec::new();
    pending.0.retain(|name, first_missing_at_ms| {
        if current_item_names.contains(name.as_str()) {
            reappeared.push(name.clone());
            false
        } else if now_ms.saturating_sub(*first_missing_at_ms) >= RELOCATION_RECONCILIATION_WINDOW_MS {
            discarded.push(name.clone());
            false
        } else {
            true
        }
    });
    for name in reappeared {
        notes.push(PendingNote { item_name: name, reason: PendingReason::ReappearedCancelled });
    }
    for name in discarded {
        notes.push(PendingNote { item_name: name, reason: PendingReason::DiscardedNoPositiveEvidence });
    }
}

/// Item names currently reported as being carried by ANY courier - Dota 2
/// GSI's separate, additively-enabled `couriers` section (see
/// gsi/config.rs's WK-138 addendum), now actually subscribed to. Schema
/// (`couriers.courier<N>.items.item<M>.name`) confirmed against the
/// long-maintained, widely-used community GSI client antonpup/Dota2GSI's
/// `Courier`/`CourierItem` node classes, not guessed.
///
/// Deliberately NOT filtered by the item's/courier's `owner` field: this
/// is consulted ONLY to explain (cancel) an already-ambiguous pending
/// candidate for diagnostics purposes, never to emit an event either way
/// (see `resolve_pending`) - so even an imprecise, unowned-filtered name
/// match can only ever make a diagnostic note more accurate or leave it
/// unchanged, never cause a wrong sound to play or be suppressed.
fn courier_item_names(payload: &Value) -> std::collections::HashSet<&str> {
    payload
        .get("couriers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(_, courier)| courier.get("items")?.as_object())
        .flatten()
        .filter_map(|(_, item)| item.get("name")?.as_str())
        .filter(|name| !name.is_empty() && *name != "empty")
        .collect()
}

fn detect_item_events(
    previous: &Value,
    current: &Value,
    now_ms: u64,
    pending: &mut PendingConfirmations,
    events: &mut Vec<GameSoundEvent>,
    notes: &mut Vec<PendingNote>,
) {
    // A tick where the `items` section is missing entirely (e.g. GSI
    // briefly stops sending it around a match ending/menu transition) must
    // never be read as "every previously-held item just got consumed" -
    // that's exactly the kind of undiscoverable transition the task says to
    // skip rather than guess at. Only diffed when this tick actually says
    // something about items; a per-slot "empty" (items present, this one
    // slot genuinely emptied) is unaffected and still detected below.
    //
    // Deliberately does NOT touch `pending` either way on such a tick -
    // there is no evidence in either direction, so any already-pending
    // candidate simply keeps waiting for a future tick that does carry
    // `items` again, rather than being spuriously resolved from silence.
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

    // Every item name present ANYWHERE in `current` - hero inventory slots
    // AND courier cargo alike - regardless of whether it was already there
    // before this tick. Diagnostics/reconciliation only (see
    // `resolve_pending`'s doc comment): never used to decide whether an
    // event fires.
    let mut current_item_names: std::collections::HashSet<&str> = current_slots
        .iter()
        .filter_map(|(_, v)| v.get("name").and_then(Value::as_str))
        .filter(|name| *name != "empty")
        .collect();
    current_item_names.extend(courier_item_names(current));

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

        match catalog_entry.signal {
            Some(ItemSignal::Cooldown) => {
                // Cooldown items are never consumed from the slot - only a
                // same-item cooldown-start transition counts.
                if current_name == Some(previous_name) {
                    let current_item = current_item.expect("current_name implies current_item exists");
                    let prev_cd = previous_item.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
                    let curr_cd = current_item.get("cooldown").and_then(Value::as_f64).unwrap_or(0.0);
                    if prev_cd <= 0.0 && curr_cd > 0.0 {
                        events.push(GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: previous_name.to_string() });
                    }
                }
            }
            Some(ItemSignal::ChargesOrConsumed) => {
                let prev_charges = previous_item.get("charges").and_then(Value::as_i64);
                if current_name == Some(previous_name) {
                    // Same slot, same item - the ONLY signal that ever
                    // emits `ItemUsed` for this category (see the
                    // module-level "ABSENCE IS NOT EVIDENCE" doc comment
                    // above): a charges decrease while the item remains
                    // provably owned is real positive evidence, not an
                    // inference from silence. Fires immediately and also
                    // clears any stale pending candidate for this name.
                    let current_item = current_item.expect("current_name implies current_item exists");
                    let curr_charges = current_item.get("charges").and_then(Value::as_i64);
                    if matches!((prev_charges, curr_charges), (Some(prev), Some(curr)) if curr < prev) {
                        pending.cancel(previous_name, notes);
                        events.push(GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: previous_name.to_string() });
                    }
                } else if !current_item_names.contains(previous_name) {
                    // Vanished from this slot and not observed anywhere
                    // else this tick either (a different/no item now here,
                    // or the slot itself is gone). No positive evidence of
                    // consumption exists and none ever will from silence
                    // alone - registered purely for reconciliation
                    // diagnostics (see `resolve_pending`), NEVER decided
                    // into an event, no matter how long it stays
                    // unexplained.
                    pending.register_if_absent(previous_name, now_ms, notes);
                } else {
                    // Reappeared elsewhere this same tick (another `items`
                    // slot, or courier cargo) - proven relocation, and also
                    // explains away any candidate already pending for it.
                    pending.cancel(previous_name, notes);
                }
            }
            None => {}
        }
    }

    resolve_pending(&current_item_names, now_ms, pending, notes);
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
        // WK-108 - `Experimental` abilities are attempted the same as
        // `Supported` ones (both carry a real signal); only `Unsupported`
        // (no usable signal at all - see catalog.rs) is skipped outright.
        // The Supported/Experimental distinction is purely an honesty
        // signal surfaced to the user in the UI, not a detection gate.
        if catalog_entry.status == AbilityStatus::Unsupported {
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
                    && catalog_entry.toggle_active_alias.as_deref() == Some(raw_current_name)
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

    // WK-138 - a single-instance consumable (no `charges` field) vanishing
    // from its slot is no longer decided from one tick alone (see
    // PendingConfirmations's doc comment) - it must first survive the full
    // bounded confirmation window with the item never reappearing anywhere.
    // The plain two-argument `detect_events` wrapper can never observe that
    // (fresh window state every call), so this uses `detect_events_with_state`
    // directly to model the full real sequence, per задача п.12.
    #[test]
    fn consumed_single_charge_item_disappearing_and_never_reappearing_is_never_treated_as_a_use() {
        // WK-138 correction - absence is not evidence: expiry of the
        // reconciliation window must discard the candidate silently, NEVER
        // emit an event, no matter how long it stays unexplained.
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_flask" } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));
        let mut pending = PendingConfirmations::default();

        // Tick 0: vanishes - not yet explained, registered as pending.
        let (events, notes) = detect_events_with_state(Some(&prev), &curr, 0, &mut pending);
        assert!(events.is_empty(), "must never fire for a bare vanish");
        assert_eq!(notes, vec![PendingNote { item_name: "item_flask".into(), reason: PendingReason::VanishAwaitingReconciliation }]);
        assert!(pending.is_pending("item_flask"));

        // A later tick still within the window, item still nowhere - stays pending.
        let (events, notes) = detect_events_with_state(Some(&curr), &curr, RELOCATION_RECONCILIATION_WINDOW_MS - 1, &mut pending);
        assert!(events.is_empty());
        assert!(notes.is_empty());
        assert!(pending.is_pending("item_flask"));

        // The window fully elapses with no reappearance anywhere - discarded
        // silently. This is NOT a use; no event is emitted.
        let (events, notes) = detect_events_with_state(Some(&curr), &curr, RELOCATION_RECONCILIATION_WINDOW_MS, &mut pending);
        assert!(events.is_empty(), "expiry must never manufacture a use event from silence");
        assert_eq!(notes, vec![PendingNote { item_name: "item_flask".into(), reason: PendingReason::DiscardedNoPositiveEvidence }]);
        assert!(!pending.is_pending("item_flask"));

        // And an arbitrarily long time later must still never fire either.
        let (events, notes) = detect_events_with_state(Some(&curr), &curr, RELOCATION_RECONCILIATION_WINDOW_MS + 3_600_000, &mut pending);
        assert!(events.is_empty());
        assert!(notes.is_empty());
    }

    // The multi-tick relocation case this mechanism exists to fix: the
    // item's destination slot doesn't land in the SAME tick the source slot
    // clears (ordinary hero<->backpack/stash bookkeeping can legitimately
    // straddle two GSI ticks) - correctly explained as a relocation. No
    // event fires at any point in this scenario either way (see the test
    // above), but this pins that reappearance is recognized (for
    // diagnostics accuracy) exactly when it should be.
    #[test]
    fn item_reappearing_in_a_later_tick_before_the_window_elapses_is_recognized_as_a_relocation() {
        let holding = with_hero(1, json!({ "items": { "slot0": { "name": "item_flask" } } }));
        let vanished = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));
        let relocated = with_hero(1, json!({ "items": { "slot0": { "name": "empty" }, "stash0": { "name": "item_flask" } } }));
        let mut pending = PendingConfirmations::default();

        let (events, _) = detect_events_with_state(Some(&holding), &vanished, 0, &mut pending);
        assert!(events.is_empty());
        assert!(pending.is_pending("item_flask"));

        // Reappears on a LATER tick, well within the window - cancelled.
        let (events, notes) = detect_events_with_state(Some(&vanished), &relocated, 400, &mut pending);
        assert!(events.is_empty());
        assert_eq!(notes, vec![PendingNote { item_name: "item_flask".into(), reason: PendingReason::ReappearedCancelled }]);
        assert!(!pending.is_pending("item_flask"));

        // The window elapsing afterwards must not do anything at all - it
        // was already resolved.
        let (events, notes) = detect_events_with_state(Some(&relocated), &relocated, RELOCATION_RECONCILIATION_WINDOW_MS + 1000, &mut pending);
        assert!(events.is_empty());
        assert!(notes.is_empty());
    }

    // WK-138 - expiration of the reconciliation window must NEVER create an
    // event by itself, for ANY reason a vanish went unexplained - explicit
    // direct pin of the policy, independent of any specific item/scenario.
    #[test]
    fn window_expiration_never_creates_an_event_by_itself() {
        let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } }));
        let curr = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));
        let mut pending = PendingConfirmations::default();
        let (events, _) = detect_events_with_state(Some(&prev), &curr, 0, &mut pending);
        assert!(events.is_empty());

        for elapsed_ms in [
            RELOCATION_RECONCILIATION_WINDOW_MS - 1,
            RELOCATION_RECONCILIATION_WINDOW_MS,
            RELOCATION_RECONCILIATION_WINDOW_MS + 1,
            RELOCATION_RECONCILIATION_WINDOW_MS * 100,
        ] {
            let mut probe = PendingConfirmations::default();
            let (events, _) = detect_events_with_state(Some(&prev), &curr, 0, &mut probe);
            assert!(events.is_empty());
            let (events, _) = detect_events_with_state(Some(&curr), &curr, elapsed_ms, &mut probe);
            assert!(events.is_empty(), "elapsed_ms={elapsed_ms} must never itself produce an event");
        }
    }

    // WK-138 - a real courier cargo signal (see `courier_item_names`) must
    // still explain (cancel) a pending candidate, exactly like an `items`
    // reappearance does - this is what actually lets a short, ordinary
    // courier hand-off correlate cleanly in diagnostics instead of just
    // silently expiring unexplained.
    #[test]
    fn item_appearing_in_courier_cargo_on_a_later_tick_is_recognized_as_a_relocation() {
        let holding = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 } } }));
        // Vanishes with no courier data yet this tick (e.g. the courier
        // pickup hasn't landed in GSI's `couriers` section yet either).
        let vanished = with_hero(1, json!({ "items": { "slot1": { "name": "empty" } } }));
        // A LATER tick: GSI's separate `couriers` section (schema confirmed
        // against antonpup/Dota2GSI's Courier/CourierItem node classes -
        // see `courier_item_names`) now shows the courier carrying it.
        let in_courier_cargo = with_hero(1, json!({
            "items": { "slot1": { "name": "empty" } },
            "couriers": { "courier0": { "owner": 0, "items": { "item0": { "owner": 0, "name": "item_blood_grenade" } } } }
        }));
        let mut pending = PendingConfirmations::default();

        let (events, _) = detect_events_with_state(Some(&holding), &vanished, 0, &mut pending);
        assert!(events.is_empty());
        assert!(pending.is_pending("item_blood_grenade"));

        let (events, notes) = detect_events_with_state(Some(&vanished), &in_courier_cargo, 500, &mut pending);
        assert!(events.is_empty());
        assert_eq!(notes, vec![PendingNote { item_name: "item_blood_grenade".into(), reason: PendingReason::ReappearedCancelled }]);
        assert!(!pending.is_pending("item_blood_grenade"));

        // And the window elapsing afterwards must not do anything - it was
        // already explained.
        let (events, notes) = detect_events_with_state(Some(&in_courier_cargo), &in_courier_cargo, RELOCATION_RECONCILIATION_WINDOW_MS + 1000, &mut pending);
        assert!(events.is_empty());
        assert!(notes.is_empty());
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

    }

    // WK-108 - a real production stream test surfaced a false Blood Grenade
    // sound on buying a *second* one while already holding one. These pin
    // the fix: a charge-tracked item's slot going empty/replaced is never
    // itself proof of use - only a same-slot charges decrease is.
    //
    // WK-138 note: the original version of this module modeled "the new
    // grenade lands at courier" with a `"courier0"` key inside `items`.
    // That shape was never confirmed against real Dota GSI and, per the
    // WK-138 audit (see events.rs's module-level doc comment above
    // `detect_item_events`), is very likely fictional - Dota 2 GSI exposes
    // courier state through a separate `couriers` section (now subscribed
    // AND parsed - see `courier_item_names`), not as any key inside
    // `items`. The corrected policy also means the old "confirmed after
    // window"/"known limitation" split no longer applies: absence is never
    // evidence, so a courier transition of ANY duration and selling the
    // last charge both now correctly produce ZERO events, not a delayed
    // false positive.
    mod wk108_item_purchase_move_merge_semantics {
        use super::*;

        #[test]
        fn buying_a_second_charge_tracked_item_while_holding_one_is_not_a_use() {
            // The existing grenade's slot goes empty for a tick (simulating
            // whatever internal bookkeeping a merge/relocation causes)
            // without ever showing a same-slot charges decrease first -
            // exactly the shape this repo cannot prove is a real use. The
            // newly-purchased grenade landing at a different slot is
            // present in this SAME `items` snapshot, so it's ruled out
            // immediately (see `item_reappearing_in_a_later_tick_before_the
            // _window_elapses_is_recognized_as_a_relocation` for the case
            // where it *doesn't* land in the same tick).
            let holding_one = with_hero(1, json!({ "items": {
                "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 },
                "stash0": { "name": "empty" }
            } }));
            let slot_cleared_by_purchase = with_hero(1, json!({ "items": {
                "slot1": { "name": "empty" },
                "stash0": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 }
            } }));
            assert!(detect_events(Some(&holding_one), &slot_cleared_by_purchase).is_empty());
        }

        // WK-109 задача B / WK-138 correction - the last-charge case. GSI
        // cannot distinguish "consumed the last charge" from "sold the last
        // charge" (or "courier is carrying the last charge") - the grenade's
        // own slot going straight from `charges: 1` to fully gone and never
        // reappearing anywhere is IDENTICAL in shape for all three. Per the
        // corrected product policy (absence is not evidence; a missed
        // ambiguous use is acceptable, a false broadcast sound is not),
        // this now correctly produces ZERO events, reversing WK-109's
        // original "treat it as a use" call for this one case.
        #[test]
        fn using_the_last_charge_of_a_charge_tracked_item_never_fires_from_vanishing_alone() {
            let prev = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 } } }));
            let curr = with_hero(1, json!({ "items": { "slot1": { "name": "empty" } } }));
            let mut pending = PendingConfirmations::default();

            let (events, _) = detect_events_with_state(Some(&prev), &curr, 0, &mut pending);
            assert!(events.is_empty(), "must not fire on the very tick it vanishes");

            // Nor after any amount of time, however long - see
            // `window_expiration_never_creates_an_event_by_itself`.
            let (events, _) = detect_events_with_state(Some(&curr), &curr, RELOCATION_RECONCILIATION_WINDOW_MS + 60_000, &mut pending);
            assert!(events.is_empty(), "expiry must never manufacture a use event for the last-charge case either");
        }

        // WK-138 - a courier transition, however long the courier actually
        // carries the item for, must never produce a false "used" event.
        // Before this correction, a courier flight simply outlasting the
        // reconciliation window would have incorrectly confirmed a use;
        // now expiry never fires anything, so this is unconditionally safe
        // regardless of real courier flight duration (still unmeasured -
        // see the final WK-138 report's manual-verification recipe).
        #[test]
        fn a_courier_transition_of_any_duration_never_produces_a_false_use() {
            let holding = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 } } }));
            let sent_to_courier = with_hero(1, json!({ "items": { "slot1": { "name": "empty" } } }));
            let mut pending = PendingConfirmations::default();

            let (events, _) = detect_events_with_state(Some(&holding), &sent_to_courier, 0, &mut pending);
            assert!(events.is_empty());

            for elapsed_ms in [
                RELOCATION_RECONCILIATION_WINDOW_MS, // short carry, outlasting the window
                10_000,                              // a real, multi-second courier flight
                120_000,                              // an unusually long one
            ] {
                let (events, _) = detect_events_with_state(Some(&sent_to_courier), &sent_to_courier, elapsed_ms, &mut pending);
                assert!(events.is_empty(), "elapsed_ms={elapsed_ms} must never produce a false use");
            }
        }

        // WK-138 - selling the last charge is the same shape as consuming
        // it (vanishes, never reappears anywhere) and is explicitly called
        // out by the corrected product policy as a case GSI cannot resolve
        // - it must produce zero events, same as the generic last-charge
        // test above. Kept as its own named regression pin since selling is
        // the scenario actually reported in production.
        #[test]
        fn selling_the_last_charge_never_produces_a_false_use() {
            let holding = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 } } }));
            let sold = with_hero(1, json!({ "items": { "slot1": { "name": "empty" } } }));
            let mut pending = PendingConfirmations::default();

            let (events, _) = detect_events_with_state(Some(&holding), &sold, 0, &mut pending);
            assert!(events.is_empty());
            let (events, _) = detect_events_with_state(Some(&sold), &sold, RELOCATION_RECONCILIATION_WINDOW_MS + 60_000, &mut pending);
            assert!(events.is_empty(), "selling the last charge must never be misread as a use, even after the window");
        }

        // The same vanish-from-slot shape, but the item still exists
        // elsewhere in this exact snapshot (relocated, not consumed) - must
        // stay silent even though prev_charges was exactly 1.
        #[test]
        fn last_charge_relocating_to_another_slot_in_the_same_tick_is_not_a_use() {
            let prev = with_hero(1, json!({ "items": {
                "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 },
                "stash0": { "name": "empty" }
            } }));
            let curr = with_hero(1, json!({ "items": {
                "slot1": { "name": "empty" },
                "stash0": { "name": "item_blood_grenade", "charges": 1, "cooldown": 0 }
            } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        // A charge-tracked item with 2+ charges remaining that vanishes
        // outright (no same-slot decrease ever observed) never fires either
        // - no positive evidence of any consumption exists for it, at any
        // point. Still tracked as a pending candidate purely for
        // reconciliation diagnostics (uniform treatment with every other
        // vanish shape - see `detect_item_events`), but that tracking can
        // never itself produce an event (see
        // `window_expiration_never_creates_an_event_by_itself`).
        #[test]
        fn vanishing_with_two_or_more_charges_remaining_and_no_trace_elsewhere_is_still_not_a_use() {
            let prev = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 2, "cooldown": 0 } } }));
            let curr = with_hero(1, json!({ "items": { "slot1": { "name": "empty" } } }));
            let mut pending = PendingConfirmations::default();
            let (events, _) = detect_events_with_state(Some(&prev), &curr, 0, &mut pending);
            assert!(events.is_empty());

            // Never fires, however long it waits.
            let (events, _) = detect_events_with_state(Some(&curr), &curr, RELOCATION_RECONCILIATION_WINDOW_MS + 60_000, &mut pending);
            assert!(events.is_empty());
        }

        #[test]
        fn hero_to_backpack_move_of_a_single_instance_consumable_is_not_a_use() {
            // Healing Salve (no `charges` field at all) moves from the hero
            // slot to a backpack/stash slot in the same tick - it reappears
            // under a different slot key, so the vanish-from-slot0 branch
            // must recognize the relocation and stay silent.
            let prev = with_hero(1, json!({ "items": {
                "slot0": { "name": "item_flask" },
                "stash0": { "name": "empty" }
            } }));
            let curr = with_hero(1, json!({ "items": {
                "slot0": { "name": "empty" },
                "stash0": { "name": "item_flask" }
            } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        #[test]
        fn hero_to_backpack_move_spanning_two_ticks_is_still_not_a_use() {
            // WK-138 - the same relocation as above, but the destination
            // slot only lands on the NEXT tick rather than the same one
            // (ordinary bookkeeping race - see this module's own top doc
            // comment). The old same-tick-only check would have missed
            // this and reported a false use; the bounded confirmation
            // window is exactly what closes this gap.
            let prev = with_hero(1, json!({ "items": { "slot0": { "name": "item_flask" } } }));
            let mid_tick_vanished = with_hero(1, json!({ "items": { "slot0": { "name": "empty" } } }));
            let landed_next_tick = with_hero(1, json!({ "items": {
                "slot0": { "name": "empty" },
                "backpack0": { "name": "item_flask" }
            } }));
            let mut pending = PendingConfirmations::default();

            let (events, _) = detect_events_with_state(Some(&prev), &mid_tick_vanished, 0, &mut pending);
            assert!(events.is_empty());
            assert!(pending.is_pending("item_flask"));

            let (events, notes) = detect_events_with_state(Some(&mid_tick_vanished), &landed_next_tick, 300, &mut pending);
            assert!(events.is_empty());
            assert_eq!(notes, vec![PendingNote { item_name: "item_flask".into(), reason: PendingReason::ReappearedCancelled }]);
        }

        #[test]
        fn a_stack_merge_that_clears_the_source_slot_without_a_charges_decrease_is_not_a_use() {
            // A merge that recreates the stack at a *different* slot key,
            // with the source slot going straight to empty (no observed
            // same-slot charges decrease) - the item reappearing elsewhere
            // this same tick proves it was a merge, not depletion.
            let prev = with_hero(1, json!({ "items": {
                "slot0": { "name": "item_tango", "charges": 1 },
                "slot1": { "name": "empty" }
            } }));
            let curr = with_hero(1, json!({ "items": {
                "slot0": { "name": "empty" },
                "slot1": { "name": "item_tango", "charges": 2 }
            } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        #[test]
        fn real_charges_decrement_in_the_same_slot_still_fires_exactly_once() {
            let prev = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 2, "cooldown": 0 } } }));
            let curr = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 10 } } }));
            assert_eq!(
                detect_events(Some(&prev), &curr),
                vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_blood_grenade".into() }]
            );
        }

        #[test]
        fn cooldown_recovery_after_a_real_use_does_not_refire() {
            let prev = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 10 } } }));
            let curr = with_hero(1, json!({ "items": { "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 9 } } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }
    }

    // WK-108 - canonical ability identity for Rubick's Spell Steal. Ability
    // detection never reads `hero.id`/`hero.name` at all (only the
    // `abilities` section's own `name`/`cooldown`/`charges` fields) - so a
    // stolen spell occupying one of RUBICK's ability slots under the
    // ORIGINAL ability's own raw internal name (`pudge_meat_hook`, per the
    // WK-108 research note in catalog.rs: dotaconstants has no separate
    // "rubick_stolen_meat_hook"-style id, only a generic empty-slot
    // placeholder when nothing is stolen) is detected and canonicalized
    // exactly like Pudge casting his own Meat Hook - zero Rubick-specific
    // code path exists for this to go through. These pin that architectural
    // claim at the one layer where it actually matters (detection), not
    // just as a catalog-lookup unit test.
    mod wk108_rubick_stolen_spell_canonicalization {
        use super::*;

        const RUBICK_HERO_ID: i64 = 86;

        #[test]
        fn a_stolen_spell_appearing_in_rubicks_slot_for_the_first_time_is_not_a_cast() {
            // No previous snapshot for this slot at all (Rubick just stole
            // Meat Hook this tick) - "appeared" alone must never be treated
            // as "cast", the same rule as any other ability/dynamic slot.
            let prev = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "empty" } } }));
            let curr = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "pudge_meat_hook", "cooldown": 0 } } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        #[test]
        fn stealing_a_different_spell_over_an_existing_stolen_one_is_not_a_cast() {
            // The stolen spell slot being *replaced* by a newly-stolen
            // different spell (Rubick re-casting Spell Steal) is a slot
            // identity change, not a cast of either spell.
            let prev = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "pudge_meat_hook", "cooldown": 0 } } }));
            let curr = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "lion_impale", "cooldown": 0 } } }));
            assert!(detect_events(Some(&prev), &curr).is_empty());
        }

        #[test]
        fn a_genuine_cast_of_the_stolen_meat_hook_canonicalizes_to_pudge_meat_hook() {
            let prev = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "pudge_meat_hook", "cooldown": 0 } } }));
            let curr = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "pudge_meat_hook", "cooldown": 13 } } }));
            let events = detect_events(Some(&prev), &curr);
            assert_eq!(events, vec![GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "pudge_meat_hook".into() }]);
        }

        #[test]
        fn the_stolen_casts_id_is_the_exact_same_binding_key_as_pudges_own_cast() {
            // The whole point of canonical identity: a sound bound once to
            // "pudge_meat_hook" plays for BOTH Pudge's own hook and a
            // Rubick-stolen one, with no separate binding ever needed.
            let pudge_prev = with_hero(14, json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 0 } } }));
            let pudge_curr = with_hero(14, json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 13 } } }));
            let rubick_prev = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "pudge_meat_hook", "cooldown": 0 } } }));
            let rubick_curr = with_hero(RUBICK_HERO_ID, json!({ "abilities": { "ability3": { "name": "pudge_meat_hook", "cooldown": 13 } } }));

            let pudge_events = detect_events(Some(&pudge_prev), &pudge_curr);
            let rubick_events = detect_events(Some(&rubick_prev), &rubick_curr);
            assert_eq!(pudge_events, rubick_events);
        }
    }

    mod wk107_reconnect_safety {
        use super::*;

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
