import type { EmoteRef } from "./overlay-model";

// WK-179 - third-party emote catalogs for the chat overlay. Every provider is
// optional: a failed/blocked request just leaves those codes as plain text.
// Results are cached in localStorage for CACHE_TTL_MS so reopening the
// overlay or restarting Companion doesn't refetch the catalogs; the images
// themselves are cached by the WebView's normal HTTP cache.

const CACHE_KEY = "companion-chat-overlay-emotes-v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

type Fetcher = (url: string) => Promise<unknown>;
const fetchJson: Fetcher = async (url) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally { window.clearTimeout(timer); }
};

const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export const parseBttv = (list: unknown): EmoteRef[] => array(list).flatMap((emote) => {
  const id = text(emote.id), code = text(emote.code);
  return id && code ? [{ code, url: `https://cdn.betterttv.net/emote/${encodeURIComponent(id)}/1x`, source: "bttv" as const }] : [];
});
export const parseSevenTv = (list: unknown): EmoteRef[] => array(list).flatMap((emote) => {
  const id = text(emote.id), code = text(emote.name);
  return id && code ? [{ code, url: `https://cdn.7tv.app/emote/${encodeURIComponent(id)}/1x.webp`, source: "7tv" as const }] : [];
});
export const parseFfzSets = (sets: unknown, onlyIds?: unknown[]): EmoteRef[] => {
  const allowed = onlyIds ? new Set(onlyIds.map(String)) : null;
  return Object.entries(record(sets)).flatMap(([setId, set]) => {
    if (allowed && !allowed.has(setId)) return [];
    return array(record(set).emoticons).flatMap((emote) => {
      const code = text(emote.name), url = text(record(emote.urls)["1"]);
      return code && url ? [{ code, url: url.startsWith("//") ? `https:${url}` : url, source: "ffz" as const }] : [];
    });
  });
};

// Resolves the channel's numeric Twitch id through FFZ's room lookup (keyed
// by login, which Companion already knows); BTTV and 7TV channel lookups
// need the id. `fallbackTwitchId` covers channels without an FFZ room.
export async function loadEmoteCatalog(
  login: string | null, fallbackTwitchId: string | null, get: Fetcher = fetchJson,
): Promise<EmoteRef[]> {
  const safe = <T,>(work: () => Promise<T[]>) => work().catch(() => [] as T[]);
  let twitchId = fallbackTwitchId;
  const ffzChannel = login ? safe(async () => {
    const room = record(await get(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login.toLowerCase())}`));
    const id = record(room.room).twitch_id;
    if (typeof id === "number" || typeof id === "string") twitchId = String(id);
    return parseFfzSets(room.sets);
  }) : Promise.resolve([]);
  const ffzGlobal = safe(async () => {
    const global = record(await get("https://api.frankerfacez.com/v1/set/global"));
    return parseFfzSets(global.sets, Array.isArray(global.default_sets) ? global.default_sets : undefined);
  });
  const bttvGlobal = safe(async () => parseBttv(await get("https://api.betterttv.net/3/cached/emotes/global")));
  const sevenGlobal = safe(async () => parseSevenTv(record(await get("https://7tv.io/v3/emote-sets/global")).emotes));
  const ffz = [...await ffzGlobal, ...await ffzChannel];
  const byId = twitchId ? encodeURIComponent(twitchId) : null;
  const [bttvChannel, sevenChannel] = await Promise.all([
    byId ? safe(async () => {
      const user = record(await get(`https://api.betterttv.net/3/cached/users/twitch/${byId}`));
      return [...parseBttv(user.channelEmotes), ...parseBttv(user.sharedEmotes)];
    }) : Promise.resolve([]),
    byId ? safe(async () => parseSevenTv(record(record(await get(`https://7tv.io/v3/users/twitch/${byId}`)).emote_set).emotes)) : Promise.resolve([]),
  ]);
  // Later entries win in buildEmoteMap: FFZ < BTTV < 7TV, globals before
  // channel emotes - the usual precedence of chat clients with all three.
  return [...ffz, ...await bttvGlobal, ...bttvChannel, ...await sevenGlobal, ...sevenChannel];
}

export const buildEmoteMap = (emotes: EmoteRef[]) => new Map(emotes.map((emote) => [emote.code, emote]));

interface CacheEntry { key: string; savedAt: number; emotes: EmoteRef[] }
export const readCachedCatalog = (key: string, now = Date.now()): EmoteRef[] | null => {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as CacheEntry | null;
    return entry && entry.key === key && now - entry.savedAt < CACHE_TTL_MS && Array.isArray(entry.emotes) ? entry.emotes : null;
  } catch { return null; }
};
export const writeCachedCatalog = (key: string, emotes: EmoteRef[], now = Date.now()) => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ key, savedAt: now, emotes } satisfies CacheEntry)); }
  catch { /* Catalog stays in memory only. */ }
};
