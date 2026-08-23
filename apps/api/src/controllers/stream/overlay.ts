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
    getRecentFinalizedMatches,
    getRecentMatchesForSession,
    getSessionStartRating,
} from "../../services/stream-match-service.js";
import { getOverlayLayout } from "../../services/stream-overlay-layout-service.js";
import { getQueueSettings } from "../../services/stream-queue-settings-service.js";
import { getViewerAlertsSettings } from "../../services/stream-viewer-alerts-settings-service.js";
import {
    getCompanionState,
    getCompanionLastSeenAt,
    isCompanionOnline,
} from "../../services/stream-companion-service.js";
import { logger } from "../../utils/logger.js";
import { getCachedSteamProfile } from "../../services/steam-profile-cache-service.js";
import { getTwitchStatus, getTwitchViewerEvents } from "../../services/twitch-integration-service.js";
import { getObsSceneOverride } from "../../services/obs-scene-command-service.js";
import { getDonationAlertsStatus } from "../../services/donation-alerts-integration-service.js";

const publicTokenSchema = z.string().uuid();

const INTEGRATION_STATUS_TTL_MS = 15_000;
const INTEGRATION_STATUS_CACHE_MAX = 500;
type IntegrationStatus = {
    twitch: Awaited<ReturnType<typeof getTwitchStatus>>;
    donationAlerts: Awaited<ReturnType<typeof getDonationAlertsStatus>> | null;
};
const integrationStatusCache = new Map<
    string,
    { expiresAt: number; value: IntegrationStatus }
>();
const integrationStatusRefreshes = new Map<string, Promise<IntegrationStatus>>();

export const loadIntegrationStatus = async (
    streamUserId: string,
    requestId?: string
): Promise<IntegrationStatus> => {
    const cached = integrationStatusCache.get(streamUserId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) integrationStatusCache.delete(streamUserId);

    const inFlight = integrationStatusRefreshes.get(streamUserId);
    if (inFlight) return inFlight;

    const refresh = Promise.all([
        getTwitchStatus(streamUserId),
        getDonationAlertsStatus(streamUserId).catch((error) => {
            logger.error("DonationAlerts sync from overlay poll failed", {
                requestId,
                message: error instanceof Error ? error.message : String(error),
            });
            return null;
        }),
    ]).then(([twitch, donationAlerts]) => {
        if (!integrationStatusCache.has(streamUserId) &&
            integrationStatusCache.size >= INTEGRATION_STATUS_CACHE_MAX) {
            const oldestKey = integrationStatusCache.keys().next().value as
                | string
                | undefined;
            if (oldestKey) integrationStatusCache.delete(oldestKey);
        }
        const value = { twitch, donationAlerts };
        integrationStatusCache.set(streamUserId, {
            expiresAt: Date.now() + INTEGRATION_STATUS_TTL_MS,
            value,
        });
        return value;
    }).finally(() => {
        integrationStatusRefreshes.delete(streamUserId);
    });
    integrationStatusRefreshes.set(streamUserId, refresh);
    return refresh;
};

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
        const obsSceneOverride = getObsSceneOverride(streamUserId);
        const sceneOverride = obsSceneOverride?.scene ?? null;
        const draftProtectionModeOverride = obsSceneOverride?.draftProtectionMode ?? null;
        const gameMode = await getStreamUserGameMode(streamUserId);
        const [companionState, companionLastSeenAt] = await Promise.all([
            getCompanionState(streamUserId),
            getCompanionLastSeenAt(streamUserId),
        ]);
        const steamLink = await getSteamLink(streamUserId);
        const steamProfile = steamLink
            ? await getCachedSteamProfile(steamLink.dotaAccountId)
            : null;
        // Раскладка виджетов - редко меняется, но отдаётся вместе с
        // остальным payload'ом одного и того же поллинга (см. задачу, п.12):
        // отдельный опрос под layout не нужен.
        const [layout, queueSettings, viewerAlertsSettings, integrations] = await Promise.all([
            getOverlayLayout(streamUserId),
            getQueueSettings(streamUserId),
            getViewerAlertsSettings(streamUserId),
            loadIntegrationStatus(streamUserId, req.requestId),
        ]);
        const { twitch, donationAlerts } = integrations;
        // WK-72 - ensureTwitchChat() already ran inside getTwitchStatus()
        // above (part of `integrations`), so this in-memory read picks up
        // whatever follow/subscribe/gift/raid events have arrived on that
        // connection since - same "already-open connection, no extra
        // request" shape as chat.messages.
        const viewerEvents = getTwitchViewerEvents(streamUserId);

        const configuredRecentMatches = Object.values(layout.scenes).map(
            (scene) => scene.widgets.recentMatches.recentMatches
        );
        const maxLimitFor = (source: "current-stream" | "recent-matches") =>
            Math.max(
                0,
                ...configuredRecentMatches
                    .filter((settings) => settings.source === source)
                    .map((settings) => settings.limit)
            );
        const currentStreamLimit = maxLimitFor("current-stream");
        // WK-89 - recentMatches (account-wide history) must stay populated for
        // Between Matches (Last Match/Recent Games) regardless of whether any
        // gameplay/draft HUD widget happens to be configured with
        // source: "recent-matches" - that config only controls an optional
        // in-HUD widget, it was never meant to gate the public Queue scene's
        // own Recent Games panel, whose own limit comes from queueSettings.
        // Root cause of the WK-83/84 regression: this used to be 0 (empty)
        // whenever no HUD widget opted into "recent-matches", which is the
        // default - so a session reset appeared to wipe Between Matches'
        // history, when actually the account-wide field was just never
        // sized to begin with.
        const recentMatchesLimit = Math.max(
            maxLimitFor("recent-matches"),
            queueSettings.widgets.recentGamesLimit
        );
        const [matches, recentMatches] = await Promise.all([
            currentStreamLimit > 0
                ? getRecentMatchesForSession(session.id, currentStreamLimit)
                : Promise.resolve([]),
            recentMatchesLimit > 0
                ? getRecentFinalizedMatches(streamUserId, recentMatchesLimit)
                : Promise.resolve([]),
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
            sceneOverride,
            draftProtectionModeOverride,
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
                // WK-89 - lets the public overlay tell current-session matches
                // apart from previous-session ones (see
                // isMatchFromCurrentSession) without exposing anything more
                // sensitive than an internal session id.
                streamSessionId: match.streamSessionId,
            })),
            recentMatches: recentMatches.map((match) => ({
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
                streamSessionId: match.streamSessionId,
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
            donationAlerts,
            viewerEvents,
            viewerAlertsSettings,
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
