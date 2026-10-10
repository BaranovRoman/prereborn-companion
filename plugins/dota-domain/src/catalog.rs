use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

// Static catalog of Dota 2 items/heroes/abilities this feature knows how to
// map to a GSI-observable "used"/"cast" transition (see events::detect_events,
// the actual detector). Nothing here is fetched or bundled from Valve's game
// files - item entries are hand-curated internal name/display pairs (public,
// well-documented Dota 2 API identifiers, not copyrighted assets); the hero/
// ability catalog (see `hero_catalog` below) is a generated, versioned
// snapshot of real Dota metadata, not hand-typed.
//
// WK-106 shipped against only the publicly documented community GSI schema
// (no real capture existed yet). WK-107 replaced that assumption with a real
// production diagnostics capture (Techies + Tango + Blood Grenade, see
// events.rs's module doc comment for the full forensic writeup) - it
// confirmed the WK-106 item signals unchanged and revealed two ability
// transition shapes a plain cooldown-only detector could not represent at
// all (`AbilitySignal::Charges`, `AbilitySignal::ToggleActivateRename`).
//
// WK-108 replaced the hand-typed 9-hero/32-ability bootstrap catalog with a
// GENERATED one covering the full current hero roster - see
// `generated_hero_catalog.json` and `scripts/generate-game-sounds-hero-
// catalog.mjs` (source: github.com/odota/dotaconstants, pinned commit,
// documented in that script). Crucially, this also means introducing
// `AbilityStatus::Experimental`: the WK-107 capture proved that an
// ability's metadata (cooldown value, "behavior" tag) can *look* like a
// completely normal cast and still not behave that way in real GSI -
// Reactive Tazer has a perfectly ordinary-looking cooldown in Dota's own
// data and never actually pulses it. Metadata alone can therefore never
// justify `Supported` for an ability this repo hasn't personally seen a
// real GSI transition for - only `Experimental` (attempted, unverified).
// `Supported` stays reserved for the small, real-capture-confirmed list
// (currently: Techies' four abilities, folded into the generation script's
// own override table - see that script for the citation).
//
// Icons are hotlinked to Valve's own public Dota 2 CDN (the same
// `dota_react` image set OpenDota/Dotabuff/every other third-party Dota tool
// already links to directly) rather than bundled into this repo/installer -
// no binary game asset ever ships with Companion, matching the "no
// copyrighted assets in the repo" constraint from the task (which is about
// *audio*, not about hotlinking Valve's own already-public CDN icons the way
// the rest of the Dota tooling ecosystem does).
const ITEM_ICON_BASE: &str = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemSignal {
    // Item has a real GSI `cooldown` that starts on activation and is never
    // consumed from the slot (Blink Dagger, Black King Bar, ...).
    Cooldown,
    // Item is used up - either its `charges` count drops, or the slot goes
    // from occupied-by-this-item to empty (Tango, Healing Salve, Smoke of
    // Deceit, Dust of Appearance, Town Portal Scroll, ...). One signal
    // covering both shapes deliberately, rather than pretending this repo
    // knows exactly which of the two Valve's client reports item-by-item
    // without a real capture to check against.
    ChargesOrConsumed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedItem {
    pub id: String,
    pub display_name: String,
    pub icon_url: String,
    pub supported: bool,
    pub signal: Option<ItemSignal>,
    pub reason: Option<String>,
}

// WK-107/108 - the ability-side equivalent of ItemSignal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AbilitySignal {
    // Ability has a real GSI `cooldown` that starts on cast (WK-106's
    // original, only, signal - still confirmed correct by the WK-107
    // capture for every ability that uses it, e.g. Techies' Sticky Bomb and
    // Blast Off!). Also the default best-effort signal the WK-108 generator
    // assigns to any `Experimental` ability that merely *looks* like it
    // should follow this pattern.
    Cooldown,
    // Charge-based ability (separate `charges`/`charge_cooldown`/
    // `max_charges` fields, `cooldown` stays 0 and is never used) - a cast
    // consumes one charge. Mirrors ItemSignal::ChargesOrConsumed's charges
    // check, but abilities never get "consumed from a slot" the way an
    // item can, so there's no consumed-fallback branch here. Currently only
    // ever assigned via a real-capture override (Techies' Proximity Mines) -
    // the generator has no way to guess this from metadata alone.
    Charges,
    // GSI renames this ability's own `name` to a "_stop"-suffixed variant
    // while toggled active, instead of pulsing `cooldown` at all (Techies'
    // Reactive Tazer). Only the confirmed activation direction (base name
    // -> alias) is treated as a cast - see TrackedAbility::toggle_active_alias
    // and events::detect_ability_events. The reverse (deactivation) rename
    // is not proven by the capture this is based on and is deliberately
    // left undetected rather than guessed at. Like `Charges`, only ever
    // assigned via a real-capture override.
    ToggleActivateRename,
}

