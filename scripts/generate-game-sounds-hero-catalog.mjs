// WK-108 - generates the versioned hero/ability catalog for Custom Game
// Sounds (apps/companion/src-tauri/src/game_sounds) from a real, stable
// Dota 2 metadata snapshot instead of a hand-typed hero list.
//
// Source: odota/dotaconstants (https://github.com/odota/dotaconstants) -
// the same generated-from-Valve's-own-game-files data OpenDota/Dotabuff and
// most of the Dota tooling ecosystem already build on. Pinned to a specific
// commit (not `master`) so re-running this script without updating
// SOURCE_COMMIT reproduces byte-identical output - "deterministic,
// versionable, no runtime network dependency" per the task: this script
// only ever runs at DEV TIME to regenerate the checked-in snapshot
// (generated_hero_catalog.json); Companion itself never fetches this data,
// it only ever reads the committed file via `include_str!`.
//
// To refresh the catalog for a new Dota patch: bump SOURCE_COMMIT to a
// newer dotaconstants commit, re-run `node scripts/generate-game-sounds-hero-catalog.mjs`,
// review the diff (especially any ability whose classification changed),
// and re-run the Rust catalog tests.
//
// IMPORTANT LESSON BAKED INTO THIS SCRIPT'S CLASSIFICATION (see WK-108
// forensic notes): dotaconstants' `cd` (cooldown) and `behavior` fields
// describe an ability's tooltip/design, NOT necessarily what Dota's GSI
// actually reports at runtime. Techies' Reactive Tazer has a perfectly
// normal-looking `cd: ["26","22","18","14"]` in this metadata, but real
// production GSI capture (WK-107) proved its cooldown field never actually
// moves - the real cast signal is a `name` rename instead. Because of this,
// metadata alone can NEVER justify "supported" here, only "experimental"
// (a reasonable best-effort guess, explicitly unverified). "Supported" is
// reserved for the small, hand-maintained CAPTURE_CONFIRMED_OVERRIDES list
// below - abilities this repo has actually seen a real GSI transition for.

import { writeFile } from "node:fs/promises";

const SOURCE_COMMIT = "e7705ee975ebec2a88a59a7b455d4cae5dc69ca1";
const RAW_BASE = `https://raw.githubusercontent.com/odota/dotaconstants/${SOURCE_COMMIT}/build`;
const OUTPUT_PATH = new URL(
  "../apps/companion/src-tauri/src/game_sounds/generated_hero_catalog.json",
  import.meta.url
);

const HERO_ICON_BASE = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes";
const ABILITY_ICON_BASE = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/abilities";

const REASON_NO_CAPTURE = "Способность похожа на обычный cast с кулдауном по метаданным Dota, но реальное GSI-поведение не подтверждено реальным capture — возможны случаи вроде Reactive Tazer, где метаданные вводят в заблуждение.";
const REASON_PASSIVE = "Пассивная способность/эффект по метаданным Dota — не имеет момента явного применения игроком.";
const REASON_NO_COOLDOWN = "Метаданные Dota не сообщают кулдаун для этой способности — нет сигнала, на основе которого можно строить detection.";
const REASON_DYNAMIC_SLOT = "Способность героя с динамическим набором заклинаний (Invoker) — неизвестно, появляется ли она в ability slot стабильным для detection образом; реальный live-capture не проводился.";

// WK-107/108 - abilities this repo has ACTUAL real-capture evidence for.
// Every other ability in the generated catalog is "experimental" at best -
// see the module doc comment above.
const CAPTURE_CONFIRMED_OVERRIDES = {
  techies_sticky_bomb: { status: "supported", signal: "cooldown" },
  techies_reactive_tazer: { status: "supported", signal: "toggleActivateRename", toggleActiveAlias: "techies_reactive_tazer_stop" },
  techies_suicide: { status: "supported", signal: "cooldown" },
  techies_land_mines: { status: "supported", signal: "charges" },
};

// WK-108 - Invoker's invoke-spells are real, well-documented internal
// ability names, but this repo has never captured real GSI for Invoker:
// it's unknown whether an invoked spell (e.g. `invoker_cold_snap`) even
// occupies a stable ability slot the way a normal hero's abilities do, or
// whether it swaps in/out of a shared slot the same way Invoker's own
// client UI does. Force-classified experimental with a dedicated reason
// (distinct from the generic "no capture" reason) rather than letting the
// generic cd/behavior heuristic silently call them ordinary abilities.
const INVOKER_DYNAMIC_ABILITY_IDS = new Set([
  "invoker_quas", "invoker_wex", "invoker_exort", "invoker_invoke",
  "invoker_cold_snap", "invoker_ghost_walk", "invoker_ice_wall", "invoker_emp",
  "invoker_tornado", "invoker_alacrity", "invoker_sun_strike", "invoker_forge_spirit",
  "invoker_chaos_meteor", "invoker_deafening_blast",
]);

function behaviorList(behavior) {
  if (behavior == null) return [];
  return Array.isArray(behavior) ? behavior : [behavior];
}

/** False for a missing `cd`, and also for a `cd` that is always exactly 0 at every level (e.g. Invoker's Quas/Wex/Exort) - the Cooldown-transition detector (prev<=0 && curr>0) can mechanically never fire against a value that never leaves 0, so that's the same "no usable signal" case as a missing cd, not merely "unverified". */
function hasRealCooldown(cd) {
  if (cd == null) return false;
  const values = Array.isArray(cd) ? cd : [cd];
  return values.some((v) => Number.parseFloat(v) > 0);
}

