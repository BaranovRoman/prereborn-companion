use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;

// Static catalog of Dota 2 items/heroes/abilities this feature knows how to
// reliably map to a GSI-observable "used"/"cast" transition (see
// events::detect_events, the actual detector). Nothing here is fetched or
// bundled from Valve's game files - these are hand-curated internal
// name/display pairs (public, well-documented Dota 2 API identifiers, not
// copyrighted assets) plus a `supported` verdict this repo can defend given
// what's actually knowable about the GSI `items`/`abilities` sections.
//
// WK-106 shipped against only the publicly documented community GSI schema
// (no real capture existed yet): items carry `name`/`charges`/`cooldown`/
// `can_cast`/`passive`/`purchaser`, abilities carry `name`/`level`/
// `cooldown`/`can_cast`/`ultimate`.
//
// WK-107 replaced that assumption with a real production diagnostics
// capture (Techies + Tango + Blood Grenade, see events.rs's module doc
// comment for the full forensic writeup). It confirmed the WK-106 shape for
// every entry already in this catalog (still `Cooldown`/`ChargesOrConsumed`,
// unchanged), added two real fields not previously known
// (`max_cooldown`, `ability_active`), and revealed two GSI transition shapes
// the original generic detector could not represent at all: a charge-based
// ultimate (`charges`/`charge_cooldown`/`max_charges` instead of
// `cooldown`) and a toggle ability whose GSI `name` itself flips to a
// "_stop"-suffixed variant while active, instead of pulsing `cooldown`. See
// `AbilitySignal` below.
//
// Icons are hotlinked to Valve's own public Dota 2 CDN (the same
// `dota_react` image set OpenDota/Dotabuff/every other third-party Dota tool
// already links to directly) rather than bundled into this repo/installer -
// no binary game asset ever ships with Companion, matching the "no
// copyrighted assets in the repo" constraint from the task (which is about
// *audio*, not about hotlinking Valve's own already-public CDN icons the way
// the rest of the Dota tooling ecosystem does).
const ITEM_ICON_BASE: &str = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items";
const HERO_ICON_BASE: &str = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes";
const ABILITY_ICON_BASE: &str = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/abilities";

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

// WK-107 - the ability-side equivalent of ItemSignal, extended by a real
// production capture (see events.rs's module doc comment for the full
// forensic before/after values this is based on).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AbilitySignal {
    // Ability has a real GSI `cooldown` that starts on cast (WK-106's
    // original, only, signal - unchanged, still confirmed correct by the
    // capture for every ability that uses it, e.g. Techies' Sticky Bomb and
    // Blast Off!).
    Cooldown,
    // Charge-based ability (separate `charges`/`charge_cooldown`/
    // `max_charges` fields, `cooldown` stays 0 and is never used) - a cast
    // consumes one charge. Mirrors ItemSignal::ChargesOrConsumed's charges
    // check, but abilities never get "consumed from a slot" the way an
    // item can, so there's no consumed-fallback branch here.
    Charges,
    // GSI renames this ability's own `name` to a "_stop"-suffixed variant
    // while toggled active, instead of pulsing `cooldown` at all (Techies'
    // Reactive Tazer). Only the confirmed activation direction (base name
    // -> alias) is treated as a cast - see TrackedAbility::toggle_active_alias
    // and events::detect_ability_events. The reverse (deactivation) rename
    // is not proven by the capture this is based on and is deliberately
    // left undetected rather than guessed at.
    ToggleActivateRename,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedAbility {
    pub id: String,
    pub display_name: String,
    pub icon_url: String,
    pub supported: bool,
    pub signal: Option<AbilitySignal>,
    // Only `Some` for `AbilitySignal::ToggleActivateRename` abilities - the
    // raw GSI `name` this ability's slot takes on while toggled active (see
    // events.rs's module doc comment: Reactive Tazer's GSI name flips to
    // this suffixed variant instead of pulsing a cooldown). `id` and every
    // catalog/binding lookup always use the base/canonical name; this is
    // purely the detector's "which renamed variant means activated" signal.
    pub toggle_active_alias: Option<&'static str>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
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

fn supported_ability(id: &str, display_name: &str, signal: AbilitySignal) -> TrackedAbility {
    TrackedAbility {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ABILITY_ICON_BASE}/{id}.png"),
        supported: true,
        signal: Some(signal),
        toggle_active_alias: None,
        reason: None,
    }
}

