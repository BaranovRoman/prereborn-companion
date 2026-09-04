import { getCachedPlayerHeroes } from "./opendota-hero-stats-cache-service.js";
import { getCachedHeroPatchCounts } from "./opendota-hero-insights-cache-service.js";
import {
    getCachedAccountCounts,
    getCachedAccountTotals,
    resolveCurrentPatchId,
} from "./opendota-account-insights-cache-service.js";
import { computeHeroLifetimeStats, computeHeroPatchStats } from "./opendota-hero-insights-formulas.js";
import { computePlayerProfileRadar, type PlayerProfileRadar } from "./opendota-player-profile-radar.js";

// WK-148 - публичная (неавторизованная) web-сцена Between Matches никогда не
// ждёт OpenDota (задача, секция 5/12), в отличие от Hero Detail/Companion IPC
// выше - тот же null-и-фоновая-заливка паттерн, что и
// steam-profile-cache-service.ts (WK-121), а не blocking-паттерн
// opendota-hero-stats-cache-service.ts (WK-133).
//
// Внутри фоновой заливки этот сервис переиспользует те же blocking-кэши, что
// и Hero Detail/Companion IPC (getCachedPlayerHeroes/getCachedHeroPatchCounts/
// getCachedAccountTotals/getCachedAccountCounts/resolveCurrentPatchId) -
// "blocking" там означает только "ждёт реальный апстрим-ответ, если вызвано
// напрямую"; здесь их await происходит внутри fire-and-forget фоновой задачи,
// которую никто не ждёт, поэтому публичный путь остаётся неблокирующим, а
// апстрим-запросы и TTL-кэш переиспользуются между Hero Detail и Between
// Matches вместо дублирования (задача, секция 13).
const OVERLAY_TTL_MS = 5 * 60_000;

export interface OverlayFavoriteHeroEntry {
    // Lifetime "MATCHES · WINRATE" - основная строка (задача, секция 4),
    // переиспользует уже закэшированный /heroes (0 доп. запросов).
    lifetime: { games: number; wins: number; losses: number; winRate: number } | null;
    // Опциональная вторая строка "7.XX · WW%" - см. patchName ниже.
    patch: { games: number; wins: number; losses: number; winRate: number } | null;
}

export interface OverlayFavoriteHeroPatchStats {
    patchName: string | null;
    // WK-148 polish - see resolveCurrentPatchId's doc comment on
    // opendota-account-insights-cache-service.ts.
    isLatestKnown: boolean;
    perHero: Record<number, OverlayFavoriteHeroEntry>;
}

interface FavCacheEntry {
    expiresAt: number;
    value: OverlayFavoriteHeroPatchStats | null;
}

const favCache = new Map<string, FavCacheEntry>();
const favInFlight = new Set<string>();

const favKey = (accountId: number, heroIds: number[]): string =>
    `${accountId}:${[...heroIds].sort((a, b) => a - b).join(",")}`;

// Ключ включает набор избранных героев (не только accountId) - смена
// закреплённых героев естественно промахивается мимо кэша и перезаливается,
// без отдельного инвалидационного механизма (до 3 героев, дёшево).
export const getCachedOverlayFavoriteHeroStats = async (
    accountId: number,
    heroIds: number[]
): Promise<OverlayFavoriteHeroPatchStats | null> => {
    if (heroIds.length === 0) return null;
    const cacheKey = favKey(accountId, heroIds);
    const cached = favCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (!favInFlight.has(cacheKey)) {
        favInFlight.add(cacheKey);
        void (async () => {
            try {
                const [heroesResult, currentPatch, ...heroCountsResults] = await Promise.all([
                    getCachedPlayerHeroes(accountId),
                    resolveCurrentPatchId(accountId),
                    ...heroIds.map((heroId) => getCachedHeroPatchCounts(accountId, heroId)),
                ]);

                let value: OverlayFavoriteHeroPatchStats | null = null;
                if (heroesResult.status === "ok") {
                    const perHero: OverlayFavoriteHeroPatchStats["perHero"] = {};
                    heroIds.forEach((heroId, index) => {
                        const heroLifetime = heroesResult.heroes.find((entry) => entry.heroId === heroId);
                        const patchResult = heroCountsResults[index];
                        perHero[heroId] = {
                            lifetime: heroLifetime
                                ? computeHeroLifetimeStats(heroLifetime.games, heroLifetime.wins)
                                : null,
                            patch:
                                patchResult?.status === "ok" && currentPatch.status === "ok"
                                    ? computeHeroPatchStats(patchResult.patch, currentPatch.patchId)
                                    : null,
                        };
                    });
                    value = {
                        patchName: currentPatch.status === "ok" ? currentPatch.patchName : null,
                        isLatestKnown: currentPatch.status === "ok" && currentPatch.isLatestKnown,
                        perHero,
                    };
                }
                favCache.set(cacheKey, { value, expiresAt: Date.now() + OVERLAY_TTL_MS });
            } catch {
                // Сеть недоступна - публичная сцена остаётся без обогащения,
                // никогда не ломаем layout (задача, секция 12).
            } finally {
                favInFlight.delete(cacheKey);
            }
        })();
    }

    return cached?.value ?? null;
};

interface RadarCacheEntry {
    expiresAt: number;
    value: PlayerProfileRadar | null;
}

const radarCache = new Map<number, RadarCacheEntry>();
const radarInFlight = new Set<number>();

export const getCachedOverlayRadar = async (accountId: number): Promise<PlayerProfileRadar | null> => {
    const cached = radarCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (!radarInFlight.has(accountId)) {
        radarInFlight.add(accountId);
        void (async () => {
            try {
                const [heroesResult, totalsResult, countsResult] = await Promise.all([
                    getCachedPlayerHeroes(accountId),
                    getCachedAccountTotals(accountId),
                    getCachedAccountCounts(accountId),
                ]);

                let value: PlayerProfileRadar | null = null;
                if (heroesResult.status === "ok" && totalsResult.status === "ok") {
                    const heroGames = heroesResult.heroes
                        .filter((hero) => hero.games > 0)
                        .map((hero) => hero.games);
                    const roleCounts = countsResult.status === "ok" ? countsResult.counts.laneRole : null;
                    value = computePlayerProfileRadar(totalsResult.totals, heroGames, roleCounts);
                }
                radarCache.set(accountId, { value, expiresAt: Date.now() + OVERLAY_TTL_MS });
            } catch {
                // См. комментарий выше.
            } finally {
                radarInFlight.delete(accountId);
            }
        })();
    }

    return cached?.value ?? null;
};

export const __resetOpenDotaOverlayInsightsCacheForTests = (): void => {
    favCache.clear();
    favInFlight.clear();
    radarCache.clear();
    radarInFlight.clear();
};
