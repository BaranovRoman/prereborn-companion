// Visual-QA fixtures: realistic, mid-session data for every Companion IPC
// command and every Dota plugin UI command. Dev harness only — never bundled
// into the production app (vite build has a single index.html input).
import heroCatalog from "../../../plugins/dota-domain/src/generated_hero_catalog.json";
import itemCatalog from "../../../plugins/dota-domain/src/generated_item_catalog.json";
import { DEFAULT_OVERLAY_LAYOUT } from "../../../plugins/dota/ui/overlay/defaultLayout";

export type Scenario = "default" | "empty" | "errors";
export const scenario: Scenario = (new URLSearchParams(location.search).get("scenario") as Scenario) ?? "default";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const authors = [
  ["Arteezy", "#FF6F61"], ["kotik_dota", "#8AB4F8"], ["MidOrFeed", "#81C995"], ["sonya_lilith", "#F28B82"],
  ["pudge_enjoyer", "#FDD663"], ["ромаромыч", "#C58AF9"], ["NoTalentNoProblem", "#78D9EC"], ["ward_master", "#FCAD70"],
];
const lines = [
  "gg wp, отличная игра", "почему не купил бкб?", "какой сейчас ммр?", "!song",
  "эта катка точно в плюс", "го пудж следующий", "привет всем из Казани 👋", "крип скилл топ",
  "сколько часов в доте?", "это был лучший блинк в сезоне, без шуток, я пересмотрел три раза",
];
const messages = scenario === "empty" ? [] : Array.from({ length: 34 }, (_, i) => ({
  id: `m${i}`, author: authors[i % authors.length][0], authorId: `u${i % 8}`, authorLogin: authors[i % authors.length][0].toLowerCase(),
  color: authors[i % authors.length][1], text: lines[i % lines.length], badges: [], messageType: "text", receivedAt: iso(40 - i),
}));

const obsConfig = { enabled: scenario !== "empty", host: "127.0.0.1", port: 4455, password: "", auto_switch: true };
const clipHistory = scenario === "empty" ? [] : [
  { id: "c1", url: "https://clips.twitch.tv/BrightCleverBlinkPogChamp-abc123", editUrl: null, title: "Блинк + эхо на троих", durationSeconds: 30, createdAt: iso(12) },
  { id: "c2", url: "https://clips.twitch.tv/SneakyHotPudgeHook-def456", editUrl: null, title: "Хук через всю карту", durationSeconds: 30, createdAt: iso(95) },
  { id: "c3", url: "https://clips.twitch.tv/TinyFastTechies-ghi789", editUrl: null, title: null, durationSeconds: 20, createdAt: iso(1440) },
];

export function companionCommand(cmd: string, args: Record<string, unknown> = {}): unknown {
  switch (cmd) {
    case "get_status": return {
      companion_version: "0.5.12", backend_state: "connected",
      obs_state: scenario === "errors" ? "unavailable" : "connected", obs_connected: scenario !== "errors",
      obs_last_error: scenario === "errors" ? "OBS WebSocket недоступен: connection refused (127.0.0.1:4455)" : null,
      obs_streaming: scenario === "default" ? true : false, obs_config: obsConfig,
    };
    case "get_account_status": return scenario === "empty" ? { connected: false, method: "none", email: null } : { connected: true, method: "session", email: "streamer@prereborn.ru" };
    case "get_twitch_chat": return {
      accountConnected: scenario !== "empty", configured: true, displayName: scenario === "empty" ? null : "PreRebornTV",
      connected: scenario === "default", state: scenario === "errors" ? "reauth_required" : scenario === "empty" ? "unavailable" : "connected", messages,
    };
    case "get_twitch_integration_status": return scenario === "empty" ? { connected: false } : { connected: true, login: "prereborntv", displayName: "PreRebornTV" };
    case "get_steam_integration_status": return scenario === "empty" ? { connected: false } : { connected: true, steamId64: "76561198000000000", profile: { displayName: "PreReborn", avatarUrl: null, profileUrl: null } };
    case "get_donation_alerts_integration_status": return { connected: false, configured: true };
    case "get_silero_status": return { enabled: true, state: scenario === "errors" ? "crashed" : "ready", lastError: scenario === "errors" ? "python runtime exited (code 1)" : null, resourcesReady: true, voice: "xenia" };
    case "get_skip_hotkey_status": return { enabled: true, shortcut: "CommandOrControl+Shift+S", registered: scenario !== "errors", lastError: scenario === "errors" ? "Сочетание уже занято другим приложением" : null };
    case "get_clips_status": return { enabled: true, shortcut: "CommandOrControl+Alt+C", registered: true, lastError: null, durationSeconds: 30, phase: { kind: "idle" }, history: clipHistory };
    case "get_clips_access": return { configured: true, accountConnected: scenario !== "empty", scopeGranted: scenario === "errors" ? false : true, duration: { min: 5, max: 60, default: 30 } };
    case "test_obs_connection": return ["Между матчами", "Игра", "Драфт", "Перерыв", "Камера крупно", "Starting Soon", "BRB"];
    case "check_companion_update": return null;
    case "plugins_view": return pluginsView();
    case "plugins_set_autostart": autostart = Boolean(args.enabled); return null;
    case "plugins_command": return dotaCommand(String(args.name), (args.args ?? {}) as Record<string, unknown>);
    case "plugin:autostart|is_enabled": return true;
    default: return null;
  }
}

