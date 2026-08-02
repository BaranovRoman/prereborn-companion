import { Request, Response } from "express";
import { z } from "zod";
import {
    findStreamUserIdByPublicToken,
    getStreamUserGameMode,
    getSteamLink,
} from "../../services/stream-user-service.js";
import { getOrCreateActiveSession } from "../../services/stream-session-service.js";
import { syncRecentMatches } from "../../services/dota-sync-service.js";
import {
    getRecentMatchesForSession,
    getSessionStartRating,
} from "../../services/stream-match-service.js";
import { getOverlayLayout } from "../../services/stream-overlay-layout-service.js";
import { getQueueSettings } from "../../services/stream-queue-settings-service.js";
import {
    getCompanionState,
    getCompanionLastSeenAt,
    isCompanionOnline,
} from "../../services/stream-companion-service.js";
import { logger } from "../../utils/logger.js";
import { getCachedSteamProfile } from "../../services/steam-profile-cache-service.js";
import { getTwitchStatus } from "../../services/twitch-integration-service.js";

const publicTokenSchema = z.string().uuid();

// Публичный, без авторизации - открывается напрямую в OBS Browser Source и
// опрашивается поллингом (см. frontend use-overlay-polling.ts). Намеренно
// не возвращает email/внутренний streamUserId/токены и не тащит завершённые
// сессии - только текущие значения активной сессии. lastHeroId - просто
// число: разрешение id -> имя/иконка героя целиком на фронтенде
// (entities/dota-hero), бэкенд про Dota ничего не знает.
export const getOverlayController = async (req: Request, res: Response) => {
    // no-store - overlay должен всегда показывать актуальные данные, ни
    // browser, ни промежуточный прокси не должны это кэшировать.
    res.set("Cache-Control", "no-store");

    try {
        const publicToken = publicTokenSchema.parse(req.params.publicToken);

        const streamUserId = await findStreamUserIdByPublicToken(publicToken);
        if (!streamUserId) {
            return res.status(404).json({ error: "Overlay не найден" });
        }

        const session = await getOrCreateActiveSession(streamUserId);
        const gameMode = await getStreamUserGameMode(streamUserId);
        const [companionState, companionLastSeenAt] = await Promise.all([
            getCompanionState(streamUserId),
            getCompanionLastSeenAt(streamUserId),
        ]);
        const steamLink = await getSteamLink(streamUserId);
        const steamProfile = steamLink
            ? await getCachedSteamProfile(steamLink.dotaAccountId)
            : null;
        // Последние завершённые матчи, распознанные из GSI (см.
        // services/stream-match-service.ts) - id/hero_id/K-D-A/result/endedAt
        // only, без внутреннего streamUserId/сырого GSI payload матча.
        // Скоуп по ТЕКУЩЕЙ сессии (не по streamUserId целиком) - иначе
        // "начать новый стрим" не очищал бы этот список (см. задачу).
        const matches = await getRecentMatchesForSession(session.id, 10);
        // Раскладка виджетов - редко меняется, но отдаётся вместе с
        // остальным payload'ом одного и того же поллинга (см. задачу, п.12):
        // отдельный опрос под layout не нужен.
        const [layout, queueSettings, twitch] = await Promise.all([
            getOverlayLayout(streamUserId),
            getQueueSettings(streamUserId),
            getTwitchStatus(streamUserId),
        ]);

        // Суммарное изменение рейтинга за текущую сессию (см. задачу: рядом
        // с MMR показывать "+75"/"-25"/"±0") - только для ranked, unranked
        // никогда не показывает рейтинг вообще (см. SessionStats). Если в
        // сессии ещё не было ranked-матча с известным ratingBefore, менять
        // было нечего - дельта 0, а не null, чтобы не отличать это от "нет
        // изменений" на фронтенде.
        let sessionRatingDelta: number | null = null;
        if (gameMode === "ranked" && session.rating !== null) {
            const startRating = await getSessionStartRating(session.id);
            sessionRatingDelta = startRating !== null ? session.rating - startRating : 0;
        }

        // Публичный poll overlay - единственный способ обновлять W/L/героя,
        // пока открыт только OBS, а не страница /stream (см. задачу, п.10).
        // Fire-and-forget: не ждём результата, чтобы sync (сетевой поход в
        // OpenDota) не увеличивал задержку ответа overlay - если появятся
        // новые матчи, они попадут в СЛЕДУЮЩИЙ poll (через ~5с), это
        // приемлемо для MVP. syncRecentMatches сам по себе no-op, если Steam
        // не привязан или cooldown/in-flight ещё не истёк - здесь не нужно
        // дублировать эти проверки.
        syncRecentMatches(streamUserId).catch((error) => {
            logger.error("Background Dota sync from overlay poll failed", {
                requestId: req.requestId,
                message: error instanceof Error ? error.message : String(error),
            });
        });

        res.json({
            rating: session.rating,
            sessionRatingDelta,
            wins: session.wins,
            losses: session.losses,
            lastHeroId: session.lastHeroId,
            updatedAt: session.updatedAt,
            gameMode,
            matches: matches.map((match) => ({
                id: match.id,
                dotaMatchId: match.matchId,
                heroId: match.heroId,
                kills: match.kills,
                deaths: match.deaths,
                assists: match.assists,
                inventory: match.inventory,
                result: match.result,
                ratingBefore: match.ratingBefore,
                ratingDelta: match.ratingDelta,
                ratingAfter: match.ratingAfter,
                gameMode: match.gameMode,
                endedAt: match.endedAt,
            })),
            companion: {
                isOnline: isCompanionOnline(companionLastSeenAt),
                receivedAt: companionState?.receivedAt ?? null,
                companionVersion: companionState?.companionVersion ?? null,
                payload: companionState?.payload ?? null,
            },
            steam: {
                connected: steamLink !== null,
                profile: steamProfile,
            },
            twitch,
            layout,
            queueSettings,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Неверный формат токена" });
        }
        logger.error("Stream overlay lookup error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