/** Classifies one ability from dotaconstants metadata alone (no capture) - see the module doc comment for why this can only ever produce "experimental" or "unsupported", never "supported". */
function classifyGeneric(ability) {
  const behaviors = behaviorList(ability.behavior);
  if (behaviors.includes("Passive")) {
    return { status: "unsupported", reason: REASON_PASSIVE };
  }
  if (!hasRealCooldown(ability.cd)) {
    return { status: "unsupported", reason: REASON_NO_COOLDOWN };
  }
  return { status: "experimental", signal: "cooldown", reason: REASON_NO_CAPTURE };
}

// Valve's generic placeholder display names for a dynamic slot that
// currently has nothing invoked/stolen into it (Invoker/Rubick) - not a
// real ability at all, just a "this slot is empty right now" marker that
// happens to carry a dname and a (Passive) behavior, so it survives the
// dname/Hidden checks below on its own.
const PLACEHOLDER_DNAMES = new Set(["Invoked Spell", "Stolen Spell"]);

/**
 * True for internal bookkeeping "abilities" that are never a real
 * player-facing cast (hidden sub-effects, disabled/placeholder slots) -
 * excluded from the catalog entirely rather than shown as unsupported.
 *
 * WK-108 research finding: dotaconstants marks all ten of Invoker's actual
 * invoke-spells (Cold Snap, Ghost Walk, Ice Wall, EMP, Tornado, Alacrity,
 * Sun Strike, Forge Spirit, Chaos Meteor, Deafening Blast) with a "Hidden"
 * behavior tag too - because they have no *fixed* HUD slot, not because
 * they're an internal sub-effect the way Largo's Hidden song abilities are.
 * A blind "Hidden -> exclude" rule would silently drop all ten real,
 * player-castable invoke-spells from the catalog. INVOKER_DYNAMIC_ABILITY_IDS
 * is the explicit, hand-verified allowlist that overrides the generic
 * Hidden exclusion for exactly these ten ids - everything else tagged
 * Hidden is still excluded as before.
 */
function isExcluded(id, ability) {
  if (!ability) return true;
  if (!ability.dname) return true;
  if (PLACEHOLDER_DNAMES.has(ability.dname)) return true;
  if (INVOKER_DYNAMIC_ABILITY_IDS.has(id)) return false;
  if (behaviorList(ability.behavior).includes("Hidden")) return true;
  if (id.startsWith("generic_")) return true;
  if (/_(empty|hidden)\d*$/.test(id)) return true;
  return false;
}

async function fetchJson(name) {
  const res = await fetch(`${RAW_BASE}/${name}`);
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  return res.json();
}

const [heroes, heroAbilities, abilities] = await Promise.all([
  fetchJson("heroes.json"),
  fetchJson("hero_abilities.json"),
  fetchJson("abilities.json"),
]);

const generatedHeroes = Object.values(heroes)
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((hero) => {
    const shortName = hero.name.replace(/^npc_dota_hero_/, "");
    const abilityIds = heroAbilities[hero.name]?.abilities ?? [];
    const generatedAbilities = abilityIds
      .filter((id) => !isExcluded(id, abilities[id]))
      .map((id) => {
        const ability = abilities[id];
        const override = CAPTURE_CONFIRMED_OVERRIDES[id];
        const forceDynamic = INVOKER_DYNAMIC_ABILITY_IDS.has(id);
        const classification = override
          ? { status: override.status, signal: override.signal, toggleActiveAlias: override.toggleActiveAlias ?? null, reason: null }
          : forceDynamic
            ? { status: "experimental", signal: "cooldown", reason: REASON_DYNAMIC_SLOT }
            : { ...classifyGeneric(ability), toggleActiveAlias: null };
        return {
          id,
          displayName: ability.dname,
          iconUrl: `${ABILITY_ICON_BASE}/${id}.png`,
          status: classification.status,
          signal: classification.status === "unsupported" ? null : (classification.signal ?? "cooldown"),
          toggleActiveAlias: classification.toggleActiveAlias ?? null,
          // "supported" abilities are capture-proven and need no caveat -
          // both "experimental" and "unsupported" always carry a reason so
          // the UI can explain the uncertainty either way (see WK-108's
          // classifyGeneric/INVOKER_DYNAMIC_ABILITY_IDS - an "experimental"
          // entry's reason is exactly as important as an "unsupported"
          // one's).
          reason: classification.status === "supported" ? null : (classification.reason ?? REASON_NO_CAPTURE),
        };
      });
    return {
      id: hero.name,
      displayName: hero.localized_name,
      iconUrl: `${HERO_ICON_BASE}/${shortName}.png`,
      abilities: generatedAbilities,
    };
  });

const output = {
  source: "https://github.com/odota/dotaconstants",
  sourceCommit: SOURCE_COMMIT,
  generatedAt: new Date().toISOString(),
  heroCount: generatedHeroes.length,
  heroes: generatedHeroes,
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

const counts = { supported: 0, experimental: 0, unsupported: 0 };
for (const hero of generatedHeroes) {
  for (const ability of hero.abilities) counts[ability.status]++;
}
console.log(`Wrote ${generatedHeroes.length} heroes to ${OUTPUT_PATH.pathname}`);
console.log(`Abilities: supported=${counts.supported} experimental=${counts.experimental} unsupported=${counts.unsupported}`);
