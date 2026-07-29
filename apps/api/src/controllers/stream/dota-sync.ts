import { Request, Response } from "express";
import { syncRecentMatches } from "../../services/dota-sync-service.js";
import { logger } from "../../utils/logger.js";

// Тот же syncRecentMatches, что и фоновый триггер из getOverlayController -
// один и тот же cooldown/in-flight lock, поэтому кнопка "Синхронизировать
// сейчас" физически не может обойти ограничение или запустить параллельный
// sync с фоновым.
export const syncDotaController = async (req: Request, res: Response) => {
    try {
        const result = await syncRecentMatches(req.streamUserId as string);
        res.json(result);
    } catch (error) {
        logger.error("Dota sync endpoint error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
