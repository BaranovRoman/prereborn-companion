import { Request, Response } from "express";
import { z } from "zod";
import { upsertCompanionState } from "../../services/stream-companion-service.js";
import { getSessionMatchRatingDelta } from "../../services/stream-match-service.js";
import {
    endActiveSession,
    getLatestSessionForUser,
    getOrCreateActiveSession,
    resetActiveSession,
    type StreamSession,
} from "../../services/stream-session-service.js";
import { getStreamUserGameMode } from "../../services/stream-user-service.js";
import {
    getQueueSettings,
    InvalidQueueSettingsError,
    saveQueueSettings,
} from "../../services/stream-queue-settings-service.js";
import { logger } from "../../utils/logger.js";
import { getTwitchChatStatus } from "../../services/twitch-integration-service.js";
import {
    isCompanionVersionSupported,
    MIN_SUPPORTED_COMPANION_VERSION,
} from "../../utils/companion-version.js";

// Разумный потолок для JSON-состояния GSI - даже со всеми data-категориями
// включёнными (map/player/hero/abilities/items/events/buildings/league/
// draft/wearables) реальный payload занимает единицы-десятки КБ. 256КБ - с
// большим запасом, но всё ещё на порядок меньше глобального лимита
// express.json({limit: "1mb"}) в app.ts, который защищает остальные
// эндпоинты - здесь это не единственная, а дополнительная, более точная
// проверка именно для JSON-only companion-эндпоинта.
const MAX_PAYLOAD_BYTES = 256 * 1024;

const gsiStateSchema = z.object({
    // Полный parsed JSON от Dota GSI - структура не документирована Valve
    // формально и меняется от матча к матчу, поэтому намеренно z.record, а
    // не строгая схема (см. задачу, п.9: "не типизировать всю структуру").
    payload: z.record(z.string(), z.unknown()),
    // Клиентский timestamp (когда companion получил payload от Dota) -
    // принимается, но НЕ используется как источник правды для
    // isCompanionOnline/receivedAt (см. stream-companion-service.ts) - это
    // серверные часы. Поле оставлено на будущее (диагностика задержки
    // companion -> backend), сейчас ни на что не влияет.
    timestamp: z.string().optional(),
    companionVersion: z.string().max(50).optional(),
});

