import { Request, Response } from "express";
import { z } from "zod";
import { upsertCompanionState } from "../../services/stream-companion-service.js";
import { processGsiPayloadForMatch } from "../../services/stream-match-service.js";
import { logger } from "../../utils/logger.js";
import { getTwitchChatStatus } from "../../services/twitch-integration-service.js";

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
