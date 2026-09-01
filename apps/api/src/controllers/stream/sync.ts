import { Request, Response } from "express";
import { z } from "zod";
import {
    applyMatchFinalized,
    applySessionEnded,
    applySessionStarted,
    getCorrectionsSince,
} from "../../services/stream-sync-service.js";
import { getStreamUserGameMode } from "../../services/stream-user-service.js";
import { getSteamLink } from "../../services/stream-user-service.js";
import { getCachedSteamProfile } from "../../services/steam-profile-cache-service.js";
import { getTwitchStatus } from "../../services/twitch-integration-service.js";
import { getLatestSessionForUser } from "../../services/stream-session-service.js";
import { logger } from "../../utils/logger.js";

// WK-113 - the only entry point through which Companion's local-first
// runtime (local_runtime::sync, Rust) reaches the backend. Deliberately a
// small, versioned, semantic event contract - session_started/session_ended/
// match_finalized - not a raw-GSI passthrough (see
// controllers/stream/companion.ts's putCompanionGsiStateController, which no
// longer feeds match detection). Each event carries a client-generated
// `eventId` the sync worker retries verbatim on failure - see
// stream-sync-service.ts's withIdempotency for how that's turned into an
// exactly-once guarantee.

const sessionStartedPayloadSchema = z.object({
    localSessionId: z.string().uuid(),
    startedAt: z.string(),
    ratingStart: z.number().int().positive().nullable(),
});

const sessionEndedPayloadSchema = z.object({
    localSessionId: z.string().uuid(),
    endedAt: z.string(),
});

const matchFinalizedPayloadSchema = z.object({
    localSessionId: z.string().uuid(),
    localMatchId: z.string().uuid(),
    matchId: z.string().nullable(),
    heroId: z.number().int().positive(),
    kills: z.number().int().nonnegative().nullable().optional(),
    deaths: z.number().int().nonnegative().nullable().optional(),
    assists: z.number().int().nonnegative().nullable().optional(),
    inventory: z.array(z.string().nullable()).max(9).optional(),
    result: z.enum(["win", "loss", "abandon"]),
    isRanked: z.boolean().nullable(),
    ratingBefore: z.number().int().positive().nullable(),
    detectedRatingDelta: z.number().int().nullable(),
    ratingAfter: z.number().int().positive().nullable(),
    confidence: z.enum(["confirmed", "probable"]),
    startedAt: z.string(),
    finalizedAt: z.string(),
});

const syncEventSchema = z.discriminatedUnion("eventType", [
    z.object({ eventId: z.string().uuid(), eventType: z.literal("session_started"), payload: sessionStartedPayloadSchema }),
    z.object({ eventId: z.string().uuid(), eventType: z.literal("session_ended"), payload: sessionEndedPayloadSchema }),
    z.object({ eventId: z.string().uuid(), eventType: z.literal("match_finalized"), payload: matchFinalizedPayloadSchema }),
]);

// 422 (not 500) for a schema-invalid event - this is the signal the sync
// worker uses to stop retrying and dead-letter the event instead of
// backing off forever against a payload that will never become valid (see
// local_runtime::sync's drain loop: 4xx = permanent failure, 5xx/network =
// retry).
export const postSyncEventController = async (req: Request, res: Response) => {
    const parsed = syncEventSchema.safeParse(req.body);
    if (!parsed.success) {
        logger.warn("Sync event rejected: invalid payload", {
            requestId: req.requestId,
            issues: parsed.error.issues,
        });
        return res.status(422).json({ error: "invalid_event", issues: parsed.error.issues });
    }

    const streamUserId = req.streamUserId as string;
    const { eventId, eventType, payload } = parsed.data;

    try {
        switch (eventType) {
            case "session_started": {
                const result = await applySessionStarted(streamUserId, eventId, payload);
                return res.json({ ok: true, result });
            }
            case "session_ended": {
                const result = await applySessionEnded(streamUserId, eventId, payload);
                return res.json({ ok: true, result });
            }
            case "match_finalized": {
                const result = await applyMatchFinalized(streamUserId, eventId, payload);
                return res.json({ ok: true, result });
            }
        }
    } catch (error) {
        logger.error("Sync event apply error", {
            requestId: req.requestId,
            eventType,
            message: error instanceof Error ? error.message : String(error),
        });
        return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const correctionsQuerySchema = z.object({
    since: z.string(),
});

export const getSyncCorrectionsController = async (req: Request, res: Response) => {
    const parsed = correctionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid_query" });
    }
    try {
        const streamUserId = req.streamUserId as string;
        const corrections = await getCorrectionsSince(streamUserId, parsed.data.since);
        res.json({ corrections });
    } catch (error) {
        logger.error("Sync corrections fetch error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-113 - the ranked/unranked account toggle, read-only, so Companion can
// cache it locally (local_runtime's RankedMode) instead of guessing or
// depending on a live backend round-trip during match creation. Reuses the
// exact same authoritative source stream-match-service.ts's (now-dormant)
// resolveIsRanked used to read - see docs/research/wk-110-local-first-audit.md
// §2.3/§5 ("Companion caches the toggle locally at session start").
export const getCompanionAccountSettingsController = async (req: Request, res: Response) => {
    try {
        const streamUserId = req.streamUserId as string;
        const [gameMode, latestSession, steamLink, twitch] = await Promise.all([
            getStreamUserGameMode(streamUserId),
            getLatestSessionForUser(streamUserId),
            getSteamLink(streamUserId),
            getTwitchStatus(streamUserId),
        ]);
        const steamProfile = steamLink ? await getCachedSteamProfile(steamLink.dotaAccountId) : null;
        res.json({
            gameMode,
            currentMmr: latestSession?.rating ?? null,
            steam: { connected: steamLink !== null, profile: steamProfile },
            twitch: {
                connected: twitch.connected,
                ...(twitch.connected ? {
                    login: twitch.login,
                    displayName: twitch.displayName,
                    profileImageUrl: twitch.profileImageUrl,
                    live: twitch.live,
                } : {}),
            },
        });
    } catch (error) {
        logger.error("Companion account-settings fetch error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
