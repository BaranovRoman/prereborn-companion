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
//
// WK-121 - this is now also the ONE canonical TS-side hero catalog for
// Companion (§1.4 of docs/research/wk-121-companion-product-consolidation.md):
// extended in-place with attribute (ported from heroAttributes.ts, which
// re-exports from here now), RU alias search (ported verbatim from web's
// aliases.ts) and hero video/portrait URLs (same production media host web
// already serves hero videos from - apps/web's own `buildMediaUrl`
// resolves to `https://prereborn.ru/media/...` via nginx's `/media/`
// alias; Companion just uses that absolute URL directly, no new asset
// pipeline). Both the new Heroes section (HeroesPage/HeroDetailPage) and
// this existing Sounds → Heroes grid read from this single file - no third
// catalog was created.
export type DotaHeroAttribute = "strength" | "agility" | "intelligence" | "universal";

interface RawHero {
  id: number;
  name: string;
  localizedName: string;
  attribute: DotaHeroAttribute;
}

const HERO_ICON_BASE = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes";
const HERO_MEDIA_BASE = "https://prereborn.ru/media/dota";

const ATTRIBUTE_IDS: Record<DotaHeroAttribute, ReadonlySet<number>> = {
  strength: new Set([73, 2, 99, 96, 81, 51, 135, 69, 49, 107, 7, 103, 59, 23, 155, 104, 54, 77, 129, 60, 84, 57, 110, 137, 14, 28, 71, 18, 29, 98, 19, 83, 100, 108, 85, 42]),
  agility: new Set([1, 4, 62, 61, 56, 6, 106, 41, 72, 123, 8, 145, 80, 48, 94, 82, 9, 114, 10, 89, 44, 12, 15, 32, 11, 93, 35, 67, 46, 109, 95, 70, 20, 47, 63]),
  intelligence: new Set([68, 66, 5, 55, 119, 87, 58, 121, 74, 64, 90, 52, 31, 25, 26, 138, 36, 111, 76, 13, 45, 39, 131, 86, 79, 27, 75, 101, 17, 34, 37, 112, 30, 22]),
  universal: new Set([102, 113, 3, 65, 38, 78, 50, 43, 33, 91, 97, 136, 53, 88, 120, 16, 128, 105, 40, 92, 126, 21]),
};

const attributeOf = (heroId: number): DotaHeroAttribute => {
  for (const [attribute, ids] of Object.entries(ATTRIBUTE_IDS) as Array<[DotaHeroAttribute, ReadonlySet<number>]>) {
    if (ids.has(heroId)) return attribute;
  }
  return "universal";
};

