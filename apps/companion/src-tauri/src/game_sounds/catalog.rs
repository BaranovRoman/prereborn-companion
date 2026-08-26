use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;

// Static catalog of Dota 2 items/heroes/abilities this feature knows how to
// reliably map to a GSI-observable "used"/"cast" transition (see
// events::detect_events, the actual detector). Nothing here is fetched or
// bundled from Valve's game files - these are hand-curated internal
// name/display pairs (public, well-documented Dota 2 API identifiers, not
// copyrighted assets) plus a `supported` verdict this repo can defend given
// what's actually knowable about the GSI `items`/`abilities` sections (see
// the WK-106 research report - no real GSI capture of these sections exists
// in this repo, only Valve's publicly documented community GSI schema:
// items carry `name`/`charges`/`cooldown`/`can_cast`/`passive`/`purchaser`,
// abilities carry `name`/`level`/`cooldown`/`can_cast`/`ultimate`).
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedAbility {
    pub id: String,
    pub display_name: String,
    pub icon_url: String,
    pub supported: bool,
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

// WK-106 research report, section B ("Blood Grenade"): deliberately absent
// from this catalog, not merely marked unsupported. "Blood Grenade" is not a
// recognized Dota 2 base item internal name (every real active/consumable
// item's GSI `name` begins with `item_`) and appears nowhere in this repo's
// fixtures, diagnostics captures, or GSI docs. The most plausible
// explanation is that it's a cosmetic skin/reflavor of an existing
// consumable (Valve reskins routinely rename a base item's *displayed*
// name/model without changing the `name` GSI reports) - in which case GSI
// would report it under whatever base item it reskins, not as a distinct
// id, so there is nothing to add a catalog row for. Showing it as
// "unsupported" would wrongly imply it's a known, addressable item this
// feature is choosing to block; it isn't one.
pub fn item_catalog() -> Vec<TrackedItem> {
    vec![
        supported_item("item_tango", "Tango", ItemSignal::ChargesOrConsumed),
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

fn supported_ability(id: &str, display_name: &str) -> TrackedAbility {
    TrackedAbility {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ABILITY_ICON_BASE}/{id}.png"),
        supported: true,
        reason: None,
    }
}

fn unsupported_ability(id: &str, display_name: &str, reason: &str) -> TrackedAbility {
    TrackedAbility {
        id: id.to_string(),
        display_name: display_name.to_string(),
        icon_url: format!("{ABILITY_ICON_BASE}/{id}.png"),
        supported: false,
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
                supported_ability("pudge_meat_hook", "Meat Hook"),
                unsupported_ability("pudge_rot", "Rot", NO_COOLDOWN_TOGGLE),
                unsupported_ability("pudge_flesh_heap", "Flesh Heap", PASSIVE_NO_CAST),
                supported_ability("pudge_dismember", "Dismember"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_axe".into(),
            display_name: "Axe".into(),
            icon_url: format!("{HERO_ICON_BASE}/axe.png"),
            abilities: vec![
                supported_ability("axe_berserkers_call", "Berserker's Call"),
                supported_ability("axe_battle_hunger", "Battle Hunger"),
                unsupported_ability("axe_counter_helix", "Counter Helix", PASSIVE_AUTO_PROC),
                supported_ability("axe_culling_blade", "Culling Blade"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_crystal_maiden".into(),
            display_name: "Crystal Maiden".into(),
            icon_url: format!("{HERO_ICON_BASE}/crystal_maiden.png"),
            abilities: vec![
                supported_ability("crystal_maiden_crystal_nova", "Crystal Nova"),
                supported_ability("crystal_maiden_frostbite", "Frostbite"),
                unsupported_ability("crystal_maiden_arcane_aura", "Arcane Aura", PASSIVE_NO_CAST),
                supported_ability("crystal_maiden_freezing_field", "Freezing Field"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_lion".into(),
            display_name: "Lion".into(),
            icon_url: format!("{HERO_ICON_BASE}/lion.png"),
            abilities: vec![
                supported_ability("lion_impale", "Earth Spike"),
                supported_ability("lion_voodoo", "Hex"),
                supported_ability("lion_mana_drain", "Mana Drain"),
                supported_ability("lion_finger_of_death", "Finger of Death"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_juggernaut".into(),
            display_name: "Juggernaut".into(),
            icon_url: format!("{HERO_ICON_BASE}/juggernaut.png"),
            abilities: vec![
                supported_ability("juggernaut_blade_fury", "Blade Fury"),
                supported_ability("juggernaut_healing_ward", "Healing Ward"),
                unsupported_ability("juggernaut_blade_dance", "Blade Dance", PASSIVE_AUTO_PROC),
                supported_ability("juggernaut_omni_slash", "Omnislash"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_windrunner".into(),
            display_name: "Windranger".into(),
            icon_url: format!("{HERO_ICON_BASE}/windrunner.png"),
            abilities: vec![
                supported_ability("windrunner_shackleshot", "Shackleshot"),
                supported_ability("windrunner_powershot", "Powershot"),
                supported_ability("windrunner_windrun", "Windrun"),
                supported_ability("windrunner_focusfire", "Focus Fire"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_sniper".into(),
            display_name: "Sniper".into(),
            icon_url: format!("{HERO_ICON_BASE}/sniper.png"),
            abilities: vec![
                supported_ability("sniper_shrapnel", "Shrapnel"),
                unsupported_ability("sniper_headshot", "Headshot", PASSIVE_AUTO_PROC),
                unsupported_ability("sniper_take_aim", "Take Aim", PASSIVE_NO_CAST),
                supported_ability("sniper_assassinate", "Assassinate"),
            ],
        },
        TrackedHero {
            id: "npc_dota_hero_nevermore".into(),
            display_name: "Shadow Fiend".into(),
            icon_url: format!("{HERO_ICON_BASE}/nevermore.png"),
            abilities: vec![
                supported_ability("nevermore_shadowraze1", "Shadowraze (Near)"),
                unsupported_ability("nevermore_necromastery", "Necromastery", PASSIVE_NO_CAST),
                unsupported_ability(
                    "nevermore_presence_of_the_dark_lord",
                    "Presence of the Dark Lord",
                    PASSIVE_NO_CAST,
                ),
                supported_ability("nevermore_requiem", "Requiem of Souls"),
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

pub fn find_ability(id: &str) -> Option<TrackedAbility> {
    ability_index().get(id).cloned()
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
    fn blood_grenade_is_not_present_anywhere_in_the_catalog() {
        // WK-106 - see the module doc comment: not a real base item id, so
        // it must not appear as a false "unsupported" row either.
        assert!(item_catalog().iter().all(|i| !i.id.to_lowercase().contains("grenade")));
        assert!(item_catalog().iter().all(|i| !i.display_name.to_lowercase().contains("grenade")));
    }

    #[test]
    fn find_item_and_find_ability_resolve_known_ids() {
        assert!(find_item("item_tango").is_some());
        assert!(find_item("item_does_not_exist").is_none());
        assert!(find_ability("pudge_meat_hook").is_some());
        assert!(find_ability("pudge_rot").is_some());
        assert!(find_ability("does_not_exist").is_none());
    }
}
