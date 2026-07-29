import { Request, Response } from "express";
import { z } from "zod";
import {
    findStreamUserById,
    regeneratePublicToken,
    regenerateCompanionToken,
    setGameMode,
} from "../../services/stream-user-service.js";
import { logger } from "../../utils/logger.js";
import { env } from "../../config/env.js";

// req.streamUserId гарантирован middleware authenticateStreamUser,
// подключённым в routes/stream/account.ts перед этими контроллерами.

export const getMeController = async (req: Request, res: Response) => {
    try {
        const user = await findStreamUserById(req.streamUserId as string);
        if (!user) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }
        res.json(user);
    } catch (error) {
        logger.error("Stream get me error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const gameModeSchema = z.object({
    gameMode: z.enum(["ranked", "unranked"]),
});

// Меняет ТОЛЬКО текущую настройку режима - не трогает stream_matches ни
// stream_sessions (см. задачу: "переключение не переписывает старые
// матчи"). Следующий финализируемый GSI-матч (stream-match-service.ts)
// прочитает новое значение.
export const patchGameModeController = async (req: Request, res: Response) => {
    try {
        const { gameMode } = gameModeSchema.parse(req.body);
        const user = await setGameMode(req.streamUserId as string, gameMode);
        if (!user) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }
        res.json(user);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Stream patch game mode error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const regenerateTokenController = async (
    req: Request,
    res: Response
) => {
    try {
        const user = await regeneratePublicToken(req.streamUserId as string);
        if (!user) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }
        res.json(user);
    } catch (error) {
        logger.error("Stream regenerate token error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// Единственное место, где сырой companion-токен покидает сервер - ответ
// никогда не логируется (см. request-logger.ts - тела ответов не пишутся
// в лог в принципе) и не сохраняется нигде, кроме этого HTTP-ответа. Сам
// токен (result.token) не должен попадать ни в один из logger.* вызовов
// ниже - только факт создания/регенерации и метаданные (was configured?).
export const regenerateCompanionTokenController = async (
    req: Request,
    res: Response
) => {
    try {
        const wasConfigured = Boolean(
            (await findStreamUserById(req.streamUserId as string))
                ?.companionTokenConfigured
        );

        const result = await regenerateCompanionToken(req.streamUserId as string);
        if (!result) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        logger.info(
            wasConfigured
                ? "Companion token regenerated"
                : "Companion token created",
            { requestId: req.requestId, streamUserId: req.streamUserId }
        );

        res.json({
            token: result.token,
            companionTokenCreatedAt: result.user.companionTokenCreatedAt,
        });
    } catch (error) {
        // В development выводим достаточно деталей, чтобы не гадать вслепую
        // (см. задачу: "не маскируй ошибку общим сообщением") - status code
        // здесь всегда 500 (иначе исключение не попало бы в этот catch),
        // response body - то, что видит фронтенд ниже; message/code/detail/
        // stack - для консоли/серверных логов. В production наружу уходит
        // только generic-сообщение, детали остаются только в серверных логах.
        const pgError = error as {
            code?: string;
            detail?: string;
            stack?: string;
        };
        logger.error("Stream regenerate companion token error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
            code: pgError?.code,
            detail: pgError?.detail,
            stack: pgError?.stack,
        });

        const body: { error: string; details?: unknown } = {
            error: "Внутренняя ошибка сервера",
        };
        if (!env.isProduction) {
            body.details = {
                message: error instanceof Error ? error.message : String(error),
                code: pgError?.code ?? null,
                detail: pgError?.detail ?? null,
            };
        }
        res.status(500).json(body);
    }
};