// Search-only community aliases: common RU/CIS nicknames, abbreviations and
// legacy DotA names, ported verbatim from
// apps/web/src/entities/dota-hero/model/aliases.ts. Official hero names
// remain unchanged in the interface - these only widen search matching.
const DOTA_HERO_ALIASES: Record<string, string[]> = {
  antimage: ["ам", "am", "антимаг", "магина", "magina"],
  axe: ["акс", "могул", "mogul"],
  bane: ["бейн", "атропос", "atropos"],
  bloodseeker: ["бс", "bs", "сикер", "блудсикер", "стригвир", "strygwyr"],
  crystal_maiden: ["цм", "cm", "цмка", "кристалка", "рылай", "rylai"],
  drow_ranger: ["дровка", "дрова", "тракса", "traxex", "dr"],
  earthshaker: ["еш", "es", "шейкер", "раигор", "raigor"],
  juggernaut: ["джагер", "джаггер", "юра", "юрнеро", "yurnero", "jug"],
  mirana: ["потма", "potm", "принцесса луны"],
  morphling: ["морф", "морфлинг"],
  nevermore: ["сф", "sf", "шадоу финд", "невермор"],
  phantom_lancer: ["пл", "pl", "лансер", "азраил", "azwraith"],
  puck: ["пак", "фея", "дракончик"],
  pudge: ["пудж", "бутчер", "butcher", "мясник", "пиджак"],
  razor: ["разор", "молния"],
  sand_king: ["ск", "sk", "скорпион", "песочник", "криксалис", "crixalis"],
  storm_spirit: ["шторм", "сс", "ss", "райдзин", "raijin"],
  sven: ["свен", "рога", "рогатый", "rogue knight"],
  tiny: ["тини", "камень"],
  vengefulspirit: ["венга", "вендж", "vs", "шадель", "shendelzare"],
  windrunner: ["вр", "wr", "винда", "виндраннер", "аллериа", "alleria"],
  zuus: ["зевс", "зеус"],
  kunkka: ["кунка", "адмирал", "корабль"],
  lina: ["лина", "слеер", "slayer"],
  lion: ["лион", "демонвич", "demon witch"],
  shadow_shaman: ["шаман", "раста", "rhasta"],
  slardar: ["слардар", "рыба", "селедка", "селёдка"],
  tidehunter: ["тайд", "арбуз", "левиафан", "leviathan"],
  witch_doctor: ["вд", "wd", "доктор", "захар"],
  lich: ["лич", "келтуз", "kelthuzad"],
  riki: ["рики", "рикки", "инвиз", "рикимару", "rikimaru"],
  enigma: ["энигма", "черная дыра", "чёрная дыра"],
  tinker: ["тинкер", "боуш", "boush"],
  sniper: ["снайпер", "дед", "кардел", "kardel"],
  necrolyte: ["некр", "некролит", "некрофос", "ротунд", "rotundjere"],
  warlock: ["варлок", "голем", "демнок", "demnok"],
  beastmaster: ["бм", "bm", "бист", "рексар", "rexxar"],
  queenofpain: ["квопа", "qop", "акаша", "akasha", "квина"],
  venomancer: ["веник", "веном", "лешал", "lesale"],
  faceless_void: ["войд", "фв", "fv", "дарктеррор", "darkterror"],
  skeleton_king: ["вк", "wk", "леорик", "leoric", "скелетон кинг", "врайс кинг"],
  death_prophet: ["дп", "dp", "профетка", "кроба", "krobelus"],
  phantom_assassin: ["па", "pa", "фантомка", "мортра", "mortra", "mortred"],
  pugna: ["пугна", "обливион", "oblivion"],
  templar_assassin: ["та", "ta", "темпларка", "ланая", "lanaya"],
  viper: ["вайпер", "гадюка"],
  luna: ["луна", "мунфанг", "moonfang"],
  dragon_knight: ["дк", "dk", "драгон кнайт", "давион", "davion"],
  dazzle: ["дазл", "даззл", "жрец", "shadow priest"],
  rattletrap: ["клок", "клокверк", "clock", "clockwerk"],
  leshrac: ["лешрак", "леш", "tormented soul"],
  furion: ["фура", "фурион", "нп", "np", "профет", "nature prophet"],
  life_stealer: ["гуль", "найкс", "naix", "лифстилер", "ls"],
  dark_seer: ["дс", "ds", "дарк сир", "ишкафель", "ishkafel"],
  clinkz: ["клинкс", "боник", "bone", "костяной"],
  omniknight: ["омник", "омни", "пурист", "purist"],
  enchantress: ["энча", "коза", "дриада", "аиушта", "aiushtha"],
  huskar: ["хускар", "хуск"],
  night_stalker: ["баланар", "balanar", "нс", "ns", "найт сталкер"],
  broodmother: ["бруда", "паучиха", "паук"],
  bounty_hunter: ["бх", "bh", "баунти", "гондар", "gondar"],
  weaver: ["вивер", "жук", "анубсеран", "anubseran"],
  jakiro: ["джакиро", "джакир", "тхд", "thd", "двухголовый"],
  batrider: ["бат", "бэтрайдер", "летучка"],
  chen: ["чен", "зоопарк"],
  spectre: ["спектра", "меркуриал", "mercurial"],
  doom_bringer: ["дум", "люцифер", "lucifer", "думбрингер"],
  ancient_apparition: ["аа", "aa", "аппарат", "калдр", "kaldr"],
  ursa: ["урса", "медведь", "ульфсаар", "ulfsaar"],
  spirit_breaker: ["бара", "баратрум", "barathrum", "сб", "sb", "корова"],
  gyrocopter: ["гиро", "вертолет", "вертолёт", "коптер"],
  alchemist: ["алхимик", "алхим"],
  invoker: ["инвокер", "вокер", "карл", "kael", "каэль"],
  silencer: ["сало", "сайленсер", "нортром", "nortrom"],
  obsidian_destroyer: ["од", "od", "оутворлд", "дестроер", "харбрингер", "обсидиан"],
  lycan: ["ликан", "волк", "бейнхаллоу", "banehallow"],
  brewmaster: ["брю", "панда", "пивовар", "мангикс", "mangix"],
  shadow_demon: ["шд", "sd", "демон", "эрэдар", "eredar"],
  lone_druid: ["лд", "ld", "друид", "медведь", "силабир", "syllabear"],
  chaos_knight: ["цк", "ck", "хаос", "несаж", "nessaj"],
  meepo: ["мипо", "геомансер", "гео"],
  treant: ["трент", "дерево", "рутфеллен", "rooftrellen"],
  ogre_magi: ["огр", "огр маг", "агаг", "aggron"],
  undying: ["андаинг", "зомби", "дирдж", "dirge"],
  rubick: ["рубик", "рубен", "гранд магус"],
  disruptor: ["дизраптор", "диз", "тралл", "thrall"],
  nyx_assassin: ["никс", "жук", "анубарак", "anubarak", "неруб"],
  naga_siren: ["нага", "сирена", "слизис", "slithice"],
  keeper_of_the_light: ["котл", "kotl", "дед", "эзалор", "ezalor"],
  wisp: ["ио", "io", "висп", "шар"],
  visage: ["визаж", "гаргулья", "некролик", "necrolic"],
  slark: ["сларк", "рыба", "мурлок"],
  medusa: ["медуза", "горгона", "gorgon"],
  troll_warlord: ["тролль", "троляка", "джахракал", "jah'rakal"],
  centaur: ["кентавр", "кент", "варраннер", "warrunner", "бредварден"],
  magnataur: ["магнус", "магнатаур", "магн"],
  shredder: ["тимбер", "тимберсоу", "шреддер", "пила"],
  bristleback: ["бристл", "бб", "bb", "еж", "ёж", "ригварл", "rigwarl"],
  tusk: ["таск", "туск", "морж", "имир", "ymir"],
  skywrath_mage: ["скай", "петух", "скаймаг", "драконус", "dragonus"],
  abaddon: ["абаддон", "абба", "лорд авернус", "avernus"],
  elder_titan: ["титан", "ет", "et", "таурен", "tc"],
  legion_commander: ["легионка", "лк", "lc", "тресдин", "tresdin"],
  ember_spirit: ["эмбер", "огненный спирит", "син", "xin"],
  earth_spirit: ["земеля", "земля", "каолин", "kaolin"],
  abyssal_underlord: ["андерлорд", "питлорд", "пит", "азгалор", "azgalor"],
  terrorblade: ["тб", "tb", "террор", "soul keeper"],
  phoenix: ["феникс", "птица", "цыпа"],
  oracle: ["оракл", "оракул", "нераф", "nerif"],
  winter_wyvern: ["виверна", "виверн", "вв", "ww", "аурот", "auroth"],
  arc_warden: ["арк", "арчик", "зет", "zet", "aw"],
  monkey_king: ["мк", "mk", "манки", "обезьяна", "сунь укун", "wukong"],
  dark_willow: ["виллоу", "фея", "миреска", "mireska", "dw"],
  pangolier: ["панго", "броненосец", "донте", "donte"],
  grimstroke: ["грим", "гримстроук", "художник"],
  mars: ["марс", "бог войны"],
  void_spirit: ["войд спирит", "вс", "vs", "фиолетовый спирит", "иней", "inai"],
  snapfire: ["бабка", "снапка", "снапфаер", "бабушка"],
  hoodwink: ["белка", "худвинк", "белочка"],
  dawnbreaker: ["дб", "db", "донбрейкер", "валора", "valora"],
  marci: ["марси", "марча"],
  primal_beast: ["пб", "pb", "праймал", "зверь", "динозавр"],
  muerta: ["муэрта", "мерта", "мексиканка"],
  ringmaster: ["рингмастер", "циркач", "кукловод"],
  kez: ["кез", "попугай", "птица"],
  largo: ["ларго", "лягушка", "жаба", "бард", "frog", "toad"],
  techies: ["течка", "минер", "минёр", "течис", "гоблины"],
};