/// WK-107 - dedicated constructor for `AbilitySignal::ToggleActivateRename`
/// abilities, so the id and its activation-alias name are set together and
/// can't drift apart (see `TrackedAbility::toggle_active_alias`'s doc
/// comment).
fn supported_toggle_ability(id: &str, display_name: &str, active_alias: &'static str) -> TrackedAbility {
    TrackedAbility {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ABILITY_ICON_BASE}/{id}.png"),
        supported: true,
        signal: Some(AbilitySignal::ToggleActivateRename),
        toggle_active_alias: Some(active_alias),
        reason: None,
    }
}

fn unsupported_ability(id: &str, display_name: &str, reason: &str) -> TrackedAbility {
    TrackedAbility {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ABILITY_ICON_BASE}/{id}.png"),
        supported: false,
        signal: None,
        toggle_active_alias: None,
        reason: Some(reason.to_string()),
    }
}

const NO_COOLDOWN_TOGGLE: &str =
    "Тоггл-способность без кулдауна — включение/выключение невозможно надёжно отличить от других изменений состояния.";
const PASSIVE_NO_CAST: &str =
    "Пассивная способность — не имеет момента применения, который можно отследить.";
const PASSIVE_AUTO_PROC: &str =
    "Пассивный эффект срабатывает автоматически — это не явный каст игрока.";

