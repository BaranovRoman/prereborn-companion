// WK-116 - ported from apps/web/src/entities/dota-hero/model/heroes.ts
// (id/name/localizedName only - web's imageUrl/videoUrl/featuredVideoUrl/
// favoriteVideoUrl fields depend on web-only media helpers Companion has
// no use for). Same static data (127 heroes, from api.opendota.com/api/
// heroes, committed rather than fetched at runtime - same rationale as
// web's own comment: no new endpoint, no runtime dependency on an
// external API), same Valve CDN icon URL pattern Companion's own Rust
// hero-sounds catalog already uses (see
// apps/companion/src-tauri/src/game_sounds/catalog.rs's `ITEM_ICON_BASE`
// sibling for heroes, generated_hero_catalog.json's `iconUrl` field).
//
// Exists to bridge two different hero-id systems that don't otherwise
// meet in the frontend: GSI/local-match data (`LocalMatchSummary.heroId`,
// see types/status.ts) carries Dota's numeric hero id (e.g. 14 = Pudge),
// while the game-sounds catalog (`TrackedHero.id`, from
// dotaCompanionApi.ts) carries the string `npc_dota_hero_<name>` id. This
// file is keyed by both, via `getHeroById` (numeric) and
// `getHeroByInternalName` (string, after stripping the `npc_dota_hero_`
// prefix) - see HomePage.tsx and HeroesGrid.tsx for each use site.
interface RawHero {
  id: number;
  name: string;
  localizedName: string;
}

const HERO_ICON_BASE = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes";