const RAW_HEROES: RawHero[] = [
  { id: 1, name: "antimage", localizedName: "Anti-Mage", attribute: attributeOf(1) },
  { id: 2, name: "axe", localizedName: "Axe", attribute: attributeOf(2) },
  { id: 3, name: "bane", localizedName: "Bane", attribute: attributeOf(3) },
  { id: 4, name: "bloodseeker", localizedName: "Bloodseeker", attribute: attributeOf(4) },
  { id: 5, name: "crystal_maiden", localizedName: "Crystal Maiden", attribute: attributeOf(5) },
  { id: 6, name: "drow_ranger", localizedName: "Drow Ranger", attribute: attributeOf(6) },
  { id: 7, name: "earthshaker", localizedName: "Earthshaker", attribute: attributeOf(7) },
  { id: 8, name: "juggernaut", localizedName: "Juggernaut", attribute: attributeOf(8) },
  { id: 9, name: "mirana", localizedName: "Mirana", attribute: attributeOf(9) },
  { id: 10, name: "morphling", localizedName: "Morphling", attribute: attributeOf(10) },
  { id: 11, name: "nevermore", localizedName: "Shadow Fiend", attribute: attributeOf(11) },
  { id: 12, name: "phantom_lancer", localizedName: "Phantom Lancer", attribute: attributeOf(12) },
  { id: 13, name: "puck", localizedName: "Puck", attribute: attributeOf(13) },
  { id: 14, name: "pudge", localizedName: "Pudge", attribute: attributeOf(14) },
  { id: 15, name: "razor", localizedName: "Razor", attribute: attributeOf(15) },
  { id: 16, name: "sand_king", localizedName: "Sand King", attribute: attributeOf(16) },
  { id: 17, name: "storm_spirit", localizedName: "Storm Spirit", attribute: attributeOf(17) },
  { id: 18, name: "sven", localizedName: "Sven", attribute: attributeOf(18) },
  { id: 19, name: "tiny", localizedName: "Tiny", attribute: attributeOf(19) },
  { id: 20, name: "vengefulspirit", localizedName: "Vengeful Spirit", attribute: attributeOf(20) },
  { id: 21, name: "windrunner", localizedName: "Windranger", attribute: attributeOf(21) },
  { id: 22, name: "zuus", localizedName: "Zeus", attribute: attributeOf(22) },
  { id: 23, name: "kunkka", localizedName: "Kunkka", attribute: attributeOf(23) },
  { id: 25, name: "lina", localizedName: "Lina", attribute: attributeOf(25) },
  { id: 26, name: "lion", localizedName: "Lion", attribute: attributeOf(26) },
  { id: 27, name: "shadow_shaman", localizedName: "Shadow Shaman", attribute: attributeOf(27) },
  { id: 28, name: "slardar", localizedName: "Slardar", attribute: attributeOf(28) },
  { id: 29, name: "tidehunter", localizedName: "Tidehunter", attribute: attributeOf(29) },
  { id: 30, name: "witch_doctor", localizedName: "Witch Doctor", attribute: attributeOf(30) },
  { id: 31, name: "lich", localizedName: "Lich", attribute: attributeOf(31) },
  { id: 32, name: "riki", localizedName: "Riki", attribute: attributeOf(32) },
  { id: 33, name: "enigma", localizedName: "Enigma", attribute: attributeOf(33) },
  { id: 34, name: "tinker", localizedName: "Tinker", attribute: attributeOf(34) },
  { id: 35, name: "sniper", localizedName: "Sniper", attribute: attributeOf(35) },
  { id: 36, name: "necrolyte", localizedName: "Necrophos", attribute: attributeOf(36) },
  { id: 37, name: "warlock", localizedName: "Warlock", attribute: attributeOf(37) },
  { id: 38, name: "beastmaster", localizedName: "Beastmaster", attribute: attributeOf(38) },
  { id: 39, name: "queenofpain", localizedName: "Queen of Pain", attribute: attributeOf(39) },
  { id: 40, name: "venomancer", localizedName: "Venomancer", attribute: attributeOf(40) },
  { id: 41, name: "faceless_void", localizedName: "Faceless Void", attribute: attributeOf(41) },
  { id: 42, name: "skeleton_king", localizedName: "Wraith King", attribute: attributeOf(42) },
  { id: 43, name: "death_prophet", localizedName: "Death Prophet", attribute: attributeOf(43) },
  { id: 44, name: "phantom_assassin", localizedName: "Phantom Assassin", attribute: attributeOf(44) },
  { id: 45, name: "pugna", localizedName: "Pugna", attribute: attributeOf(45) },
  { id: 46, name: "templar_assassin", localizedName: "Templar Assassin", attribute: attributeOf(46) },
  { id: 47, name: "viper", localizedName: "Viper", attribute: attributeOf(47) },
  { id: 48, name: "luna", localizedName: "Luna", attribute: attributeOf(48) },
  { id: 49, name: "dragon_knight", localizedName: "Dragon Knight", attribute: attributeOf(49) },
  { id: 50, name: "dazzle", localizedName: "Dazzle", attribute: attributeOf(50) },
  { id: 51, name: "rattletrap", localizedName: "Clockwerk", attribute: attributeOf(51) },
  { id: 52, name: "leshrac", localizedName: "Leshrac", attribute: attributeOf(52) },
  { id: 53, name: "furion", localizedName: "Nature's Prophet", attribute: attributeOf(53) },
  { id: 54, name: "life_stealer", localizedName: "Lifestealer", attribute: attributeOf(54) },
  { id: 55, name: "dark_seer", localizedName: "Dark Seer", attribute: attributeOf(55) },
  { id: 56, name: "clinkz", localizedName: "Clinkz", attribute: attributeOf(56) },
  { id: 57, name: "omniknight", localizedName: "Omniknight", attribute: attributeOf(57) },
  { id: 58, name: "enchantress", localizedName: "Enchantress", attribute: attributeOf(58) },
  { id: 59, name: "huskar", localizedName: "Huskar", attribute: attributeOf(59) },
  { id: 60, name: "night_stalker", localizedName: "Night Stalker", attribute: attributeOf(60) },
  { id: 61, name: "broodmother", localizedName: "Broodmother", attribute: attributeOf(61) },
  { id: 62, name: "bounty_hunter", localizedName: "Bounty Hunter", attribute: attributeOf(62) },
  { id: 63, name: "weaver", localizedName: "Weaver", attribute: attributeOf(63) },
  { id: 64, name: "jakiro", localizedName: "Jakiro", attribute: attributeOf(64) },
  { id: 65, name: "batrider", localizedName: "Batrider", attribute: attributeOf(65) },
  { id: 66, name: "chen", localizedName: "Chen", attribute: attributeOf(66) },
  { id: 67, name: "spectre", localizedName: "Spectre", attribute: attributeOf(67) },
  { id: 68, name: "ancient_apparition", localizedName: "Ancient Apparition", attribute: attributeOf(68) },
  { id: 69, name: "doom_bringer", localizedName: "Doom", attribute: attributeOf(69) },
  { id: 70, name: "ursa", localizedName: "Ursa", attribute: attributeOf(70) },
  { id: 71, name: "spirit_breaker", localizedName: "Spirit Breaker", attribute: attributeOf(71) },
  { id: 72, name: "gyrocopter", localizedName: "Gyrocopter", attribute: attributeOf(72) },
  { id: 73, name: "alchemist", localizedName: "Alchemist", attribute: attributeOf(73) },
  { id: 74, name: "invoker", localizedName: "Invoker", attribute: attributeOf(74) },
  { id: 75, name: "silencer", localizedName: "Silencer", attribute: attributeOf(75) },
  { id: 76, name: "obsidian_destroyer", localizedName: "Outworld Destroyer", attribute: attributeOf(76) },
  { id: 77, name: "lycan", localizedName: "Lycan", attribute: attributeOf(77) },
  { id: 78, name: "brewmaster", localizedName: "Brewmaster", attribute: attributeOf(78) },
  { id: 79, name: "shadow_demon", localizedName: "Shadow Demon", attribute: attributeOf(79) },
  { id: 80, name: "lone_druid", localizedName: "Lone Druid", attribute: attributeOf(80) },
  { id: 81, name: "chaos_knight", localizedName: "Chaos Knight", attribute: attributeOf(81) },
  { id: 82, name: "meepo", localizedName: "Meepo", attribute: attributeOf(82) },
  { id: 83, name: "treant", localizedName: "Treant Protector", attribute: attributeOf(83) },
  { id: 84, name: "ogre_magi", localizedName: "Ogre Magi", attribute: attributeOf(84) },
  { id: 85, name: "undying", localizedName: "Undying", attribute: attributeOf(85) },
  { id: 86, name: "rubick", localizedName: "Rubick", attribute: attributeOf(86) },
  { id: 87, name: "disruptor", localizedName: "Disruptor", attribute: attributeOf(87) },
  { id: 88, name: "nyx_assassin", localizedName: "Nyx Assassin", attribute: attributeOf(88) },
  { id: 89, name: "naga_siren", localizedName: "Naga Siren", attribute: attributeOf(89) },
  { id: 90, name: "keeper_of_the_light", localizedName: "Keeper of the Light", attribute: attributeOf(90) },
  { id: 91, name: "wisp", localizedName: "Io", attribute: attributeOf(91) },
  { id: 92, name: "visage", localizedName: "Visage", attribute: attributeOf(92) },
  { id: 93, name: "slark", localizedName: "Slark", attribute: attributeOf(93) },
  { id: 94, name: "medusa", localizedName: "Medusa", attribute: attributeOf(94) },
  { id: 95, name: "troll_warlord", localizedName: "Troll Warlord", attribute: attributeOf(95) },
  { id: 96, name: "centaur", localizedName: "Centaur Warrunner", attribute: attributeOf(96) },
  { id: 97, name: "magnataur", localizedName: "Magnus", attribute: attributeOf(97) },
  { id: 98, name: "shredder", localizedName: "Timbersaw", attribute: attributeOf(98) },
  { id: 99, name: "bristleback", localizedName: "Bristleback", attribute: attributeOf(99) },
  { id: 100, name: "tusk", localizedName: "Tusk", attribute: attributeOf(100) },
  { id: 101, name: "skywrath_mage", localizedName: "Skywrath Mage", attribute: attributeOf(101) },
  { id: 102, name: "abaddon", localizedName: "Abaddon", attribute: attributeOf(102) },
  { id: 103, name: "elder_titan", localizedName: "Elder Titan", attribute: attributeOf(103) },
  { id: 104, name: "legion_commander", localizedName: "Legion Commander", attribute: attributeOf(104) },
  { id: 105, name: "techies", localizedName: "Techies", attribute: attributeOf(105) },
  { id: 106, name: "ember_spirit", localizedName: "Ember Spirit", attribute: attributeOf(106) },
  { id: 107, name: "earth_spirit", localizedName: "Earth Spirit", attribute: attributeOf(107) },
  { id: 108, name: "abyssal_underlord", localizedName: "Underlord", attribute: attributeOf(108) },
  { id: 109, name: "terrorblade", localizedName: "Terrorblade", attribute: attributeOf(109) },
  { id: 110, name: "phoenix", localizedName: "Phoenix", attribute: attributeOf(110) },
  { id: 111, name: "oracle", localizedName: "Oracle", attribute: attributeOf(111) },
  { id: 112, name: "winter_wyvern", localizedName: "Winter Wyvern", attribute: attributeOf(112) },
  { id: 113, name: "arc_warden", localizedName: "Arc Warden", attribute: attributeOf(113) },
  { id: 114, name: "monkey_king", localizedName: "Monkey King", attribute: attributeOf(114) },
  { id: 119, name: "dark_willow", localizedName: "Dark Willow", attribute: attributeOf(119) },
  { id: 120, name: "pangolier", localizedName: "Pangolier", attribute: attributeOf(120) },
  { id: 121, name: "grimstroke", localizedName: "Grimstroke", attribute: attributeOf(121) },
  { id: 123, name: "hoodwink", localizedName: "Hoodwink", attribute: attributeOf(123) },
  { id: 126, name: "void_spirit", localizedName: "Void Spirit", attribute: attributeOf(126) },
  { id: 128, name: "snapfire", localizedName: "Snapfire", attribute: attributeOf(128) },
  { id: 129, name: "mars", localizedName: "Mars", attribute: attributeOf(129) },
  { id: 131, name: "ringmaster", localizedName: "Ringmaster", attribute: attributeOf(131) },
  { id: 135, name: "dawnbreaker", localizedName: "Dawnbreaker", attribute: attributeOf(135) },
  { id: 136, name: "marci", localizedName: "Marci", attribute: attributeOf(136) },
  { id: 137, name: "primal_beast", localizedName: "Primal Beast", attribute: attributeOf(137) },
  { id: 138, name: "muerta", localizedName: "Muerta", attribute: attributeOf(138) },
  { id: 145, name: "kez", localizedName: "Kez", attribute: attributeOf(145) },
  { id: 155, name: "largo", localizedName: "Largo", attribute: attributeOf(155) },
];

