// Generates the item catalog for Dota package sounds from the same pinned
// odota/dotaconstants snapshot approach as the hero catalog
// (generate-game-sounds-hero-catalog.mjs). Dev-time only: the package reads
// the committed generated_item_catalog.json via include_str!, never the
// network.
//
// Classification is deliberately conservative, for the same reason as the
// hero catalog: metadata describes tooltips, not what GSI reports.
//  - CONFIRMED: items a real GSI capture proved (kept as "supported").
//  - an item with an active/use/toggle ability: "experimental" - a sound can
//    be bound; the signal (charges for consumables, cooldown otherwise) is a
//    guess until a capture confirms it.
//  - only passive abilities: unsupported ("пассивный предмет").
//  - EXPLAINED: hand-written reasons that override everything else.
// Groups come from the data (consumable / component / secret shop / quality
// / neutral tier), not from a hand-maintained shop-tab map.
//
// To refresh for a new patch: bump SOURCE_COMMIT, run
// `node scripts/generate-game-sounds-item-catalog.mjs`, review the diff.

import { writeFile } from "node:fs/promises";

const SOURCE_COMMIT = "5c0242df9057848fa2036ca3fafe9f2bd4508163";
const RAW = `https://raw.githubusercontent.com/odota/dotaconstants/${SOURCE_COMMIT}/build/items.json`;
const OUTPUT = new URL("../plugins/dota-domain/src/generated_item_catalog.json", import.meta.url);
const CDN = "https://cdn.cloudflare.steamstatic.com";

// Proven by real production GSI captures (WK-106/107); see events.rs.
const CONFIRMED = {
  tango: "chargesOrConsumed", blood_grenade: "chargesOrConsumed", flask: "chargesOrConsumed",
  enchanted_mango: "chargesOrConsumed", clarity: "chargesOrConsumed", faerie_fire: "chargesOrConsumed",
  smoke_of_deceit: "chargesOrConsumed", dust: "chargesOrConsumed", tpscroll: "chargesOrConsumed",
  blink: "cooldown", black_king_bar: "cooldown", cyclone: "cooldown", force_staff: "cooldown",
  glimmer_cape: "cooldown", ghost: "cooldown", hand_of_midas: "cooldown", urn_of_shadows: "cooldown",
};
const EXPLAINED = {
  power_treads: "Переключение атрибута не создаёт отдельного события в GSI; нужна проверка на записи.",
  infused_raindrop: "Срабатывает автоматически от магического урона — это не действие игрока.",
};
// Free but usable items that the "has a price" rule would drop.
const EXTRA = ["aegis", "cheese", "refresher_shard", "ward_observer", "ward_sentry", "ward_dispenser"];
// Priced entries that are no longer in the game.
const REMOVED = new Set(["trident"]);

const GROUP = (key, item) => {
  if (item.tier) return `neutral${item.tier}`;
  const qual = String(item.qual ?? "");
  if (qual.startsWith("consumable") || ["aegis", "cheese", "refresher_shard", "ward_observer", "ward_sentry", "ward_dispenser"].includes(key)) return "consumables";
  if (qual === "secret_shop") return "secretShop";
  if (qual === "component" || !item.created) return "components";
  return ["common", "rare", "epic", "artifact"].includes(qual) ? qual : "common";
};

const items = await (await fetch(RAW)).json();
const entries = Object.entries(items)
  .filter(([key, item]) => item.dname && !key.startsWith("recipe") && !REMOVED.has(key)
    && ((item.cost ?? 0) > 0 || item.tier || EXTRA.includes(key)))
  .map(([key, item]) => {
    const types = (item.abilities ?? []).map((a) => a.type);
    const active = types.some((t) => t === "active" || t === "use" || t === "toggle");
    const consumable = String(item.qual ?? "").startsWith("consumable") || (item.charges && item.charges !== false);
    const image = String(item.img ?? `/apps/dota2/images/dota_react/items/${key}.png`).split("?")[0];
    const base = { id: `item_${key}`, displayName: item.dname, iconUrl: `${CDN}${image}`, category: GROUP(key, item) };
    if (EXPLAINED[key]) return { ...base, supported: false, experimental: false, signal: null, reason: EXPLAINED[key] };
    if (CONFIRMED[key]) return { ...base, supported: true, experimental: false, signal: CONFIRMED[key], reason: null };
    if (active) return { ...base, supported: true, experimental: true, signal: consumable ? "chargesOrConsumed" : "cooldown", reason: null };
    return { ...base, supported: false, experimental: false, signal: null, reason: "Пассивный предмет — момента использования нет." };
  })
  .sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName));

await writeFile(OUTPUT, JSON.stringify({ source: `odota/dotaconstants@${SOURCE_COMMIT}`, items: entries }, null, 1) + "\n");
const count = (f) => entries.filter(f).length;
console.log(`${entries.length} items: ${count((i) => i.supported && !i.experimental)} confirmed, ${count((i) => i.experimental)} experimental, ${count((i) => !i.supported)} unsupported`);