const dotaManifest = {
  id: "dota", name: "Dota 2", version: "0.2.7", platform: "windows", arch: "x86_64", minApi: 2, maxApi: 2, ui: "ui/index.html",
  permissions: [], author: "PreReborn", icon: "ui/icon.png", execution: "live",
  description: "Звуки способностей и предметов, история матчей, автоматическое переключение сцен OBS и оверлей для трансляции.",
  uiCommands: ["asset.import", "asset.preview", "audio.receipt", "backend.pending", "backend.reconcile", "backend.request", "catalog.heroes", "catalog.items", "directory.pick", "gsi.find", "gsi.install", "history.context", "history.edit", "history.hero", "history.summary", "history.sync", "image.import", "items.trace", "items.trace.start", "items.trace.stop", "link.open", "obs.save", "obs.settings", "overlay.hotkey", "overlay.hotkey.save", "overlay.image.apply", "overlay.image.get", "overlay.image.remove", "overlay.reference", "overlay.reference.save", "overlay.visibility", "sound.assets", "sound.bindings", "sound.import", "sound.master", "sound.remove", "sound.summary", "status"],
};
let autostart = scenario === "default";
function pluginsView() {
  const release = (id: string, name: string, version: string, description: string) => ({ manifest: { ...dotaManifest, id, name, version, description, icon: undefined }, url: "", sha256: "", signature: "" });
  return {
    apiVersion: 2, error: null, catalogError: scenario === "errors" ? "download_failed" : null, localInstallAllowed: false,
    transfer: { busy: false, id: null, received: 0, total: null, stage: "idle", error: null },
    installed: scenario === "empty" ? [] : [{
      id: "dota", manifest: dotaManifest, error: null, transport: null,
      runtime: { phase: "running", pluginVersion: "0.2.7", lastError: null, state: { prepared: true } },
      installed: { active: "0.2.7", previous: "0.2.6", pending: null, enabled: true, autostart },
    }],
    catalog: scenario === "errors" ? [] : [
      release("dota", "Dota 2", "0.2.7", dotaManifest.description),
      release("hello", "Hello", "0.1.0", "Демонстрационный плагин: проверка изолированного интерфейса и подписи пакетов."),
      release("pubg", "PUBG", "0.1.0", "Статистика матчей PUBG и сцены OBS для королевской битвы. Ранний доступ: набор функций будет расширяться по мере появления официальных API для получения игровых событий."),
    ],
  };
}

const heroes = heroCatalog.heroes;
const items = itemCatalog.items;
const revision = "a".repeat(64);
const bindings = scenario === "empty" ? [] : [
  { eventId: "item_blink", kind: "itemUsed", assetId: "s1" },
  { eventId: "item_black_king_bar", kind: "itemUsed", assetId: "s2" },
  { eventId: heroes.find((h) => h.id === "npc_dota_hero_pudge")?.abilities[0]?.id ?? "pudge_meat_hook", kind: "abilityCast", assetId: "s3" },
];
const assets = scenario === "empty" ? [] : [
  { id: "s1", fileName: "s1.ogg", originalName: "blink-whoosh.ogg", sizeBytes: 21000 },
  { id: "s2", fileName: "s2.ogg", originalName: "bkb_activation_loud_version_final.mp3", sizeBytes: 81000 },
  { id: "s3", fileName: "s3.ogg", originalName: "fresh-meat.wav", sizeBytes: 64000 },
];
const matches = Array.from({ length: scenario === "empty" ? 0 : 12 }, (_, i) => ({
  localId: `l${i}`, matchId: String(8012345670 + i), heroId: [14, 1, 74, 106, 8, 129, 35, 44][i % 8], state: "finalized",
  result: i % 3 === 1 ? "loss" : "win", kills: 4 + (i * 3) % 11, deaths: 2 + (i * 5) % 7, assists: 6 + (i * 7) % 13,
  startedAt: iso(60 * (i + 1)), ratingAfter: 6420 - i * 25, detectedRatingDelta: i % 3 === 1 ? -25 : 25, ratingDeltaCorrection: 0,
  rankedMode: i % 4 === 3 ? "unranked" : "ranked", rankedModeDetected: i % 4 === 3 ? "unranked" : "ranked",
}));
const queueSettings = {
  version: 1,
  visibility: { playerProfile: true, streamProfile: true, featuredMatch: true, webcam: true, favoriteHeroes: true, recentGames: true, twitchChat: true, systemStatus: true },
  favoriteHeroIds: scenario === "empty" ? [] : [14, 74, 106], webcamImageUrl: scenario === "errors" ? "https://prereborn.ru/media/missing-webcam.png" : null,
  channelGoal: { type: "rating", label: "RATING GOAL", startValue: 6200, targetValue: 7000 },
  widgets: {
    titles: { playerProfile: "", streamProfile: "", featuredMatch: "", webcam: "", favoriteHeroes: "", recentGames: "", twitchChat: "", friends: "" },
    recentGamesLimit: 8, chatMessagesLimit: 10, friends: { showDonaters: true, showSubscribers: true, showFollowers: true, socialLinks: [] }, viewerQuizEnabled: true,
  },
};
// Long fractional coordinates are what real drags produce.
const layout = structuredClone(DEFAULT_OVERLAY_LAYOUT) as typeof DEFAULT_OVERLAY_LAYOUT;
layout.scenes.gameplay.widgets.session.xVw = 3.4583333333;
layout.scenes.gameplay.widgets.session.yVh = 4.1666666667;
layout.scenes.gameplay.widgets.recentMatches.scale = 0.85;