// WK-108 - see the module doc comment above for the full rationale.
// `Unsupported` abilities are never attempted by the detector (`signal` is
// always `None`, `events::detect_ability_events` skips them outright).
// `Supported` and `Experimental` abilities both get a real `signal` and are
// both bindable/detected the same way - the only difference is what the UI
// tells the user about how much to trust it, and whether a `reason` caveat
// is shown (only `Supported` omits one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AbilityStatus {
    Supported,
    Experimental,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedAbility {
    pub id: String,
    pub display_name: String,
    pub icon_url: String,
    pub status: AbilityStatus,
    pub signal: Option<AbilitySignal>,
    // Only `Some` for `AbilitySignal::ToggleActivateRename` abilities - the
    // raw GSI `name` this ability's slot takes on while toggled active (see
    // events.rs's module doc comment: Reactive Tazer's GSI name flips to
    // this suffixed variant instead of pulsing a cooldown). `id` and every
    // catalog/binding lookup always use the base/canonical name; this is
    // purely the detector's "which renamed variant means activated" signal.
    pub toggle_active_alias: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedHero {
    pub id: String,
    pub display_name: String,
    pub icon_url: String,
    pub abilities: Vec<TrackedAbility>,
}

fn supported_item(id: &str, display_name: &str, signal: ItemSignal) -> TrackedItem {
    TrackedItem {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ITEM_ICON_BASE}/{}.png", id.trim_start_matches("item_")),
        supported: true,
        signal: Some(signal),
        reason: None,
    }
}

fn unsupported_item(id: &str, display_name: &str, reason: &str) -> TrackedItem {
    TrackedItem {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ITEM_ICON_BASE}/{}.png", id.trim_start_matches("item_")),
        supported: false,
        signal: None,
        reason: Some(reason.to_string()),
    }
}

pub fn item_catalog() -> Vec<TrackedItem> {
    vec![
        supported_item("item_tango", "Tango", ItemSignal::ChargesOrConsumed),
        // WK-107 - confirmed present in a real production GSI capture as
        // `item_blood_grenade` (slot1), contradicting WK-106's assumption
        // that it wasn't a real distinct base item id. Same signal as
        // Tango: the real capture shows a simultaneous `charges` decrease
        // (2 -> 1) and `cooldown` start (0 -> 10) on use - `charges`
        // decreasing alone is what ChargesOrConsumed already checks (see
        // events.rs), so no detector change was needed for this one, only
        // the catalog entry. See events.rs's module doc comment for the
        // full before/after values.
        supported_item("item_blood_grenade", "Blood Grenade", ItemSignal::ChargesOrConsumed),
        supported_item("item_flask", "Healing Salve", ItemSignal::ChargesOrConsumed),
        supported_item("item_enchanted_mango", "Enchanted Mango", ItemSignal::ChargesOrConsumed),
        supported_item("item_clarity", "Clarity", ItemSignal::ChargesOrConsumed),
        supported_item("item_faerie_fire", "Faerie Fire", ItemSignal::ChargesOrConsumed),
        supported_item("item_smoke_of_deceit", "Smoke of Deceit", ItemSignal::ChargesOrConsumed),
        supported_item("item_dust", "Dust of Appearance", ItemSignal::ChargesOrConsumed),
        supported_item("item_tpscroll", "Town Portal Scroll", ItemSignal::ChargesOrConsumed),
        supported_item("item_blink", "Blink Dagger", ItemSignal::Cooldown),
        supported_item("item_black_king_bar", "Black King Bar", ItemSignal::Cooldown),
        supported_item("item_cyclone", "Eul's Scepter of Divinity", ItemSignal::Cooldown),
        supported_item("item_force_staff", "Force Staff", ItemSignal::Cooldown),
        supported_item("item_glimmer_cape", "Glimmer Cape", ItemSignal::Cooldown),
        supported_item("item_ghost", "Ghost Scepter", ItemSignal::Cooldown),
        supported_item("item_hand_of_midas", "Hand of Midas", ItemSignal::Cooldown),
        supported_item("item_urn_of_shadows", "Urn of Shadows", ItemSignal::Cooldown),
        unsupported_item(
            "item_power_treads",
            "Power Treads",
            "Переключение атрибута не создаёт надёжного игрового события — оно слишком частое и неотличимо в GSI от другой активности.",
        ),
        unsupported_item(
            "item_yasha",
            "Yasha",
            "Предмет без активного эффекта — момента 'использования' не существует.",
        ),
        unsupported_item(
            "item_bracer",
            "Bracer",
            "Предмет без активного эффекта — момента 'использования' не существует.",
        ),
        unsupported_item(
            "item_kaya",
            "Kaya",
            "Предмет без активного эффекта — момента 'использования' не существует.",
        ),
        unsupported_item(
            "item_infused_raindrop",
            "Infused Raindrop",
            "Срабатывает автоматически при получении магического урона — это не действие игрока, которое можно отследить как 'использование'.",
        ),
    ]
}

