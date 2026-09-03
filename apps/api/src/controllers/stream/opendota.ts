import { Request, Response } from "express";
import { z } from "zod";
import { getSteamLink } from "../../services/stream-user-service.js";
import { getCachedPlayerHeroes } from "../../services/opendota-hero-stats-cache-service.js";
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
