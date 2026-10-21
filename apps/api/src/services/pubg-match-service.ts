import { env } from "../config/env.js";

// WK-183 - PUBG plugin match history. The PUBG Developer API key lives only
// here (PUBG_API_KEY); the installed plugin never sees it. Only a compact
// product projection leaves this module - never the raw JSON:API payload.
//
// Upstream contract (api.pubg.com, JSON:API):
// - GET /shards/{platform}/players?filter[playerNames]=<name> - rate limited
//   per key (10 RPM by default), returns the player's recent match ids
//   (newest first) in data[0].relationships.matches.data;
// - GET /shards/{platform}/matches/{id} - not rate limited; per-player stats
//   are `participant` entries in `included[]`. A match is immutable once it
//   is listed, so its projection is cached for good (bounded LRU).
//
// Companion's plugin transport gives one backend request ~1 s, and a cold
// player needs one player call plus up to ten match calls. So a request
// waits a short budget for the refresh and then answers with whatever is
// already cached (`complete: false`); the refresh keeps running and the
// plugin's next poll picks the rest up. Same "never block on upstream"
// stance as getCachedSteamProfile.

export const PUBG_PLATFORMS = ["steam", "kakao", "psn", "xbox"] as const;
export type PubgPlatform = (typeof PUBG_PLATFORMS)[number];

export interface PubgMatchSummary {
    id: string;
    createdAt: string;
    durationSec: number;
    map: string;
    gameMode: string;
    place: number | null;
    kills: number;
    damage: number;
}

export type PubgMatchesResult =
    | {
          status: "ok";
          player: { name: string; platform: PubgPlatform };
          matches: PubgMatchSummary[];
          complete: boolean;
          fetchedAt: string;
      }
    | { status: "not_configured" | "player_not_found" | "rate_limited" | "unavailable" };

const PUBG_BASE_URL = "https://api.pubg.com";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PLAYER_TTL_MS = 60_000;
// Below the default 10 RPM so this process never earns a 429 by itself.
const PLAYER_CALLS_PER_MINUTE = 8;
const MATCH_CACHE_LIMIT = 1_000;
const MATCH_CONCURRENCY = 4;
const RESPONSE_BUDGET_MS = 600;
export const MAX_MATCHES = 10;

// PUBG's internal map ids → names players know. Unknown ids fall back to the
// raw id with the "_Main" suffix stripped rather than being dropped.
const MAP_NAMES: Record<string, string> = {
    Baltic_Main: "Erangel",
    Erangel_Main: "Erangel",
    Desert_Main: "Miramar",
    Savage_Main: "Sanhok",
    DihorOtok_Main: "Vikendi",
    Summerland_Main: "Karakin",
    Chimera_Main: "Paramo",
    Heaven_Main: "Haven",
    Tiger_Main: "Taego",
    Kiki_Main: "Deston",
    Neon_Main: "Rondo",
    Range_Main: "Camp Jackal",
};
export const mapDisplayName = (mapName: string): string =>
    MAP_NAMES[mapName] ?? (mapName.replace(/_Main$/, "") || "—");

type FetchResult =
    | { status: "ok"; data: unknown }
    | { status: "not_found" | "rate_limited" | "unavailable" };