// WK-108 - the full current hero roster (127 heroes at generation time),
// generated from real Dota metadata rather than hand-typed. See
// `scripts/generate-game-sounds-hero-catalog.mjs` for the generator (source,
// classification rules, and how to refresh this for a new Dota patch) and
// that script's own doc comment for why metadata can only ever justify
// `AbilityStatus::Experimental`, never `Supported`. Embedded at compile time
// (not fetched at runtime) so Companion never depends on network access or
// a third-party API to show/use this catalog - "deterministic, versionable,
// no runtime network dependency" per the task.
static GENERATED_HERO_CATALOG_JSON: &str = include_str!("generated_hero_catalog.json");

#[derive(Deserialize)]
struct GeneratedCatalog {
    heroes: Vec<TrackedHero>,
}

pub fn hero_catalog() -> Vec<TrackedHero> {
    hero_catalog_cached().clone()
}

fn hero_catalog_cached() -> &'static Vec<TrackedHero> {
    static CATALOG: OnceLock<Vec<TrackedHero>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let parsed: GeneratedCatalog = serde_json::from_str(GENERATED_HERO_CATALOG_JSON)
            .expect("generated_hero_catalog.json must parse - run scripts/generate-game-sounds-hero-catalog.mjs to regenerate it");
        parsed.heroes
    })
}

/// Flat item/ability id -> catalog entry lookup used by the detector -
/// ability internal names already encode their hero (Dota's own naming
/// convention, e.g. `pudge_meat_hook`), so this doesn't need the hero id to
/// disambiguate. Built once and memoized (`detect_events` calls these up to
/// once per populated item/ability slot on every single GSI tick while a
/// match is running - rebuilding the catalog's `String`/`format!`
/// allocations from scratch on every lookup would be wasted work on a path
/// that never stops running).
fn item_index() -> &'static HashMap<String, TrackedItem> {
    static INDEX: OnceLock<HashMap<String, TrackedItem>> = OnceLock::new();
    INDEX.get_or_init(|| item_catalog().into_iter().map(|item| (item.id.clone(), item)).collect())
}

fn ability_index() -> &'static HashMap<String, TrackedAbility> {
    static INDEX: OnceLock<HashMap<String, TrackedAbility>> = OnceLock::new();
    INDEX.get_or_init(|| {
        hero_catalog_cached()
            .iter()
            .flat_map(|hero| hero.abilities.iter())
            .map(|ability| (ability.id.clone(), ability.clone()))
            .collect()
    })
}

pub fn find_item(id: &str) -> Option<TrackedItem> {
    item_index().get(id).cloned()
}

/// Derived from each `TrackedAbility::toggle_active_alias` already in the
/// catalog, not a second hand-maintained list - the alias lives in exactly
/// one place (the generator's override table). Only abilities catalogued
/// with `AbilitySignal::ToggleActivateRename` (currently just Techies'
/// Reactive Tazer, confirmed by the WK-107 production capture) ever appear
/// here, so a future toggle ability only needs its catalog entry, not a
/// matching edit somewhere else that's easy to forget. This is also the one
/// mechanism `events::detect_ability_events` relies on to canonicalize a
/// stolen (Rubick) or otherwise-renamed ability slot back to its real
/// identity - see that function's own doc comment.
fn alias_index() -> &'static HashMap<String, String> {
    static INDEX: OnceLock<HashMap<String, String>> = OnceLock::new();
    INDEX.get_or_init(|| {
        hero_catalog_cached()
            .iter()
            .flat_map(|hero| hero.abilities.iter())
            .filter_map(|ability| ability.toggle_active_alias.clone().map(|alias| (alias, ability.id.clone())))
            .collect()
    })
}

