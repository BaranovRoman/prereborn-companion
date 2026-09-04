import { Request, Response } from "express";
import { z } from "zod";
import { getSteamLink } from "../../services/stream-user-service.js";
import { getCachedPlayerHeroes } from "../../services/opendota-hero-stats-cache-service.js";
import {
    getCachedHeroPatchCounts,
    getCachedHeroRecentMatches,
    getCachedHeroTotals,
} from "../../services/opendota-hero-insights-cache-service.js";
import {
    getCachedAccountCounts,
    getCachedAccountRankings,
    getCachedAccountTotals,
    resolveCurrentPatchId,
} from "../../services/opendota-account-insights-cache-service.js";
import {
    computeHeroKdaAverages,
    computeHeroLifetimeStats,
    computeHeroParsedAverages,
    computeHeroPatchStats,
    computeRecentForm,
} from "../../services/opendota-hero-insights-formulas.js";
import { computePlayerProfileRadar } from "../../services/opendota-player-profile-radar.js";
import { logger } from "../../utils/logger.js";

// WK-133 - продуктовый контракт для Hero Detail (задача, секция 21): никогда
// не отдаём сырой OpenDota payload и никогда не отдаём OPENDOTA_API_KEY.
// Дискриминированный `status` вместо HTTP-кодов ошибок - фронтенд Companion
// должен уметь спокойно отрисовать "нет данных"/"недоступно", не заворачивая
// каждый вызов в try/catch по HTTP-статусу (тот же паттерн, что и у
// SteamIntegrationStatus/DotaSyncStatus в apps/web).
type OpenDotaHeroStatsResponse =
    | {
          status: "ok";
          source: "opendota";
          heroId: number;
          games: number;
          wins: number;
          losses: number;
          winRate: number | null;
          fetchedAt: string;
      }
    | { status: "steam_not_connected" }
    | { status: "no_data" }
    | { status: "rate_limited" }
    | { status: "unavailable" };

const paramsSchema = z.object({
    heroId: z.coerce.number().int().positive(),
});