// Авторизация - authenticateCompanionToken (routes/stream/companion.ts),
// пишет req.streamUserId. Никогда не логирует Authorization/тело запроса -
// requestLogger (middleware/request-logger.ts) в принципе не логирует
// тела/заголовки ни для одного эндпоинта, здесь дополнительно не делаем
// логирование payload и в error-путях этого контроллера.
export const putCompanionGsiStateController = async (
    req: Request,
    res: Response
) => {
    try {
        const rawSize = Buffer.byteLength(JSON.stringify(req.body ?? {}));
        if (rawSize > MAX_PAYLOAD_BYTES) {
            return res.status(413).json({ error: "Payload слишком большой" });
        }

        const parsed = gsiStateSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Неверный формат payload" });
        }

        if (!isCompanionVersionSupported(parsed.data.companionVersion)) {
            // 426 (not 400/403) so the companion's error handling can tell
            // "you're outdated" apart from a generic backend failure and
            // show the user something actionable instead of a raw status
            // code (see backend/mod.rs::send_state on the companion side).
            return res.status(426).json({
                error: "companion_outdated",
                message: `Companion устарел, требуется версия ${MIN_SUPPORTED_COMPANION_VERSION} или новее`,
                minVersion: MIN_SUPPORTED_COMPANION_VERSION,
            });
        }

        const streamUserId = req.streamUserId as string;

        // WK-113 - local-first cutover. This endpoint used to ALSO drive
        // match/session detection (processGsiPayloadForMatch), independently
        // of whatever Companion's own local state machine decided - two
        // state machines fed by the same raw GSI stream, capable of
        // disagreeing. Companion's local_runtime::detector is now the only
        // match-detection state machine; its resolved outcomes reach the
        // backend via POST /stream/companion/sync/events
        // (controllers/stream/sync.ts), never by re-deriving them here.
        // This endpoint's only remaining job is what it was always ALSO
        // doing alongside detection: storing the raw payload for the public
        // overlay's live GSI passthrough display and companion presence
        // (upsertCompanionState -> touchCompanionPresence) - genuinely
        // presence/live-view data, not a source of truth for match/session/
        // MMR.
        await upsertCompanionState(
            streamUserId,
            parsed.data.payload,
            parsed.data.companionVersion ?? null
        );
        logger.debug("Companion GSI payload accepted", { streamUserId });

        res.json({ ok: true });
    } catch (error) {
        logger.error("Companion GSI state ingest error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const getCompanionTwitchChatController = async (
    req: Request,
    res: Response
) => {
    try {
        res.json(await getTwitchChatStatus(req.streamUserId as string));
    } catch (error) {
        logger.error("Companion Twitch chat error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(502).json({ error: "Не удалось получить Twitch-чат" });
    }
};

// WK-83/WK-53 - минимальная сводка сессии для startup-предложения Companion
// ("продолжить прошлый стрим?" / "стрим завершён, начните новый"). Та же
// композиция sessionRatingDelta, что и overlay.ts (WK-105:
// getSessionMatchRatingDelta + getStreamUserGameMode) - не дублируем SQL,
// переиспользуем существующие сервисные функции. `state` (WK-53) - явный
// сигнал фронтенду Companion: для "ended" прошлую сессию нельзя предлагать
// "продолжить", только "начать новую" (см. session-prompt.ts на стороне
// Companion).
interface CompanionSessionSummary {
    state: "active" | "ended";
    id: string;
    startedAt: string;
    updatedAt: string;
    endedAt: string | null;
    wins: number;
    losses: number;
    sessionRatingDelta: number | null;
}

const buildCompanionSessionSummary = async (
    streamUserId: string,
    session: StreamSession,
    state: "active" | "ended"
): Promise<CompanionSessionSummary> => {
    const gameMode = await getStreamUserGameMode(streamUserId);

    let sessionRatingDelta: number | null = null;
    if (gameMode === "ranked" && session.rating !== null) {
        sessionRatingDelta = (await getSessionMatchRatingDelta(session.id)) ?? 0;
    }

    return {
        state,
        id: session.id,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        endedAt: session.endedAt,
        wins: session.wins,
        losses: session.losses,
        sessionRatingDelta,
    };
};

export const getCompanionSessionController = async (
    req: Request,
    res: Response
) => {
    try {
        const streamUserId = req.streamUserId as string;
        const active = await getOrCreateActiveSession(streamUserId);
        if (active) {
            return res.json(
                await buildCompanionSessionSummary(streamUserId, active, "active")
            );
        }

        // WK-53 - null means the stream was explicitly ended (see
        // getOrCreateActiveSession). getLatestSessionForUser here can only
        // fail to find a row in the theoretical case of a companion_token
        // that exists before the account has ever had ANY session - which
        // getOrCreateActiveSession itself would already have created above
        // (true first run), so this branch is effectively unreachable in
        // practice; 404 is the honest response if it somehow is.
        const latest = await getLatestSessionForUser(streamUserId);
        if (!latest) {
            return res.status(404).json({ error: "Нет сессии" });
        }
        res.json(await buildCompanionSessionSummary(streamUserId, latest, "ended"));
    } catch (error) {
        logger.error("Companion session fetch error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// Переиспользует ровно ту же resetActiveSession, что и веб-кабинет
// (POST /api/stream/account/session/reset, controllers/stream/session.ts) -
// см. задачу WK-83: "не создавать параллельную логику сброса". Companion не
// имеет JWT-доступа к /account/*, только companion_token, поэтому это новый
// маршрут, а не переиспользование того же route. Works from any lifecycle
// state (active/ended/none) - see resetActiveSession's WK-53 doc comment.
export const resetCompanionSessionController = async (
    req: Request,
    res: Response
) => {
    try {
        const streamUserId = req.streamUserId as string;
        const session = await resetActiveSession(streamUserId);
        res.json(
            await buildCompanionSessionSummary(streamUserId, session, "active")
        );
    } catch (error) {
        logger.error("Companion session reset error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-100 - "Завершить стрим" from inside Companion, so the streamer no
// longer has to open the web cabinet just to end a stream. Переиспользует
// ровно ту же endActiveSession, что и веб-кабинет
// (POST /api/stream/account/session/end, controllers/stream/session.ts) -
// не дублирует бизнес-логику завершения сессии, только маршрут другой
// (companion_token, не JWT - та же причина, что и у resetCompanionSession
// Controller выше). Idempotent for the same reason as the web endpoint's
// endSessionController: a double-click or a retry after a dropped response
// finds no active session (endActiveSession returns null) and just returns
// the already-ended latest session's summary instead of erroring. Once this
// responds 200, the very next poll_session_state on the Rust side (already
// polling GET /stream/companion/session every few seconds for the WK-99 OBS
// Post Stream automation) sees state "ended" independently of this call -
// this endpoint itself has no OBS side effect, it only flips the backend's
// session state, exactly like the web cabinet's End button already does.
export const endCompanionSessionController = async (
    req: Request,
    res: Response
) => {
    try {
        const streamUserId = req.streamUserId as string;
        const ended = await endActiveSession(streamUserId);
        const latest = ended ?? (await getLatestSessionForUser(streamUserId));
        if (!latest) {
            return res.status(409).json({ error: "Нет сессии для завершения" });
        }
        res.json(await buildCompanionSessionSummary(streamUserId, latest, "ended"));
    } catch (error) {
        logger.error("Companion session end error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-121 - Favorite heroes source of truth is `stream_queue_settings.
// favoriteHeroIds` (apps/api/src/services/stream-queue-settings-service.ts),
// already read/written by the web cabinet's Favorite Heroes picker via
// GET/PUT /account/me/queue-settings (authenticateStreamUser, JWT-only).
// Companion has no JWT session - only its own companion_token - and that
// endpoint was unreachable from Companion, which is exactly why the
// Heroes screen would otherwise have been tempted to invent a second,
// local-only favorites store. It doesn't: this route resolves the SAME
// `streamUserId` (authenticateCompanionToken sets the identical
// req.streamUserId field authenticateStreamUser does - see that
// middleware's own doc comment) and calls the SAME service functions -
// one row, two credentials that can read/write it, zero new entities. The
// wire shape here is deliberately narrower than the web endpoint's (only
// `favoriteHeroIds`, never visibility/widgets/channelGoal) since Companion
// has no use for - and shouldn't need to round-trip - the rest of that
// web-only queue-settings blob.
const favoriteHeroIdsSchema = z.object({
    favoriteHeroIds: z.array(z.number().int().positive()).max(3),
});

export const getCompanionFavoriteHeroesController = async (
    req: Request,
    res: Response
) => {
    try {
        const settings = await getQueueSettings(req.streamUserId as string);
        res.json({ favoriteHeroIds: settings.favoriteHeroIds });
    } catch (error) {
        logger.error("Companion favorite heroes fetch error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const putCompanionFavoriteHeroesController = async (
    req: Request,
    res: Response
) => {
    try {
        const parsed = favoriteHeroIdsSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Неверный формат избранных героев" });
        }
        const settings = await saveQueueSettings(req.streamUserId as string, {
            favoriteHeroIds: parsed.data.favoriteHeroIds,
        });
        res.json({ favoriteHeroIds: settings.favoriteHeroIds });
    } catch (error) {
        if (error instanceof InvalidQueueSettingsError) {
            return res.status(400).json({ error: error.message });
        }
        logger.error("Companion favorite heroes save error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