export interface HeroCatalogEntry extends RawHero {
  iconUrl: string;
  /** Wide splash portrait - same file used for hero detail visuals and the grid tiles. */
  portraitUrl: string;
  /** Idle-loop hero video, production media host - always paired with `portraitUrl` as a `poster`
   *  fallback by any consumer (HeroDetailPage), never assumed to load successfully. */
  videoUrl: string;
}

export const DOTA_HEROES: HeroCatalogEntry[] = RAW_HEROES.map((hero) => ({
  ...hero,
  iconUrl: `${HERO_ICON_BASE}/${hero.name}.png`,
  portraitUrl: `${HERO_ICON_BASE}/${hero.name}.png`,
  videoUrl: `${HERO_MEDIA_BASE}/heroes/${hero.name}.webm`,
}));

const BY_ID = new Map(DOTA_HEROES.map((hero) => [hero.id, hero]));
const BY_NAME = new Map(DOTA_HEROES.map((hero) => [hero.name, hero]));

export const getHeroById = (id: number): HeroCatalogEntry | null => BY_ID.get(id) ?? null;
export const getHeroByInternalName = (name: string): HeroCatalogEntry | null => BY_NAME.get(name) ?? null;
export const getHeroAttribute = (heroId: number): DotaHeroAttribute => getHeroById(heroId)?.attribute ?? "universal";

/** Case-insensitive substring match against localized name, internal name, and RU/CIS aliases -
 *  the one hero search implementation for Companion (Sounds → Heroes and the new Heroes section
 *  both call this; no second implementation). */
export function searchHeroes(query: string): HeroCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return DOTA_HEROES;
  return DOTA_HEROES.filter((hero) => {
    if (hero.localizedName.toLowerCase().includes(q)) return true;
    if (hero.name.toLowerCase().includes(q)) return true;
    const aliases = DOTA_HERO_ALIASES[hero.name];
    return aliases ? aliases.some((alias) => alias.includes(q)) : false;
  });
}
