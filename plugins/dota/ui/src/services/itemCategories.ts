// WK-122 §13 - Sounds → "Предметы" catalog grouping. The Rust catalog
// (`apps/companion/src-tauri/src/game_sounds/catalog.rs::item_catalog`) is
// the single source of truth for WHICH items exist and whether Game Sounds
// supports them - this file only adds a presentation-layer grouping on top
// of that fixed, small (~20 item) list, mirroring the real Dota 2 shop's
// tab structure (Основные/Улучшения/Нейтральные) rather than a flat list.
//
// Категории ниже НЕ придуманы произвольно: cost/quality tier per item was
// cross-checked against OpenDota's public item constants
// (https://api.opendota.com/api/constants/items, fetched 2026-08-29) to
// confirm price tier and Valve's own `qual` tag before assigning a shop
// group - that endpoint does not expose the actual shop-tab/category label
// itself (only `qual`, a rarity/border-color tag, and `cost`), so the
// specific category within a group (e.g. "Поддержка" vs "Магия") is a
// documented judgement call from established, stable Dota 2 shop knowledge
// for these specific, long-unchanged items - never a guess for the sake of
// filling every category. Items whose real shop placement is genuinely
// ambiguous are called out per-entry below rather than silently assigned.
export type ItemCategoryGroup = "basics" | "upgrades" | "neutral";

export const ITEM_CATEGORY_GROUP_LABEL: Record<ItemCategoryGroup, string> = {
  basics: "Основные",
  upgrades: "Улучшения",
  neutral: "Нейтральные",
};

export type ItemCategory =
  | "consumables"
  | "attributes"
  | "equipment"
  | "misc"
  | "secretShop"
  | "accessories"
  | "support"
  | "magic"
  | "armor"
  | "weapons"
  | "armament"
  | "neutral";

export const ITEM_CATEGORY_LABEL: Record<ItemCategory, string> = {
  consumables: "Расходники",
  attributes: "Атрибуты",
  equipment: "Снаряжение",
  misc: "Разное",
  secretShop: "Потайная лавка",
  accessories: "Аксессуары",
  support: "Поддержка",
  magic: "Магия",
  armor: "Броня",
  weapons: "Оружие",
  armament: "Вооружение",
  neutral: "Тиры",
};

export const ITEM_CATEGORY_GROUP: Record<ItemCategory, ItemCategoryGroup> = {
  consumables: "basics",
  attributes: "basics",
  equipment: "basics",
  misc: "basics",
  secretShop: "basics",
  accessories: "upgrades",
  support: "upgrades",
  magic: "upgrades",
  armor: "upgrades",
  weapons: "upgrades",
  armament: "upgrades",
  neutral: "neutral",
};

// Display order within each group - matches the task's own example ordering.
export const ITEM_CATEGORY_ORDER: ItemCategory[] = [
  "consumables", "attributes", "equipment", "misc", "secretShop",
  "accessories", "support", "magic", "armor", "weapons", "armament",
  "neutral",
];

// Keyed by the exact `TrackedItem.id` the Rust catalog emits (`item_xxx`).
// Every id in catalog.rs's `item_catalog()` MUST have an entry here -
// `categoryOf` below falls back to "misc" (never throws) for anything
// missing, but that fallback existing is not licence to skip an entry when
// a new item is added to the Rust catalog.
const ITEM_CATEGORIES: Record<string, ItemCategory> = {
  // Основные → Расходники - cheap, stackable, used-up consumables. Unambiguous.
  item_tango: "consumables",
  item_flask: "consumables",
  item_enchanted_mango: "consumables",
  item_clarity: "consumables",
  item_faerie_fire: "consumables",
  item_tpscroll: "consumables",

  // Основные → Потайная лавка - Smoke of Deceit, Dust of Appearance, and
  // Infused Raindrop are specifically Secret Shop stock in live Dota 2, not
  // regular Basics consumables (confirmed - these three have been Secret
  // Shop items across every recent shop redesign).
  item_smoke_of_deceit: "secretShop",
  item_dust: "secretShop",
  item_infused_raindrop: "secretShop",

  // Основные → Атрибуты - cheap early stat item.
  item_bracer: "attributes",

  // Основные → Снаряжение - boots.
  item_power_treads: "equipment",

  // Основные → Разное - Blood Grenade is Techies' innate ability rendered
  // as an item-shaped GSI slot (see catalog.rs's WK-107 comment) - it is
  // NOT purchasable in any shop tab at all. "Разное" is the honest bucket
  // for "doesn't belong in a real shop category" rather than forcing it
  // into Consumables just because its GSI signal matches one.
  item_blood_grenade: "misc",

  // Улучшения → Поддержка - Force Staff/Glimmer Cape/Ghost Scepter/Urn of
  // Shadows are all classic teamfight-support/save items in live Dota 2.
  item_force_staff: "support",
  item_glimmer_cape: "support",
  item_ghost: "support",
  item_urn_of_shadows: "support",

  // Улучшения → Магия - BKB (magic immunity) and Eul's Scepter (magic
  // dispel/disable) are both defined by their magic-school effect.
  item_black_king_bar: "magic",
  item_cyclone: "magic",

  // Улучшения → Аксессуары - the catch-all for this catalog's remaining
  // upgrade-tier items, each a genuine judgement call rather than a clean
  // fit for Оружие/Броня/Вооружение: Blink Dagger (pure mobility, no
  // weapon/armor role), Hand of Midas (economy item, no combat role), Yasha
  // and Kaya (stat + minor-effect items - Dota itself groups these under a
  // generic "Attributes"-flavored bucket at the Upgrades tier, closest to
  // this list's "Аксессуары").
  item_blink: "accessories",
  item_hand_of_midas: "accessories",
  item_yasha: "accessories",
  item_kaya: "accessories",
};

export function categoryOf(itemId: string): ItemCategory {
  return ITEM_CATEGORIES[itemId] ?? "misc";
}