const fetchPubg = async (path: string, apiKey: string): Promise<FetchResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${PUBG_BASE_URL}${path}`, {
            signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
        });
        if (response.status === 404) return { status: "not_found" };
        if (response.status === 429) return { status: "rate_limited" };
        if (!response.ok) return { status: "unavailable" };
        const raw = await response.text();
        if (raw.length > MAX_RESPONSE_BYTES) return { status: "unavailable" };
        try {
            return { status: "ok", data: JSON.parse(raw) };
        } catch {
            return { status: "unavailable" };
        }
    } catch {
        return { status: "unavailable" };
    } finally {
        clearTimeout(timeout);
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const MATCH_ID = /^[0-9a-f-]{36}$/;

interface PlayerEntry {
    accountId: string;
    name: string;
    matchIds: string[];
}

export const parsePlayer = (data: unknown): PlayerEntry | null => {
    if (!isRecord(data) || !Array.isArray(data.data)) return null;
    const player = data.data[0];
    if (!isRecord(player) || typeof player.id !== "string" || !player.id.startsWith("account.")) return null;
    const attributes = isRecord(player.attributes) ? player.attributes : {};
    const relationships = isRecord(player.relationships) ? player.relationships : {};
    const matches = isRecord(relationships.matches) ? relationships.matches : {};
    const matchIds = (Array.isArray(matches.data) ? matches.data : [])
        .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : null))
        .filter((id): id is string => id !== null && MATCH_ID.test(id));
    return {
        accountId: player.id,
        name: typeof attributes.name === "string" ? attributes.name : "",
        matchIds,
    };
};

interface MatchEntry {
    createdAt: string;
    durationSec: number;
    map: string;
    gameMode: string;
    // Only the stats this product shows, per account id.
    participants: Map<string, { place: number | null; kills: number; damage: number }>;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const parseMatch = (data: unknown): MatchEntry | null => {
    if (!isRecord(data) || !isRecord(data.data) || !isRecord(data.data.attributes)) return null;
    const attributes = data.data.attributes;
    if (typeof attributes.createdAt !== "string" || Number.isNaN(Date.parse(attributes.createdAt))) return null;
    const participants: MatchEntry["participants"] = new Map();
    for (const entry of Array.isArray(data.included) ? data.included : []) {
        if (!isRecord(entry) || entry.type !== "participant" || !isRecord(entry.attributes)) continue;
        const stats = entry.attributes.stats;
        if (!isRecord(stats) || typeof stats.playerId !== "string") continue;
        const place = num(stats.winPlace);
        participants.set(stats.playerId, {
            place: place > 0 ? Math.round(place) : null,
            kills: Math.max(0, Math.round(num(stats.kills))),
            damage: Math.max(0, Math.round(num(stats.damageDealt))),
        });
    }
    return {
        createdAt: new Date(attributes.createdAt).toISOString(),
        durationSec: Math.max(0, Math.round(num(attributes.duration))),
        map: mapDisplayName(typeof attributes.mapName === "string" ? attributes.mapName : ""),
        gameMode: typeof attributes.gameMode === "string" ? attributes.gameMode.slice(0, 32) : "",
        participants,
    };
};

// Bounded LRU: Map keeps insertion order, a hit is re-inserted at the end.
const matchCache = new Map<string, MatchEntry>();
const matchInFlight = new Map<string, Promise<MatchEntry | null>>();
const rememberMatch = (key: string, entry: MatchEntry) => {
    matchCache.delete(key);
    matchCache.set(key, entry);
    while (matchCache.size > MATCH_CACHE_LIMIT) {
        const oldest = matchCache.keys().next().value;
        if (oldest === undefined) break;
        matchCache.delete(oldest);
    }
};

const getMatch = (platform: PubgPlatform, id: string, apiKey: string): Promise<MatchEntry | null> => {
    const key = `${platform}:${id}`;
    const cached = matchCache.get(key);
    if (cached) {
        rememberMatch(key, cached);
        return Promise.resolve(cached);
    }
    const existing = matchInFlight.get(key);
    if (existing) return existing;
    const request = fetchPubg(`/shards/${platform}/matches/${id}`, apiKey)
        .then((result) => {
            // Failures are not cached: the next refresh retries the match.
            const entry = result.status === "ok" ? parseMatch(result.data) : null;
            if (entry) rememberMatch(key, entry);
            return entry;
        })
        .finally(() => matchInFlight.delete(key));
    matchInFlight.set(key, request);
    return request;
};

type PlayerState =
    | { status: "ok"; player: PlayerEntry; expiresAt: number }
    | { status: "player_not_found" | "rate_limited" | "unavailable"; expiresAt: number };

const playerCache = new Map<string, PlayerState>();
const refreshes = new Map<string, Promise<void>>();
const playerCalls: number[] = [];

const takePlayerCall = (now: number): boolean => {
    while (playerCalls.length && playerCalls[0] <= now - 60_000) playerCalls.shift();
    if (playerCalls.length >= PLAYER_CALLS_PER_MINUTE) return false;
    playerCalls.push(now);
    return true;
};

const refreshPlayer = (platform: PubgPlatform, name: string, apiKey: string, limit: number): Promise<void> => {
    const key = `${platform}:${name.toLowerCase()}`;
    const existing = refreshes.get(key);
    if (existing) return existing;
    const run = (async () => {
        const now = Date.now();
        const previous = playerCache.get(key);
        if (!previous || previous.expiresAt <= now) {
            if (!takePlayerCall(now)) {
                // Keep serving the last good list; only report the limit when
                // there is nothing to show yet.
                if (!previous || previous.status !== "ok") {
                    playerCache.set(key, { status: "rate_limited", expiresAt: now + 10_000 });
                }
                return;
            }
            const result = await fetchPubg(
                `/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(name)}`,
                apiKey
            );
            const player = result.status === "ok" ? parsePlayer(result.data) : null;
            if (player) {
                playerCache.set(key, { status: "ok", player, expiresAt: Date.now() + PLAYER_TTL_MS });
            } else if (previous?.status === "ok" && result.status !== "not_found") {
                // Transient upstream failure: retry soon, keep the old list.
                playerCache.set(key, { ...previous, expiresAt: Date.now() + 15_000 });
            } else {
                const status = result.status === "not_found" || result.status === "ok"
                    ? "player_not_found"
                    : result.status;
                playerCache.set(key, { status, expiresAt: Date.now() + (status === "player_not_found" ? PLAYER_TTL_MS : 15_000) });
            }
        }
        const state = playerCache.get(key);
        if (state?.status !== "ok") return;
        const ids = state.player.matchIds.slice(0, limit);
        for (let i = 0; i < ids.length; i += MATCH_CONCURRENCY) {
            await Promise.all(ids.slice(i, i + MATCH_CONCURRENCY).map((id) => getMatch(platform, id, apiKey)));
        }
    })().finally(() => refreshes.delete(key));
    refreshes.set(key, run);
    return run;
};

const snapshot = (platform: PubgPlatform, name: string, limit: number): PubgMatchesResult | null => {
    const state = playerCache.get(`${platform}:${name.toLowerCase()}`);
    if (!state) return null;
    if (state.status !== "ok") return { status: state.status };
    const ids = state.player.matchIds.slice(0, limit);
    const matches: PubgMatchSummary[] = [];
    for (const id of ids) {
        const match = matchCache.get(`${platform}:${id}`);
        const stats = match?.participants.get(state.player.accountId);
        if (!match || !stats) continue;
        matches.push({ id, createdAt: match.createdAt, durationSec: match.durationSec, map: match.map, gameMode: match.gameMode, ...stats });
    }
    matches.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
        status: "ok",
        player: { name: state.player.name || name, platform },
        matches,
        complete: ids.every((id) => matchCache.has(`${platform}:${id}`)),
        fetchedAt: new Date().toISOString(),
    };
};

export const getPubgMatches = async (
    platform: PubgPlatform,
    name: string,
    limit: number,
    budgetMs = RESPONSE_BUDGET_MS
): Promise<PubgMatchesResult> => {
    const apiKey = env.pubgApiKey;
    if (!apiKey) return { status: "not_configured" };
    const refresh = refreshPlayer(platform, name, apiKey, limit).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refresh, new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); })]);
    clearTimeout(timer);
    // Nothing cached yet and the budget ran out: tell the client to retry
    // soon, the refresh is still running.
    return snapshot(platform, name, limit) ?? {
        status: "ok",
        player: { name, platform },
        matches: [],
        complete: false,
        fetchedAt: new Date().toISOString(),
    };
};

export const __resetPubgCachesForTests = (): void => {
    matchCache.clear();
    matchInFlight.clear();
    playerCache.clear();
    refreshes.clear();
    playerCalls.length = 0;
};