/// Maps a raw GSI ability `name` to this catalog's canonical lookup key -
/// identity for every ability except a confirmed toggle-activation alias
/// (see `alias_index` above).
pub fn canonicalize_ability_name(raw: &str) -> &str {
    alias_index().get(raw).map(String::as_str).unwrap_or(raw)
}

pub fn find_ability(id: &str) -> Option<TrackedAbility> {
    ability_index().get(canonicalize_ability_name(id)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_item_id_is_unique() {
        let items = item_catalog();
        let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), items.len());
    }

    #[test]
    fn every_ability_id_is_globally_unique_across_heroes() {
        let heroes = hero_catalog();
        let mut ids: Vec<String> = heroes
            .iter()
            .flat_map(|h| h.abilities.iter().map(|a| a.id.clone()))
            .collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn supported_items_always_carry_a_signal_and_no_reason() {
        for item in item_catalog() {
            if item.supported {
                assert!(item.signal.is_some(), "{} missing signal", item.id);
                assert!(item.reason.is_none(), "{} has a reason but is supported", item.id);
            } else {
                assert!(item.signal.is_none(), "{} unsupported but has a signal", item.id);
                assert!(item.reason.is_some(), "{} unsupported without a reason", item.id);
            }
        }
    }

    #[test]
    fn unsupported_abilities_never_carry_a_signal_supported_and_experimental_always_do() {
        for hero in hero_catalog() {
            for ability in hero.abilities {
                let should_have_signal = ability.status != AbilityStatus::Unsupported;
                assert_eq!(ability.signal.is_some(), should_have_signal, "{}", ability.id);
            }
        }
    }

    #[test]
    fn only_supported_abilities_omit_a_reason() {
        // WK-108 - both `experimental` and `unsupported` must explain
        // themselves; only a real-capture-confirmed `supported` entry needs
        // no caveat (see the module doc comment on why metadata alone can
        // never earn `supported`).
        for hero in hero_catalog() {
            for ability in hero.abilities {
                let should_have_reason = ability.status != AbilityStatus::Supported;
                assert_eq!(ability.reason.is_some(), should_have_reason, "{}", ability.id);
            }
        }
    }

    #[test]
    fn only_toggle_activate_rename_abilities_carry_an_alias() {
        for hero in hero_catalog() {
            for ability in hero.abilities {
                let is_toggle = ability.signal == Some(AbilitySignal::ToggleActivateRename);
                assert_eq!(ability.toggle_active_alias.is_some(), is_toggle, "{}", ability.id);
            }
        }
    }

    #[test]
    fn blood_grenade_is_present_and_supported() {
        let item = find_item("item_blood_grenade").expect("item_blood_grenade must be in the catalog");
        assert!(item.supported);
        assert_eq!(item.signal, Some(ItemSignal::ChargesOrConsumed));
    }

    #[test]
    fn techies_hero_has_all_four_captured_abilities_marked_supported() {
        let heroes = hero_catalog();
        let techies = heroes
            .iter()
            .find(|h| h.id == "npc_dota_hero_techies")
            .expect("Techies must be in the hero catalog");
        let by_id: std::collections::HashMap<&str, &TrackedAbility> =
            techies.abilities.iter().map(|a| (a.id.as_str(), a)).collect();

        assert_eq!(by_id["techies_sticky_bomb"].display_name, "Sticky Bomb");
        assert_eq!(by_id["techies_sticky_bomb"].status, AbilityStatus::Supported);

        assert_eq!(by_id["techies_reactive_tazer"].display_name, "Reactive Tazer");
        assert_eq!(by_id["techies_reactive_tazer"].status, AbilityStatus::Supported);
        // Not a second, separate ability entry for the "_stop" variant.
        assert!(!by_id.contains_key("techies_reactive_tazer_stop"));

        assert_eq!(by_id["techies_suicide"].display_name, "Blast Off!");
        assert_eq!(by_id["techies_suicide"].status, AbilityStatus::Supported);

        assert_eq!(by_id["techies_land_mines"].display_name, "Proximity Mines");
        assert_eq!(by_id["techies_land_mines"].status, AbilityStatus::Supported);
        assert_eq!(by_id["techies_land_mines"].signal, Some(AbilitySignal::Charges));
    }

    #[test]
    fn reactive_tazer_stop_alias_resolves_to_the_same_canonical_catalog_entry() {
        assert_eq!(canonicalize_ability_name("techies_reactive_tazer_stop"), "techies_reactive_tazer");
        assert_eq!(canonicalize_ability_name("techies_reactive_tazer"), "techies_reactive_tazer");
        let via_alias = find_ability("techies_reactive_tazer_stop").unwrap();
        let via_base = find_ability("techies_reactive_tazer").unwrap();
        assert_eq!(via_alias.id, via_base.id);
        assert_eq!(via_alias.toggle_active_alias.as_deref(), Some("techies_reactive_tazer_stop"));
    }

    #[test]
    fn find_item_and_find_ability_resolve_known_ids() {
        assert!(find_item("item_tango").is_some());
        assert!(find_item("item_blood_grenade").is_some());
        assert!(find_item("item_does_not_exist").is_none());
        assert!(find_ability("pudge_meat_hook").is_some());
        assert!(find_ability("pudge_rot").is_some());
        assert!(find_ability("does_not_exist").is_none());
    }

    // WK-108 - the generated catalog now covers the full roster; these pin
    // that it actually does, and that the specific heroes this task called
    // out by name are present with real, non-empty ability lists.
    #[test]
    fn generated_catalog_covers_the_full_current_roster() {
        let heroes = hero_catalog();
        assert!(heroes.len() >= 120, "expected the full current Dota roster, got {}", heroes.len());
        for hero in &heroes {
            assert!(hero.id.starts_with("npc_dota_hero_"), "{}", hero.id);
            assert!(!hero.display_name.is_empty(), "{}", hero.id);
        }
    }

    #[test]
    fn largo_is_present_with_real_abilities_and_no_hidden_placeholder_entries() {
        // WK-108 research note: "Largo" was verified against the real
        // dotaconstants snapshot (not assumed) - it's a real, current hero.
        let heroes = hero_catalog();
        let largo = heroes.iter().find(|h| h.id == "npc_dota_hero_largo").expect("Largo must be in the catalog");
        assert!(!largo.abilities.is_empty());
        for ability in &largo.abilities {
            assert_ne!(ability.display_name, "");
        }
    }

    #[test]
    fn invoker_orb_and_invoke_abilities_are_never_marked_supported() {
        // Dynamic-slot uncertainty (see the generator's INVOKER_DYNAMIC_ABILITY_IDS)
        // must never be silently upgraded to `Supported` by the generic
        // metadata heuristic.
        let heroes = hero_catalog();
        let invoker = heroes.iter().find(|h| h.id == "npc_dota_hero_invoker").expect("Invoker must be in the catalog");
        for id in ["invoker_quas", "invoker_wex", "invoker_exort", "invoker_invoke", "invoker_cold_snap", "invoker_sun_strike"] {
            let ability = invoker.abilities.iter().find(|a| a.id == id).unwrap_or_else(|| panic!("{id} missing from Invoker"));
            assert_ne!(ability.status, AbilityStatus::Supported, "{id} must not be auto-classified supported");
        }
        // Placeholder "currently invoked spell" slots are not real abilities.
        assert!(!invoker.abilities.iter().any(|a| a.id == "invoker_empty1" || a.id == "invoker_empty2"));
    }

    #[test]
    fn rubick_has_his_own_abilities_but_no_fake_stolen_spell_placeholder_entries() {
        let heroes = hero_catalog();
        let rubick = heroes.iter().find(|h| h.id == "npc_dota_hero_rubick").expect("Rubick must be in the catalog");
        assert!(rubick.abilities.iter().any(|a| a.id == "rubick_spell_steal"));
        // "Stolen Spell" placeholder slots aren't real abilities - a stolen
        // spell canonicalizes to the ORIGINAL hero's ability id via
        // find_ability (any hero-agnostic ability id resolves the same way
        // regardless of which hero's slot it appears in - see
        // events::detect_ability_events), not via a Rubick-specific entry.
        assert!(!rubick.abilities.iter().any(|a| a.id == "rubick_empty1" || a.id == "rubick_empty2"));
    }

    #[test]
    fn find_ability_takes_no_hero_parameter_at_all_so_a_stolen_spell_needs_no_dedicated_entry() {
        // Canonical ability identity (задача п.7) at the catalog layer:
        // `find_ability`'s signature is `fn(id: &str) -> Option<TrackedAbility>`
        // - there is no hero parameter to even express "resolve this as
        // Rubick's". A copy of Meat Hook appearing in ANY hero's ability
        // slot (Rubick's Spell Steal) is therefore mechanically the exact
        // same lookup as Pudge's own, with the exact same result - not
        // merely "coded to behave the same", but structurally unable to
        // differ. See events::wk108_rubick_stolen_spell_canonicalization for
        // the corresponding detection-level regression test.
        let ability = find_ability("pudge_meat_hook").expect("pudge_meat_hook must be catalogued");
        assert_eq!(ability.id, "pudge_meat_hook");
    }
}