export const getOpenDotaHeroStatsController = async (req: Request, res: Response) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: "Некорректный heroId" });
    }
    const { heroId } = parsed.data;

    try {
        const streamUserId = req.streamUserId as string;
        const link = await getSteamLink(streamUserId);
        if (!link) {
            return res.json({ status: "steam_not_connected" } satisfies OpenDotaHeroStatsResponse);
        }

        const result = await getCachedPlayerHeroes(link.dotaAccountId);

        if (result.status !== "ok") {
            // "not_found" (приватный профиль/аккаунт без матчей - см.
            // dota-match-provider.ts, они неразличимы у OpenDota) продукту
            // выглядит так же, как "нет данных по этому герою".
            const status = result.status === "not_found" ? "no_data" : result.status;
            return res.json({ status } satisfies OpenDotaHeroStatsResponse);
        }

        const hero = result.heroes.find((entry) => entry.heroId === heroId);
        if (!hero || hero.games === 0) {
            return res.json({ status: "no_data" } satisfies OpenDotaHeroStatsResponse);
        }

        const losses = Math.max(0, hero.games - hero.wins);
        res.json({
            status: "ok",
            source: "opendota",
            heroId,
            games: hero.games,
            wins: hero.wins,
            losses,
            winRate: hero.games > 0 ? (hero.wins / hero.games) * 100 : null,
            fetchedAt: new Date().toISOString(),
        } satisfies OpenDotaHeroStatsResponse);
    } catch (error) {
        logger.error("OpenDota hero stats error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-148 - расширение Hero Detail за пределы lifetime-блока (задача, секция
// 2): recent form / патч-статистика / KDA-GPM-XPM / best-effort ranking.
// Отдельный эндпоинт от getOpenDotaHeroStatsController - lifetime-панель
// (WK-133) продолжает работать как раньше и не меняет свой контракт; этот
// эндпоинт - чисто аддитивное обогащение того же героя. Каждый под-блок
// (recentForm/patch/kda/parsed-метрики/rankPercent) независимо nullable -
// частичный сбой одного апстрим-вызова не должен ронять остальные (задача,
// секция 12: "все опциональны и скрываются по отдельности").
export type OpenDotaHeroInsightsResponse =
    | {
          status: "ok";
          source: "opendota";
          heroId: number;
          recentForm: { sample: number; wins: number; losses: number; winRate: number } | null;
          patch: {
              patchId: number;
              patchName: string | null;
              games: number;
              wins: number;
              losses: number;
              winRate: number;
          } | null;
          kills: number | null;
          deaths: number | null;
          assists: number | null;
          goldPerMin: number | null;
          xpPerMin: number | null;
          heroDamage: number | null;
          towerDamage: number | null;
          heroHealing: number | null;
          rankPercent: number | null;
          fetchedAt: string;
      }
    | { status: "steam_not_connected" }
    | { status: "no_data" }
    | { status: "rate_limited" }
    | { status: "unavailable" };

export const getOpenDotaHeroInsightsController = async (req: Request, res: Response) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: "Некорректный heroId" });
    }
    const { heroId } = parsed.data;

    try {
        const streamUserId = req.streamUserId as string;
        const link = await getSteamLink(streamUserId);
        if (!link) {
            return res.json({ status: "steam_not_connected" } satisfies OpenDotaHeroInsightsResponse);
        }

        const [recentResult, patchCountsResult, totalsResult, currentPatch, rankingsResult] =
            await Promise.all([
                getCachedHeroRecentMatches(link.dotaAccountId, heroId),
                getCachedHeroPatchCounts(link.dotaAccountId, heroId),
                getCachedHeroTotals(link.dotaAccountId, heroId),
                resolveCurrentPatchId(link.dotaAccountId),
                getCachedAccountRankings(link.dotaAccountId),
            ]);

        const coreStatuses = [recentResult.status, patchCountsResult.status, totalsResult.status];
        if (coreStatuses.every((status) => status !== "ok")) {
            if (coreStatuses.includes("rate_limited")) {
                return res.json({ status: "rate_limited" } satisfies OpenDotaHeroInsightsResponse);
            }
            if (coreStatuses.every((status) => status === "not_found")) {
                return res.json({ status: "no_data" } satisfies OpenDotaHeroInsightsResponse);
            }
            return res.json({ status: "unavailable" } satisfies OpenDotaHeroInsightsResponse);
        }

        const recentForm =
            recentResult.status === "ok" ? computeRecentForm(recentResult.matches) : null;

        let patch: Extract<OpenDotaHeroInsightsResponse, { status: "ok" }>["patch"] = null;
        if (patchCountsResult.status === "ok" && currentPatch.status === "ok") {
            const stats = computeHeroPatchStats(patchCountsResult.patch, currentPatch.patchId);
            if (stats) patch = { ...stats, patchName: currentPatch.patchName };
        }

        const kda = totalsResult.status === "ok" ? computeHeroKdaAverages(totalsResult.totals) : null;
        const parsedAverages =
            totalsResult.status === "ok" ? computeHeroParsedAverages(totalsResult.totals) : null;

        const rankPercent =
            rankingsResult.status === "ok"
                ? (rankingsResult.rankings.find((entry) => entry.heroId === heroId)?.percentRank ?? null)
                : null;

        res.json({
            status: "ok",
            source: "opendota",
            heroId,
            recentForm,
            patch,
            kills: kda?.kills ?? null,
            deaths: kda?.deaths ?? null,
            assists: kda?.assists ?? null,
            goldPerMin: kda?.goldPerMin ?? null,
            xpPerMin: kda?.xpPerMin ?? null,
            heroDamage: parsedAverages?.heroDamage ?? null,
            towerDamage: parsedAverages?.towerDamage ?? null,
            heroHealing: parsedAverages?.heroHealing ?? null,
            rankPercent: rankPercent !== null ? Math.round(rankPercent * 1000) / 10 : null,
            fetchedAt: new Date().toISOString(),
        } satisfies OpenDotaHeroInsightsResponse);
    } catch (error) {
        logger.error("OpenDota hero insights error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-148 - "ПРОФИЛЬ ИГРОКА" (задача, секции 6-10): аккаунт-уровневые оси,
// НЕ per-hero. insufficient_data - отдельный статус от no_data (задача,
// секция 10) - у игрока могут быть матчи, но их пока недостаточно для
// осмысленного профиля.
export type OpenDotaProfileRadarResponse =
    | {
          status: "ok";
          source: "opendota";
          combat: number | null;
          farm: number | null;
          support: number | null;
          objectives: number | null;
          flexibility: number | null;
          fetchedAt: string;
      }
    | { status: "steam_not_connected" }
    | { status: "insufficient_data" }
    | { status: "rate_limited" }
    | { status: "unavailable" };

export const getOpenDotaProfileRadarController = async (req: Request, res: Response) => {
    try {
        const streamUserId = req.streamUserId as string;
        const link = await getSteamLink(streamUserId);
        if (!link) {
            return res.json({ status: "steam_not_connected" } satisfies OpenDotaProfileRadarResponse);
        }

        const [heroesResult, totalsResult, countsResult] = await Promise.all([
            getCachedPlayerHeroes(link.dotaAccountId),
            getCachedAccountTotals(link.dotaAccountId),
            getCachedAccountCounts(link.dotaAccountId),
        ]);

        if (heroesResult.status === "rate_limited" || totalsResult.status === "rate_limited") {
            return res.json({ status: "rate_limited" } satisfies OpenDotaProfileRadarResponse);
        }
        if (heroesResult.status !== "ok" || totalsResult.status !== "ok") {
            return res.json({ status: "insufficient_data" } satisfies OpenDotaProfileRadarResponse);
        }

        const heroGames = heroesResult.heroes
            .filter((hero) => hero.games > 0)
            .map((hero) => hero.games);
        const roleCounts = countsResult.status === "ok" ? countsResult.counts.laneRole : null;
        const radar = computePlayerProfileRadar(totalsResult.totals, heroGames, roleCounts);

        if (radar.insufficientSample) {
            return res.json({ status: "insufficient_data" } satisfies OpenDotaProfileRadarResponse);
        }

        res.json({
            status: "ok",
            source: "opendota",
            combat: radar.combat,
            farm: radar.farm,
            support: radar.support,
            objectives: radar.objectives,
            flexibility: radar.flexibility,
            fetchedAt: new Date().toISOString(),
        } satisfies OpenDotaProfileRadarResponse);
    } catch (error) {
        logger.error("OpenDota profile radar error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-148 - лёгкий bundle (lifetime + патч) для до 3 избранных героев за один
// вызов - авторизованный эквивалент того, что публичный
// opendota-overlay-insights-cache-service.ts вычисляет для веб-сцены, но
// синхронно (никакого null-until-warm - это background-поток Companion
// (opendota_overlay_cache.rs), а не публичный оверлей, ждать здесь можно и
// нужно). Локальный рендерер Between Matches (127.0.0.1:3666/overlay) не
// имеет доступа к Tauri IPC (см. задачу, секция 5) - Rust-сторона дёргает
// этот HTTP-эндпоинт напрямую по таймеру и кладёт результат в
// OverlayStateSnapshot, чтобы сам рендерер никогда не ждал сеть.
const MAX_FAVORITE_HEROES = 3; // должно совпадать с .max(3) в stream-queue-settings-service.ts

const favoriteHeroesQuerySchema = z.object({
    heroIds: z
        .string()
        .transform((value) =>
            value
                .split(",")
                .map((part) => Number(part.trim()))
                .filter((id) => Number.isInteger(id) && id > 0)
        )
        .refine((ids) => ids.length > 0 && ids.length <= MAX_FAVORITE_HEROES, {
            message: `heroIds must contain 1-${MAX_FAVORITE_HEROES} positive integers`,
        }),
});

export type OpenDotaFavoriteHeroesResponse =
    | {
          status: "ok";
          source: "opendota";
          patchName: string | null;
          heroes: Array<{
              heroId: number;
              lifetime: { games: number; wins: number; losses: number; winRate: number } | null;
              patch: { games: number; wins: number; losses: number; winRate: number } | null;
          }>;
          fetchedAt: string;
      }
    | { status: "steam_not_connected" }
    | { status: "no_data" }
    | { status: "rate_limited" }
    | { status: "unavailable" };

export const getOpenDotaFavoriteHeroesController = async (req: Request, res: Response) => {
    const parsed = favoriteHeroesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "Некорректный heroIds" });
    }
    const { heroIds } = parsed.data;

    try {
        const streamUserId = req.streamUserId as string;
        const link = await getSteamLink(streamUserId);
        if (!link) {
            return res.json({ status: "steam_not_connected" } satisfies OpenDotaFavoriteHeroesResponse);
        }

        const [heroesResult, currentPatch, ...patchResults] = await Promise.all([
            getCachedPlayerHeroes(link.dotaAccountId),
            resolveCurrentPatchId(link.dotaAccountId),
            ...heroIds.map((heroId) => getCachedHeroPatchCounts(link.dotaAccountId, heroId)),
        ]);

        if (heroesResult.status === "rate_limited") {
            return res.json({ status: "rate_limited" } satisfies OpenDotaFavoriteHeroesResponse);
        }
        if (heroesResult.status !== "ok") {
            return res.json({
                status: heroesResult.status === "not_found" ? "no_data" : "unavailable",
            } satisfies OpenDotaFavoriteHeroesResponse);
        }

        const heroes = heroIds.map((heroId, index) => {
            const heroLifetime = heroesResult.heroes.find((entry) => entry.heroId === heroId);
            const patchResult = patchResults[index];
            return {
                heroId,
                lifetime: heroLifetime
                    ? computeHeroLifetimeStats(heroLifetime.games, heroLifetime.wins)
                    : null,
                patch:
                    patchResult?.status === "ok" && currentPatch.status === "ok"
                        ? computeHeroPatchStats(patchResult.patch, currentPatch.patchId)
                        : null,
            };
        });

        res.json({
            status: "ok",
            source: "opendota",
            patchName: currentPatch.status === "ok" ? currentPatch.patchName : null,
            heroes,
            fetchedAt: new Date().toISOString(),
        } satisfies OpenDotaFavoriteHeroesResponse);
    } catch (error) {
        logger.error("OpenDota favorite heroes error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
