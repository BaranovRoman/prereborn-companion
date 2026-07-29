import { Request, Response } from "express";
import { z } from "zod";
import {
    getOrCreateActiveSession,
    resetActiveSession,
    updateActiveSession,
} from "../../services/stream-session-service.js";
import { logger } from "../../utils/logger.js";

// req.streamUserId гарантирован authenticateStreamUser (routes/stream/account.ts).
// Ни один из этих контроллеров не принимает id сессии от клиента - действие
// всегда применяется к "моей активной сессии", поэтому подменить чужую
// сессию через запрос структурно невозможно (не IDOR - не на что подменять).

const patchSessionSchema = z.object({
    rating: z.number().int().positive().nullable().optional(),
    wins: z.number().int().nonnegative().optional(),
    losses: z.number().int().nonnegative().optional(),
    lastHeroId: z.number().int().positive().nullable().optional(),
});

export const getSessionController = async (req: Request, res: Response) => {
    try {
        const session = await getOrCreateActiveSession(
            req.streamUserId as string
        );
        res.json(session);
    } catch (error) {
        logger.error("Stream get session error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const patchSessionController = async (req: Request, res: Response) => {
    try {
        const patch = patchSessionSchema.parse(req.body);
        const session = await updateActiveSession(
            req.streamUserId as string,
            patch
        );
        res.json(session);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Stream patch session error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const resetSessionController = async (req: Request, res: Response) => {
    try {
        const session = await resetActiveSession(req.streamUserId as string);
        res.json(session);
    } catch (error) {
        logger.error("Stream reset session error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