// WK-106 research report, section C. Curated, representative subset (9
// heroes) rather than all 124 - each entry below is a real, long-stable
// Dota 2 internal ability name, picked specifically to show both reliable
// (has its own cooldown, matches events::detect_ability_events) and
// unreliable (toggle/passive, no meaningful cooldown transition) cases side
// by side, per the task's own instruction not to claim support just because
// an ability exists in hero metadata. Invoker is included deliberately as
// the flagship "unreliable ability class" case: its orb spells (quas/wex/
// exort) are leveled passives with no cast/cooldown at all, and `invoke`
// itself switches between an open-ended set of derived spells this v1's
// flat per-ability model can't represent - all four entries are marked
// unsupported rather than guessed at.
pub fn hero_catalog() -> Vec<TrackedHero> {
    vec![
        TrackedHero {
            id: "npc_dota_hero_pudge".into(),
            display_name: "Pudge".into(),
            icon_url: format!("{HERO_ICON_BASE}/pudge.png"),
            abilities: vec![
                supported_ability("pudge_meat_hook", "Meat Hook", AbilitySignal::Cooldown),
                unsupported_ability("pudge_rot", "Rot", NO_COOLDOWN_TOGGLE),
                unsupported_ability("pudge_flesh_heap", "Flesh Heap", PASSIVE_NO_CAST),
                supported_ability("pudge_dismember", "Dismember", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_axe".into(),
            display_name: "Axe".into(),
            icon_url: format!("{HERO_ICON_BASE}/axe.png"),
            abilities: vec![
                supported_ability("axe_berserkers_call", "Berserker's Call", AbilitySignal::Cooldown),
                supported_ability("axe_battle_hunger", "Battle Hunger", AbilitySignal::Cooldown),
                unsupported_ability("axe_counter_helix", "Counter Helix", PASSIVE_AUTO_PROC),
                supported_ability("axe_culling_blade", "Culling Blade", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_crystal_maiden".into(),
            display_name: "Crystal Maiden".into(),
            icon_url: format!("{HERO_ICON_BASE}/crystal_maiden.png"),
            abilities: vec![
                supported_ability("crystal_maiden_crystal_nova", "Crystal Nova", AbilitySignal::Cooldown),
                supported_ability("crystal_maiden_frostbite", "Frostbite", AbilitySignal::Cooldown),
                unsupported_ability("crystal_maiden_arcane_aura", "Arcane Aura", PASSIVE_NO_CAST),
                supported_ability("crystal_maiden_freezing_field", "Freezing Field", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_lion".into(),
            display_name: "Lion".into(),
            icon_url: format!("{HERO_ICON_BASE}/lion.png"),
            abilities: vec![
                supported_ability("lion_impale", "Earth Spike", AbilitySignal::Cooldown),
                supported_ability("lion_voodoo", "Hex", AbilitySignal::Cooldown),
                supported_ability("lion_mana_drain", "Mana Drain", AbilitySignal::Cooldown),
                supported_ability("lion_finger_of_death", "Finger of Death", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_juggernaut".into(),
            display_name: "Juggernaut".into(),
            icon_url: format!("{HERO_ICON_BASE}/juggernaut.png"),
            abilities: vec![
                supported_ability("juggernaut_blade_fury", "Blade Fury", AbilitySignal::Cooldown),
                supported_ability("juggernaut_healing_ward", "Healing Ward", AbilitySignal::Cooldown),
                unsupported_ability("juggernaut_blade_dance", "Blade Dance", PASSIVE_AUTO_PROC),
                supported_ability("juggernaut_omni_slash", "Omnislash", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_windrunner".into(),
            display_name: "Windranger".into(),
            icon_url: format!("{HERO_ICON_BASE}/windrunner.png"),
            abilities: vec![
                supported_ability("windrunner_shackleshot", "Shackleshot", AbilitySignal::Cooldown),
                supported_ability("windrunner_powershot", "Powershot", AbilitySignal::Cooldown),
                supported_ability("windrunner_windrun", "Windrun", AbilitySignal::Cooldown),
                supported_ability("windrunner_focusfire", "Focus Fire", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_sniper".into(),
            display_name: "Sniper".into(),
            icon_url: format!("{HERO_ICON_BASE}/sniper.png"),
            abilities: vec![
                supported_ability("sniper_shrapnel", "Shrapnel", AbilitySignal::Cooldown),
                unsupported_ability("sniper_headshot", "Headshot", PASSIVE_AUTO_PROC),
                unsupported_ability("sniper_take_aim", "Take Aim", PASSIVE_NO_CAST),
                supported_ability("sniper_assassinate", "Assassinate", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_nevermore".into(),
            display_name: "Shadow Fiend".into(),
            icon_url: format!("{HERO_ICON_BASE}/nevermore.png"),
            abilities: vec![
                supported_ability("nevermore_shadowraze1", "Shadowraze (Near)", AbilitySignal::Cooldown),
                unsupported_ability("nevermore_necromastery", "Necromastery", PASSIVE_NO_CAST),
                unsupported_ability(
                    "nevermore_presence_of_the_dark_lord",
                    "Presence of the Dark Lord",
                    PASSIVE_NO_CAST,
                ),
                supported_ability("nevermore_requiem", "Requiem of Souls", AbilitySignal::Cooldown),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_invoker".into(),
            display_name: "Invoker".into(),
            icon_url: format!("{HERO_ICON_BASE}/invoker.png"),
            abilities: vec![
                unsupported_ability("invoker_quas", "Quas", PASSIVE_NO_CAST),
                unsupported_ability("invoker_wex", "Wex", PASSIVE_NO_CAST),
                unsupported_ability("invoker_exort", "Exort", PASSIVE_NO_CAST),
                unsupported_ability(
                    "invoker_invoke",
                    "Invoke",
                    "Invoker переключается между открытым набором заклинаний, которые эта первая версия плоской модели способностей не различает — помечено unsupported, а не угадано.",
                ),
            ],
        },
        // WK-107 - added from a real production diagnostics capture (see
        // events.rs's module doc comment for the full forensic writeup),
        // not from assumption - the first hero in this catalog to be so.
        TrackedHero {
            id: "npc_dota_hero_techies".into(),
            display_name: "Techies".into(),
            icon_url: format!("{HERO_ICON_BASE}/techies.png"),
            abilities: vec![
                // Confirmed cast transition: cooldown 0 -> 7 (max_cooldown
                // 0 -> 8, can_cast true -> false) in the same tick.
                supported_ability("techies_sticky_bomb", "Sticky Bomb", AbilitySignal::Cooldown),
                // Confirmed activation transition: GSI `name` itself flips
                // "techies_reactive_tazer" -> "techies_reactive_tazer_stop"
                // (cooldown stays 0 throughout - only `max_cooldown` ticks
                // 0 -> 1, which is not itself used as the signal). The
                // reverse (deactivation) rename was not observed in the
                // capture this is based on and is not modeled - see
                // canonicalize_ability_name and events::detect_ability_events.
                supported_toggle_ability(
                    "techies_reactive_tazer",
                    "Reactive Tazer",
                    "techies_reactive_tazer_stop",
                ),
                // "Blast Off!" in current Dota's UI, internal name kept as
                // `techies_suicide` since the old self-destruct spell was
                // reworked. Confirmed cast transition: cooldown 0 -> 25
                // (max_cooldown 0 -> 26, can_cast true -> false).
                supported_ability("techies_suicide", "Blast Off!", AbilitySignal::Cooldown),
                // "Proximity Mines" in current Dota's UI, internal name kept
                // as `techies_land_mines`. Charge-based ultimate - `cooldown`
                // stays 0 the whole time; the confirmed cast transition is
                // `charges` 3 -> 2 with `charge_cooldown` 0 -> 15 in the same
                // tick. This is the one ability in this capture that a plain
                // cooldown-only detector could never have found at all.
                supported_ability("techies_land_mines", "Proximity Mines", AbilitySignal::Charges),
            ],
        },
    ]
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
        hero_catalog()
            .into_iter()
            .flat_map(|hero| hero.abilities)
            .map(|ability| (ability.id.clone(), ability))
            .collect()
    })
}

pub fn find_item(id: &str) -> Option<TrackedItem> {
    item_index().get(id).cloned()
}

/// Derived from each `TrackedAbility::toggle_active_alias` already in the
/// catalog (see `supported_toggle_ability`), not a second hand-maintained
/// list - the alias lives in exactly one place. Only abilities catalogued
/// with `AbilitySignal::ToggleActivateRename` (currently just Techies'
/// Reactive Tazer, confirmed by the WK-107 production capture) ever appear
/// here, so a future toggle ability only needs its catalog entry, not a
/// matching edit somewhere else that's easy to forget.
fn alias_index() -> &'static HashMap<&'static str, String> {
    static INDEX: OnceLock<HashMap<&'static str, String>> = OnceLock::new();
    INDEX.get_or_init(|| {
        hero_catalog()
            .into_iter()
            .flat_map(|hero| hero.abilities)
            .filter_map(|ability| ability.toggle_active_alias.map(|alias| (alias, ability.id)))
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
    fn unsupported_abilities_always_explain_why() {
        for hero in hero_catalog() {
            for ability in hero.abilities {
                assert_eq!(ability.reason.is_some(), !ability.supported, "{}", ability.id);
            }
        }
    }

    #[test]
    fn supported_abilities_always_carry_a_signal_and_unsupported_ones_never_do() {
        for hero in hero_catalog() {
            for ability in hero.abilities {
                assert_eq!(ability.signal.is_some(), ability.supported, "{}", ability.id);
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

    // WK-107 - reverses WK-106's "blood_grenade_is_not_present_anywhere_in_
    // the_catalog": a real production capture confirmed `item_blood_grenade`
    // is a genuine, distinct GSI item id (see the module doc comment and
    // events.rs's forensic writeup) - WK-106's assumption it wasn't a real
    // item has been disproven by actual data, not just relaxed.
    #[test]
    fn blood_grenade_is_present_and_supported() {
        let item = find_item("item_blood_grenade").expect("item_blood_grenade must be in the catalog");
        assert!(item.supported);
        assert_eq!(item.signal, Some(ItemSignal::ChargesOrConsumed));
    }

    #[test]
    fn techies_hero_has_all_four_captured_abilities_with_human_display_names() {
        let heroes = hero_catalog();
        let techies = heroes
            .iter()
            .find(|h| h.id == "npc_dota_hero_techies")
            .expect("Techies must be in the hero catalog");
        let by_id: std::collections::HashMap<&str, &TrackedAbility> =
            techies.abilities.iter().map(|a| (a.id.as_str(), a)).collect();

        assert_eq!(by_id["techies_sticky_bomb"].display_name, "Sticky Bomb");
        assert!(by_id["techies_sticky_bomb"].supported);

        assert_eq!(by_id["techies_reactive_tazer"].display_name, "Reactive Tazer");
        assert!(by_id["techies_reactive_tazer"].supported);
        // Not a second, separate ability entry for the "_stop" variant.
        assert!(!by_id.contains_key("techies_reactive_tazer_stop"));

        assert_eq!(by_id["techies_suicide"].display_name, "Blast Off!");
        assert!(by_id["techies_suicide"].supported);

        assert_eq!(by_id["techies_land_mines"].display_name, "Proximity Mines");
        assert!(by_id["techies_land_mines"].supported);
        assert_eq!(by_id["techies_land_mines"].signal, Some(AbilitySignal::Charges));
    }

    #[test]
    fn reactive_tazer_stop_alias_resolves_to_the_same_canonical_catalog_entry() {
        assert_eq!(canonicalize_ability_name("techies_reactive_tazer_stop"), "techies_reactive_tazer");
        assert_eq!(canonicalize_ability_name("techies_reactive_tazer"), "techies_reactive_tazer");
        let via_alias = find_ability("techies_reactive_tazer_stop").unwrap();
        let via_base = find_ability("techies_reactive_tazer").unwrap();
        assert_eq!(via_alias.id, via_base.id);
        assert_eq!(via_alias.toggle_active_alias, Some("techies_reactive_tazer_stop"));
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
}
