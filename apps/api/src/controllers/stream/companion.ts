import { Request, Response } from "express";
import { z } from "zod";
import { upsertCompanionState } from "../../services/stream-companion-service.js";
import {
    getSessionStartRating,
    processGsiPayloadForMatch,
} from "../../services/stream-match-service.js";
import {
    getLatestSessionForUser,
    getOrCreateActiveSession,
    resetActiveSession,
    type StreamSession,
} from "../../services/stream-session-service.js";
import { getStreamUserGameMode } from "../../services/stream-user-service.js";
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

        await upsertCompanionState(
            streamUserId,
            parsed.data.payload,
            parsed.data.companionVersion ?? null
        );
        logger.debug("Companion GSI payload accepted", { streamUserId });

        // Матч-детекция не должна валить приём GSI-состояния - основной
        // контракт этого эндпоинта (companion ждёт {ok:true} каждую секунду)
        // важнее детекции завершения матча, поэтому ошибка здесь только
        // логируется, а не пробрасывается в общий catch/500 ниже.
        processGsiPayloadForMatch(streamUserId, parsed.data.payload).catch(
            (error) => {
                logger.error("Stream match detection error", {
                    requestId: req.requestId,
                    message:
                        error instanceof Error ? error.message : String(error),
                });
            }
        );

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
// композиция sessionRatingDelta, что и overlay.ts (getSessionStartRating +
// getStreamUserGameMode) - не дублируем SQL, переиспользуем существующие
// сервисные функции. `state` (WK-53) - явный сигнал фронтенду Companion: для
// "ended" прошлую сессию нельзя предлагать "продолжить", только "начать
// новую" (см. session-prompt.ts на стороне Companion).
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
        const startRating = await getSessionStartRating(session.id);
        sessionRatingDelta = startRating !== null ? session.rating - startRating : 0;
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
