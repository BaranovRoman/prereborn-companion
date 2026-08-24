import { Request, Response } from "express";
import { z } from "zod";
import {
    getSteamLink,
    linkSteamAccount,
    unlinkSteamAccount,
    SteamAlreadyLinkedError,
} from "../../services/stream-user-service.js";
import {
    getLatestSessionForUser,
    getOrCreateActiveSession,
} from "../../services/stream-session-service.js";
import {
    buildSteamAuthUrl,
    getSteamConfig,
    verifySteamCallback,
} from "../../services/steam-openid-service.js";
import {
    consumeConnectState,
    createConnectState,
} from "../../services/steam-connect-state-service.js";
import { steamId64ToDotaAccountId } from "../../services/steam-id.js";
import { logger } from "../../utils/logger.js";
import { openDotaMatchProvider } from "../../services/dota-match-provider.js";

// req.streamUserId гарантирован authenticateStreamUser (routes/stream/integrations.ts)
// на всех этих контроллерах, КРОМЕ callbackController - тот публичный,
// пользователь на этом шаге идентифицируется через одноразовый state, а не
// через Bearer-заголовок (браузерный редирект от Steam физически не может
// нести кастомные заголовки).

export const getSteamStatusController = async (req: Request, res: Response) => {
    try {
        const streamUserId = req.streamUserId as string;
        const link = await getSteamLink(streamUserId);

        if (!link) {
            return res.json({ connected: false });
        }

        // WK-53 - only used here for read-only sync bookkeeping display
        // (lastSyncedAt/lastSyncStatus), never to gate whether Steam is
        // "connected" - falls back to the latest ended session so the status
        // panel keeps showing when the last background sync ran even after
        // the stream has ended, without resurrecting anything.
        const session =
            (await getOrCreateActiveSession(streamUserId)) ??
            (await getLatestSessionForUser(streamUserId));
        const profileResult = await openDotaMatchProvider.getPlayerProfile(
            link.dotaAccountId
        );

        res.json({
            connected: true,
            steamId64: link.steamId64,
            connectedAt: link.connectedAt,
            lastSyncedAt: session?.lastSyncedAt ?? null,
            lastSyncStatus: session?.lastSyncStatus ?? null,
            profile:
                profileResult.status === "ok"
                    ? profileResult.profile
                    : null,
        });
    } catch (error) {
        logger.error("Steam status error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const connectSteamController = async (req: Request, res: Response) => {
    try {
        const config = getSteamConfig();
        if (!config) {
            return res
                .status(503)
                .json({ error: "Steam-интеграция не настроена на сервере" });
        }

        const state = await createConnectState(req.streamUserId as string);
        const redirectUrl = buildSteamAuthUrl(config, state);

        res.json({ redirectUrl });
    } catch (error) {
        logger.error("Steam connect error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const stateQuerySchema = z.object({ state: z.string().min(1) });

export const steamCallbackController = async (req: Request, res: Response) => {
    const config = getSteamConfig();

    // Без realm некуда даже редиректить с ошибкой - такое возможно только
    // если кто-то дёргает callback напрямую, минуя /connect (который сам
    // уже вернул бы 503 при не настроенном Steam).
    if (!config) {
        return res
            .status(503)
            .json({ error: "Steam-интеграция не настроена на сервере" });
    }

    const redirectWithStatus = (status: string, reason?: string) => {
        const url = new URL(`${config.realm}/stream`);
        url.searchParams.set("steam", status);
        if (reason) url.searchParams.set("reason", reason);
        res.redirect(url.toString());
    };

    try {
        const parsedState = stateQuerySchema.safeParse(req.query);
        if (!parsedState.success) {
            return redirectWithStatus("error", "missing_state");
        }

        const streamUserId = await consumeConnectState(parsedState.data.state);
        if (!streamUserId) {
            logger.warn("Steam callback: invalid or expired state", {
                requestId: req.requestId,
            });
            return redirectWithStatus("error", "invalid_state");
        }

        const verification = await verifySteamCallback(req.query);
        if (!verification.valid || !verification.steamId64) {
            logger.warn("Steam callback: OpenID verification failed", {
                requestId: req.requestId,
                streamUserId,
            });
            return redirectWithStatus("error", "verification_failed");
        }

        const dotaAccountId = steamId64ToDotaAccountId(verification.steamId64);

        try {
            await linkSteamAccount(streamUserId, verification.steamId64, dotaAccountId);
        } catch (error) {
            if (error instanceof SteamAlreadyLinkedError) {
                logger.warn("Steam callback: account already linked elsewhere", {
                    requestId: req.requestId,
                    streamUserId,
                });
                return redirectWithStatus("error", "already_linked");
            }
            throw error;
        }

        logger.info("Steam account linked", { streamUserId });
        redirectWithStatus("connected");
    } catch (error) {
        logger.error("Steam callback error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        redirectWithStatus("error", "internal");
    }
};

export const disconnectSteamController = async (req: Request, res: Response) => {
    try {
        await unlinkSteamAccount(req.streamUserId as string);
        logger.info("Steam account unlinked", {
            streamUserId: req.streamUserId,
        });
        res.status(204).send();
    } catch (error) {
        logger.error("Steam disconnect error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