const backend = (resource: string, body: unknown) => {
  const read: Record<string, unknown> = {
    "overlay-layout": layout, "queue-settings": queueSettings,
    "hero-stats": { status: "ok", games: 312, wins: 171, losses: 141, winRate: 54.8 },
    "hero-insights": { status: "ok", recentForm: { sample: 20, wins: 12, losses: 8, winRate: 60 }, patch: null, kills: 8.2, deaths: 5.1, assists: 11.4, goldPerMin: 512, xpPerMin: 640, heroDamage: null, towerDamage: null, heroHealing: null, rankPercent: null },
  };
  const value = resource.endsWith("-save") ? body : read[resource];
  return { status: "completed", response: { status: 200, body: value ?? {}, error: null } };
};

export function dotaCommand(name: string, args: Record<string, unknown>): unknown {
  const page = <T,>(all: T[], field: string) => ({ total: all.length, [field]: all.slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + Number(args.limit ?? 32)) });
  switch (name) {
    case "catalog.items": return page(items, "items");
    case "catalog.heroes": return page(heroes, "heroes");
    case "sound.summary": return { schemaVersion: 1, enabled: true, masterVolume: 70, bindings: bindings.length, assets: assets.length, revision };
    case "sound.bindings": return { items: bindings.slice(Number(args.offset), Number(args.offset) + 32), revision };
    case "sound.assets": return { items: assets.slice(Number(args.offset), Number(args.offset) + 32), revision };
    case "status": return {
      prepared: true, active: scenario !== "empty", awaitingSession: false, session: "s1", epoch: 1, lastError: null, processed: 18234, lastSequence: 18234,
      gsi: { received: 18240, accepted: 18234, rejected: 0, dropped: 6, lastError: null }, overlay: { running: true, clients: 1 }, overlayVisible: true,
      overlayHotkey: { enabled: true, shortcut: "CommandOrControl+Alt+F11", registered: true, lastError: null },
      detectedSounds: 41, plannedSounds: 41, droppedSoundIntents: 0, lastSoundOperation: null, streaming: true, streamEnded: false,
      backendError: null, overlayBackendError: null, backendUpdates: 3, obsError: scenario === "errors" ? "scene_switch_unconfirmed" : null,
    };
    case "history.summary": return { hasSession: true, ratingCurrent: 6420, wins: matches.filter((m) => m.result === "win").length, losses: matches.filter((m) => m.result === "loss").length, currentMatch: null, recentMatches: matches };
    case "history.sync": return { pendingCount: 0, retryingCount: 0, failedCount: scenario === "errors" ? 2 : 0, unknownDeliveryCount: 0, lastDeliveredAt: iso(5), lastError: null };
    case "history.hero": return { matches: 14, wins: 9, losses: 5, abandons: 0, avgKills: 9.1, avgDeaths: 4.3, avgAssists: 12.7, recentResults: ["win", "win", "loss", "win", "loss"] };
    case "obs.settings": return { configRevision: "b".repeat(64), bindings: { betweenMatches: "Между матчами", gameplay: "Игра" }, enabled: scenario !== "empty", connected: scenario !== "errors", scenes: ["Между матчами", "Игра", "Драфт", "Перерыв", "Камера крупно"] };
    case "overlay.hotkey": return { enabled: true, shortcut: "CommandOrControl+Alt+F11", registered: true, lastError: null };
    case "overlay.image.get": return { url: null };
    case "overlay.reference": return { opacity: 0.65 };
    case "backend.request": { const request = args.request as { resource: string; body: unknown }; return backend(request.resource, request.body); }
    case "backend.pending": return null;
    case "gsi.find": return { found: true, path: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta", installed: true };
    case "items.trace": return { recording: false, total: 0, dropped: 0, events: [] };
    case "audio.receipt": return { receipt: null };
    default: return null;
  }
}
