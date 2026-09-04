import {
    openDotaMatchProvider,
    type DotaPlayerCounts,
    type DotaPlayerTotals,
    type DotaHeroRanking,
} from "./dota-match-provider.js";
import { getCachedPatchConstants, resolvePatchName } from "./opendota-patch-constants-service.js";

// WK-148 - account-wide (без hero_id) данные: используются для резолва
// "текущего патча" игрока, оси Гибкость радара (lane_role) и остальных осей
// радара (totals), плюс рейтинг героев (Hero Detail, best-effort). Тот же
// TTL/blocking-контракт, что у opendota-hero-stats-cache-service.ts - это
// авторизованные point-of-use вызовы (Hero Detail/Companion IPC), а не
// публичный оверлей.
const ACCOUNT_INSIGHTS_TTL_MS = 10 * 60_000;

type SimpleStatus = "not_found" | "rate_limited" | "unavailable";

interface CacheEntry<T> {
    expiresAt: number;
    result: { status: "ok"; value: T } | { status: SimpleStatus };
}

// Общая фабрика: три независимых кэша (counts/totals/rankings) - один и тот
// же map+inFlight+TTL контракт, что и у opendota-hero-stats-cache-service.ts,
// просто применённый трижды к разным account-wide эндпоинтам.
const createAccountCache = <T>(
    fetcher: (
        accountId: number
    ) => Promise<{ status: "ok"; value: T } | { status: SimpleStatus }>
) => {
    const cache = new Map<number, CacheEntry<T>>();
    const inFlight = new Map<number, Promise<CacheEntry<T>["result"]>>();

    const get = async (accountId: number): Promise<CacheEntry<T>["result"]> => {
        const cached = cache.get(accountId);
        if (cached && cached.expiresAt > Date.now()) return cached.result;

        const existing = inFlight.get(accountId);
        if (existing) return existing;

        const request = fetcher(accountId)
            .then((result) => {
                if (result.status === "ok" || result.status === "not_found") {
                    cache.set(accountId, { result, expiresAt: Date.now() + ACCOUNT_INSIGHTS_TTL_MS });
                }
                return result;
            })
            .finally(() => {
                inFlight.delete(accountId);
            });

        inFlight.set(accountId, request);
        return request;
    };

    const reset = () => {
        cache.clear();
        inFlight.clear();
    };

    return { get, reset };
};

const countsCache = createAccountCache<DotaPlayerCounts>(async (accountId) => {
    const result = await openDotaMatchProvider.getPlayerCounts(accountId);
    return result.status === "ok" ? { status: "ok", value: result.counts } : result;
});

const totalsCache = createAccountCache<DotaPlayerTotals>(async (accountId) => {
    const result = await openDotaMatchProvider.getPlayerTotals(accountId);
    return result.status === "ok" ? { status: "ok", value: result.totals } : result;
});

const rankingsCache = createAccountCache<DotaHeroRanking[]>(async (accountId) => {
    const result = await openDotaMatchProvider.getPlayerRankings(accountId);
    return result.status === "ok" ? { status: "ok", value: result.rankings } : result;
});

export type CachedCountsResult =
    | { status: "ok"; counts: DotaPlayerCounts }
    | { status: SimpleStatus };
export const getCachedAccountCounts = async (accountId: number): Promise<CachedCountsResult> => {
    const result = await countsCache.get(accountId);
    return result.status === "ok" ? { status: "ok", counts: result.value } : result;
};

export type CachedTotalsResult =
    | { status: "ok"; totals: DotaPlayerTotals }
    | { status: SimpleStatus };
export const getCachedAccountTotals = async (accountId: number): Promise<CachedTotalsResult> => {
    const result = await totalsCache.get(accountId);
    return result.status === "ok" ? { status: "ok", totals: result.value } : result;
};

export type CachedRankingsResult =
    | { status: "ok"; rankings: DotaHeroRanking[] }
    | { status: SimpleStatus };
export const getCachedAccountRankings = async (accountId: number): Promise<CachedRankingsResult> => {
    const result = await rankingsCache.get(accountId);
    return result.status === "ok" ? { status: "ok", rankings: result.value } : result;
};

export type CurrentPatchResult =
    | {
          status: "ok";
          patchId: number;
          patchName: string | null;
          // WK-148 polish - true only when patchId is ALSO the highest id in
          // OpenDota's own /constants/patch list, i.e. we can positively
          // confirm this is the current live patch, not just "the newest one
          // this player happens to have played". A player who hasn't queued
          // since before the last patch shipped will have isLatestKnown:
          // false - the UI must then say "last observed", never "current"
          // (задача, "Patch semantics" polish pass - do not imply this is
          // definitely the current game patch).
          isLatestKnown: boolean;
      }
    | { status: "no_data" }
    | { status: SimpleStatus };

// Патч id растут строго по времени выпуска (см. odota/dotaconstants), поэтому
// максимальный patch id с играми > 0 в лайфтайм-counts аккаунта - это ровно
// "последний патч, на котором реально играл этот игрок". Не календарная
// догадка: пока OpenDota не проставил матчам новый patch id, метод
// продолжает показывать предыдущий (задача, секция 1). isLatestKnown
// сравнивает это с максимальным id во ВСЁМ списке /constants/patch (уже
// закэширован, 0 доп. запросов) - единственный способ отличить "это правда
// текущий патч" от "это просто последний патч, который видел этот игрок",
// без календарных догадок и без нового апстрим-вызова.
export const resolveCurrentPatchId = async (accountId: number): Promise<CurrentPatchResult> => {
    const countsResult = await getCachedAccountCounts(accountId);
    if (countsResult.status !== "ok") return countsResult;

    let patchId: number | null = null;
    for (const [key, bucket] of Object.entries(countsResult.counts.patch)) {
        if (bucket.games <= 0) continue;
        const id = Number(key);
        if (!Number.isFinite(id)) continue;
        if (patchId === null || id > patchId) patchId = id;
    }
    if (patchId === null) return { status: "no_data" };

    const patches = await getCachedPatchConstants();
    const highestKnownPatchId = patches.reduce((max, patch) => Math.max(max, patch.id), -Infinity);
    return {
        status: "ok",
        patchId,
        patchName: resolvePatchName(patchId, patches),
        isLatestKnown: patches.length > 0 && patchId >= highestKnownPatchId,
    };
};

export const __resetOpenDotaAccountInsightsCacheForTests = (): void => {
    countsCache.reset();
    totalsCache.reset();
    rankingsCache.reset();
};
