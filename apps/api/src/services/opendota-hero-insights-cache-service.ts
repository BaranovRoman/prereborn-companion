import {
    openDotaMatchProvider,
    type DotaHeroMatch,
    type DotaCountBucket,
    type DotaPlayerTotals,
} from "./dota-match-provider.js";

// WK-148 - per-hero обогащение Hero Detail (recent form / патч / KDA-GPM-XPM)
// и второй строки Favorite Heroes в Between Matches. Отдельная сущность от
// opendota-hero-stats-cache-service.ts (WK-133, lifetime games/win по ВСЕМ
// героям одним запросом) - это три РАЗНЫХ point-of-use эндпоинта,
// параметризованных конкретным heroId, поэтому кэшируются на ключ
// (accountId, heroId), а не на весь аккаунт. Тот же 10-минутный
// blocking-контракт - авторизованный вызов из Hero Detail/Companion IPC,
// никогда не публичный оверлей.
const HERO_INSIGHTS_TTL_MS = 10 * 60_000;
const RECENT_MATCHES_LIMIT = 20;

type SimpleStatus = "not_found" | "rate_limited" | "unavailable";

const key = (accountId: number, heroId: number): string => `${accountId}:${heroId}`;

interface CacheEntry<T> {
    expiresAt: number;
    result: { status: "ok"; value: T } | { status: SimpleStatus };
}

const createHeroCache = <T>(
    fetcher: (
        accountId: number,
        heroId: number
    ) => Promise<{ status: "ok"; value: T } | { status: SimpleStatus }>
) => {
    const cache = new Map<string, CacheEntry<T>>();
    const inFlight = new Map<string, Promise<CacheEntry<T>["result"]>>();

    const get = async (accountId: number, heroId: number): Promise<CacheEntry<T>["result"]> => {
        const cacheKey = key(accountId, heroId);
        const cached = cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.result;

        const existing = inFlight.get(cacheKey);
        if (existing) return existing;

        const request = fetcher(accountId, heroId)
            .then((result) => {
                if (result.status === "ok" || result.status === "not_found") {
                    cache.set(cacheKey, { result, expiresAt: Date.now() + HERO_INSIGHTS_TTL_MS });
                }
                return result;
            })
            .finally(() => {
                inFlight.delete(cacheKey);
            });

        inFlight.set(cacheKey, request);
        return request;
    };

    const reset = () => {
        cache.clear();
        inFlight.clear();
    };

    return { get, reset };
};

const recentMatchesCache = createHeroCache<DotaHeroMatch[]>(async (accountId, heroId) => {
    const result = await openDotaMatchProvider.getPlayerMatchesByHero(
        accountId,
        heroId,
        RECENT_MATCHES_LIMIT
    );
    return result.status === "ok" ? { status: "ok", value: result.matches } : result;
});

const patchCountsCache = createHeroCache<Record<string, DotaCountBucket>>(
    async (accountId, heroId) => {
        const result = await openDotaMatchProvider.getPlayerCounts(accountId, heroId);
        return result.status === "ok" ? { status: "ok", value: result.counts.patch } : result;
    }
);

const totalsCache = createHeroCache<DotaPlayerTotals>(async (accountId, heroId) => {
    const result = await openDotaMatchProvider.getPlayerTotals(accountId, heroId);
    return result.status === "ok" ? { status: "ok", value: result.totals } : result;
});

export type CachedHeroRecentMatchesResult =
    | { status: "ok"; matches: DotaHeroMatch[] }
    | { status: SimpleStatus };
export const getCachedHeroRecentMatches = async (
    accountId: number,
    heroId: number
): Promise<CachedHeroRecentMatchesResult> => {
    const result = await recentMatchesCache.get(accountId, heroId);
    return result.status === "ok" ? { status: "ok", matches: result.value } : result;
};

export type CachedHeroPatchCountsResult =
    | { status: "ok"; patch: Record<string, DotaCountBucket> }
    | { status: SimpleStatus };
export const getCachedHeroPatchCounts = async (
    accountId: number,
    heroId: number
): Promise<CachedHeroPatchCountsResult> => {
    const result = await patchCountsCache.get(accountId, heroId);
    return result.status === "ok" ? { status: "ok", patch: result.value } : result;
};

export type CachedHeroTotalsResult =
    | { status: "ok"; totals: DotaPlayerTotals }
    | { status: SimpleStatus };
export const getCachedHeroTotals = async (
    accountId: number,
    heroId: number
): Promise<CachedHeroTotalsResult> => {
    const result = await totalsCache.get(accountId, heroId);
    return result.status === "ok" ? { status: "ok", totals: result.value } : result;
};

export const __resetOpenDotaHeroInsightsCacheForTests = (): void => {
    recentMatchesCache.reset();
    patchCountsCache.reset();
    totalsCache.reset();
};