const RAW_HEROES: RawHero[] = [
  { id: 1, name: "antimage", localizedName: "Anti-Mage" },
  { id: 2, name: "axe", localizedName: "Axe" },
  { id: 3, name: "bane", localizedName: "Bane" },
  { id: 4, name: "bloodseeker", localizedName: "Bloodseeker" },
  { id: 5, name: "crystal_maiden", localizedName: "Crystal Maiden" },
  { id: 6, name: "drow_ranger", localizedName: "Drow Ranger" },
  { id: 7, name: "earthshaker", localizedName: "Earthshaker" },
  { id: 8, name: "juggernaut", localizedName: "Juggernaut" },
  { id: 9, name: "mirana", localizedName: "Mirana" },
  { id: 10, name: "morphling", localizedName: "Morphling" },
  { id: 11, name: "nevermore", localizedName: "Shadow Fiend" },
  { id: 12, name: "phantom_lancer", localizedName: "Phantom Lancer" },
  { id: 13, name: "puck", localizedName: "Puck" },
  { id: 14, name: "pudge", localizedName: "Pudge" },
  { id: 15, name: "razor", localizedName: "Razor" },
  { id: 16, name: "sand_king", localizedName: "Sand King" },
  { id: 17, name: "storm_spirit", localizedName: "Storm Spirit" },
  { id: 18, name: "sven", localizedName: "Sven" },
  { id: 19, name: "tiny", localizedName: "Tiny" },
  { id: 20, name: "vengefulspirit", localizedName: "Vengeful Spirit" },
  { id: 21, name: "windrunner", localizedName: "Windranger" },
  { id: 22, name: "zuus", localizedName: "Zeus" },
  { id: 23, name: "kunkka", localizedName: "Kunkka" },
  { id: 25, name: "lina", localizedName: "Lina" },
  { id: 26, name: "lion", localizedName: "Lion" },
  { id: 27, name: "shadow_shaman", localizedName: "Shadow Shaman" },
  { id: 28, name: "slardar", localizedName: "Slardar" },
  { id: 29, name: "tidehunter", localizedName: "Tidehunter" },
  { id: 30, name: "witch_doctor", localizedName: "Witch Doctor" },
  { id: 31, name: "lich", localizedName: "Lich" },
  { id: 32, name: "riki", localizedName: "Riki" },
  { id: 33, name: "enigma", localizedName: "Enigma" },
  { id: 34, name: "tinker", localizedName: "Tinker" },
  { id: 35, name: "sniper", localizedName: "Sniper" },
  { id: 36, name: "necrolyte", localizedName: "Necrophos" },
  { id: 37, name: "warlock", localizedName: "Warlock" },
  { id: 38, name: "beastmaster", localizedName: "Beastmaster" },
  { id: 39, name: "queenofpain", localizedName: "Queen of Pain" },
  { id: 40, name: "venomancer", localizedName: "Venomancer" },
  { id: 41, name: "faceless_void", localizedName: "Faceless Void" },
  { id: 42, name: "skeleton_king", localizedName: "Wraith King" },
  { id: 43, name: "death_prophet", localizedName: "Death Prophet" },
  { id: 44, name: "phantom_assassin", localizedName: "Phantom Assassin" },
  { id: 45, name: "pugna", localizedName: "Pugna" },
  { id: 46, name: "templar_assassin", localizedName: "Templar Assassin" },
  { id: 47, name: "viper", localizedName: "Viper" },
  { id: 48, name: "luna", localizedName: "Luna" },
  { id: 49, name: "dragon_knight", localizedName: "Dragon Knight" },
  { id: 50, name: "dazzle", localizedName: "Dazzle" },
  { id: 51, name: "rattletrap", localizedName: "Clockwerk" },
  { id: 52, name: "leshrac", localizedName: "Leshrac" },
  { id: 53, name: "furion", localizedName: "Nature's Prophet" },
  { id: 54, name: "life_stealer", localizedName: "Lifestealer" },
  { id: 55, name: "dark_seer", localizedName: "Dark Seer" },
  { id: 56, name: "clinkz", localizedName: "Clinkz" },
  { id: 57, name: "omniknight", localizedName: "Omniknight" },
  { id: 58, name: "enchantress", localizedName: "Enchantress" },
  { id: 59, name: "huskar", localizedName: "Huskar" },
  { id: 60, name: "night_stalker", localizedName: "Night Stalker" },
  { id: 61, name: "broodmother", localizedName: "Broodmother" },
  { id: 62, name: "bounty_hunter", localizedName: "Bounty Hunter" },
  { id: 63, name: "weaver", localizedName: "Weaver" },
  { id: 64, name: "jakiro", localizedName: "Jakiro" },
  { id: 65, name: "batrider", localizedName: "Batrider" },
  { id: 66, name: "chen", localizedName: "Chen" },
  { id: 67, name: "spectre", localizedName: "Spectre" },
  { id: 68, name: "ancient_apparition", localizedName: "Ancient Apparition" },
  { id: 69, name: "doom_bringer", localizedName: "Doom" },
  { id: 70, name: "ursa", localizedName: "Ursa" },
  { id: 71, name: "spirit_breaker", localizedName: "Spirit Breaker" },
  { id: 72, name: "gyrocopter", localizedName: "Gyrocopter" },
  { id: 73, name: "alchemist", localizedName: "Alchemist" },
  { id: 74, name: "invoker", localizedName: "Invoker" },
  { id: 75, name: "silencer", localizedName: "Silencer" },
  { id: 76, name: "obsidian_destroyer", localizedName: "Outworld Destroyer" },
  { id: 77, name: "lycan", localizedName: "Lycan" },
  { id: 78, name: "brewmaster", localizedName: "Brewmaster" },
  { id: 79, name: "shadow_demon", localizedName: "Shadow Demon" },
  { id: 80, name: "lone_druid", localizedName: "Lone Druid" },
  { id: 81, name: "chaos_knight", localizedName: "Chaos Knight" },
  { id: 82, name: "meepo", localizedName: "Meepo" },
  { id: 83, name: "treant", localizedName: "Treant Protector" },
  { id: 84, name: "ogre_magi", localizedName: "Ogre Magi" },
  { id: 85, name: "undying", localizedName: "Undying" },
  { id: 86, name: "rubick", localizedName: "Rubick" },
  { id: 87, name: "disruptor", localizedName: "Disruptor" },
  { id: 88, name: "nyx_assassin", localizedName: "Nyx Assassin" },
  { id: 89, name: "naga_siren", localizedName: "Naga Siren" },
  { id: 90, name: "keeper_of_the_light", localizedName: "Keeper of the Light" },
  { id: 91, name: "wisp", localizedName: "Io" },
  { id: 92, name: "visage", localizedName: "Visage" },
  { id: 93, name: "slark", localizedName: "Slark" },
  { id: 94, name: "medusa", localizedName: "Medusa" },
  { id: 95, name: "troll_warlord", localizedName: "Troll Warlord" },
  { id: 96, name: "centaur", localizedName: "Centaur Warrunner" },
  { id: 97, name: "magnataur", localizedName: "Magnus" },
  { id: 98, name: "shredder", localizedName: "Timbersaw" },
  { id: 99, name: "bristleback", localizedName: "Bristleback" },
  { id: 100, name: "tusk", localizedName: "Tusk" },
  { id: 101, name: "skywrath_mage", localizedName: "Skywrath Mage" },
  { id: 102, name: "abaddon", localizedName: "Abaddon" },
  { id: 103, name: "elder_titan", localizedName: "Elder Titan" },
  { id: 104, name: "legion_commander", localizedName: "Legion Commander" },
  { id: 105, name: "techies", localizedName: "Techies" },
  { id: 106, name: "ember_spirit", localizedName: "Ember Spirit" },
  { id: 107, name: "earth_spirit", localizedName: "Earth Spirit" },
  { id: 108, name: "abyssal_underlord", localizedName: "Underlord" },
  { id: 109, name: "terrorblade", localizedName: "Terrorblade" },
  { id: 110, name: "phoenix", localizedName: "Phoenix" },
  { id: 111, name: "oracle", localizedName: "Oracle" },
  { id: 112, name: "winter_wyvern", localizedName: "Winter Wyvern" },
  { id: 113, name: "arc_warden", localizedName: "Arc Warden" },
  { id: 114, name: "monkey_king", localizedName: "Monkey King" },
  { id: 119, name: "dark_willow", localizedName: "Dark Willow" },
  { id: 120, name: "pangolier", localizedName: "Pangolier" },
  { id: 121, name: "grimstroke", localizedName: "Grimstroke" },
  { id: 123, name: "hoodwink", localizedName: "Hoodwink" },
  { id: 126, name: "void_spirit", localizedName: "Void Spirit" },
  { id: 128, name: "snapfire", localizedName: "Snapfire" },
  { id: 129, name: "mars", localizedName: "Mars" },
  { id: 131, name: "ringmaster", localizedName: "Ringmaster" },
  { id: 135, name: "dawnbreaker", localizedName: "Dawnbreaker" },
  { id: 136, name: "marci", localizedName: "Marci" },
  { id: 137, name: "primal_beast", localizedName: "Primal Beast" },
  { id: 138, name: "muerta", localizedName: "Muerta" },
  { id: 145, name: "kez", localizedName: "Kez" },
  { id: 155, name: "largo", localizedName: "Largo" },
];

export interface HeroCatalogEntry extends RawHero {
  iconUrl: string;
}

export const DOTA_HEROES: HeroCatalogEntry[] = RAW_HEROES.map((hero) => ({
  ...hero,
  iconUrl: `${HERO_ICON_BASE}/${hero.name}.png`,
}));

const BY_ID = new Map(DOTA_HEROES.map((hero) => [hero.id, hero]));
const BY_NAME = new Map(DOTA_HEROES.map((hero) => [hero.name, hero]));

export const getHeroById = (id: number): HeroCatalogEntry | null => BY_ID.get(id) ?? null;
export const getHeroByInternalName = (name: string): HeroCatalogEntry | null => BY_NAME.get(name) ?? null;
