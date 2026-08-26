import { Request, Response } from "express";
import { z } from "zod";
import {
    applyAbsoluteRatingCorrection,
    endActiveSession,
    getLatestSessionForUser,
    getOrCreateActiveSession,
    resetActiveSession,
    updateActiveSession,
} from "../../services/stream-session-service.js";
import { getSessionSummary } from "../../services/stream-session-summary-service.js";
import { logger } from "../../utils/logger.js";

// req.streamUserId гарантирован authenticateStreamUser (routes/stream/account.ts).
// Ни один из этих контроллеров не принимает id сессии от клиента - действие
// всегда применяется к "моей активной/последней сессии", поэтому подменить
// чужую сессию через запрос структурно невозможно (не IDOR - не на что
// подменять).

const patchSessionSchema = z.object({
    rating: z.number().int().positive().nullable().optional(),
    wins: z.number().int().nonnegative().optional(),
    losses: z.number().int().nonnegative().optional(),
    lastHeroId: z.number().int().positive().nullable().optional(),
});

// WK-53 - three-state lifecycle response: "active" (session in progress, see
// `session`), "ended" (most recent session was explicitly ended - `session`
// is that session, `summary` is its itog), "none" (this account has never
// had a stream_sessions row - see getOrCreateActiveSession). The dashboard
// (stream-session-panel.tsx) switches its whole UI on `state`, never guesses
// it from `session` alone.
export const getSessionController = async (req: Request, res: Response) => {
    try {
        const streamUserId = req.streamUserId as string;
        const active = await getOrCreateActiveSession(streamUserId);
        if (active) {
            return res.json({ state: "active", session: active, summary: null });
        }

        const latest = await getLatestSessionForUser(streamUserId);
        if (!latest) {
            return res.json({ state: "none", session: null, summary: null });
        }

        const summary = await getSessionSummary(streamUserId, latest);
        res.json({ state: "ended", session: latest, summary });
    } catch (error) {
        logger.error("Stream get session error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// WK-105 - `rating` в теле - отдельная операция (абсолютная коррекция
// "Текущего MMR", см. applyAbsoluteRatingCorrection), а НЕ ещё одно поле
// среди wins/losses/lastHeroId - см. задачу "ДВЕ РАЗНЫЕ операции". Текущий
// UI (stream-session-panel.tsx) никогда не отправляет rating вместе с
// другими полями в одном PATCH, поэтому здесь это не обрабатывается как
// одновременная комбинация - если rating присутствует, остальные поля этого
// же запроса игнорируются (осознанное упрощение, а не потеря данных: ни один
// существующий вызывающий код так не делает).
export const patchSessionController = async (req: Request, res: Response) => {
    try {
        const patch = patchSessionSchema.parse(req.body);

        if ("rating" in patch) {
            const correction = await applyAbsoluteRatingCorrection(
                req.streamUserId as string,
                patch.rating ?? null
            );
            if (!correction) {
                return res
                    .status(409)
                    .json({ error: "Стрим завершён - нет активной сессии для изменения" });
            }
            return res.json(correction.session);
        }

        const session = await updateActiveSession(
            req.streamUserId as string,
            patch
        );
        if (!session) {
            return res
                .status(409)
                .json({ error: "Стрим завершён - нет активной сессии для изменения" });
        }
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

// "Начать новый стрим" - работает из ЛЮБОГО состояния (active/ended/none):
// resetActiveSession закрывает активную сессию, если она есть (no-op иначе)
// и всегда открывает новую (см. сервис) - тот же самый self-service примитив
// и для "сбросить статистику посреди стрима" (исходный WK-83 UX), и для
// "начать новый стрим после End" - см. задачу: "не дублируй logic".
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

// WK-53 - self-service "Завершить стрим": закрывает активную сессию БЕЗ
// открытия новой (переиспользует ровно тот же endActiveSession, что и
// admin-only POST /admin/users/:id/session/end - см. задачу: "не дублируй
// session-ending logic"). Идемпотентно: повторный вызов (double-click, или
// клик после уже завершённого стрима) не находит активной сессии
// (endActiveSession возвращает null), тогда просто возвращает summary уже
// завершённой последней сессии вместо ошибки - тот же ответ, что и в первый
// раз, без побочных эффектов. 409 - только если у аккаунта вообще никогда не
// было ни одной сессии (нечего завершать).
export const endSessionController = async (req: Request, res: Response) => {
    try {
        const streamUserId = req.streamUserId as string;
        const ended = await endActiveSession(streamUserId);
        const latest = ended ?? (await getLatestSessionForUser(streamUserId));
        if (!latest) {
            return res.status(409).json({ error: "Нет сессии для завершения" });
        }

        const summary = await getSessionSummary(streamUserId, latest);
        logger.info("Stream session ended (self-service)", {
            requestId: req.requestId,
            streamUserId,
            sessionId: latest.id,
            alreadyEnded: ended === null,
        });
        res.json({ session: latest, summary });
    } catch (error) {
        logger.error("Stream end session error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
