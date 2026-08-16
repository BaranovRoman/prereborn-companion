import { Request, Response } from "express";
import { z } from "zod";
import {
    listAdminUsers,
    getAdminUserDetail,
} from "../../services/admin-user-service.js";
import {
    endActiveSession,
} from "../../services/stream-session-service.js";
import { resetOnboarding } from "../../services/stream-user-service.js";
import { logger } from "../../utils/logger.js";

// req.streamUserId гарантирован authenticateStreamUser, admin-статус -
// requireAdmin, оба подключены в routes/admin/users.ts перед этими
// контроллерами.

const listQuerySchema = z.object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().optional(),
    q: z.string().optional(),
});

export const listUsersController = async (req: Request, res: Response) => {
    try {
        const { page, pageSize, q } = listQuerySchema.parse(req.query);
        const result = await listAdminUsers({ page, pageSize, query: q });
        res.json(result);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Admin list users error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// Явный маппинг вместо res.json(detail) - чтобы состав ответа не менялся
// молча, если в StreamUser/SteamLink когда-нибудь добавится новое поле
// (например секрет) в одном из вложенных сервисов.
export const getUserController = async (req: Request, res: Response) => {
    try {
        const detail = await getAdminUserDetail(req.params.id);
        if (!detail) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        res.json({
            id: detail.user.id,
            email: detail.user.email,
            createdAt: detail.user.createdAt,
            onboardingCompletedAt: detail.user.onboardingCompletedAt,
            gameMode: detail.user.gameMode,
            companionTokenConfigured: detail.user.companionTokenConfigured,
            companionTokenCreatedAt: detail.user.companionTokenCreatedAt,
            steam: detail.steam,
            twitch: detail.twitch,
            companion: {
                online: detail.companion.online,
                lastSeenAt: detail.companion.lastSeenAt,
                lastGsiReceivedAt: detail.companion.lastGsiState?.receivedAt ?? null,
                companionVersion:
                    detail.companion.lastGsiState?.companionVersion ?? null,
            },
            latestSession: detail.latestSession,
        });
    } catch (error) {
        logger.error("Admin get user error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// Закрывает зависшую активную сессию (без открытия новой - см. комментарий
// у endActiveSession). Логируем как admin-действие над чужим аккаунтом
// (единственное место в кодовой базе, где actor != target) - минимальный
// audit trail без отдельной таблицы.
export const endSessionController = async (req: Request, res: Response) => {
    try {
        const session = await endActiveSession(req.params.id);
        if (!session) {
            return res
                .status(409)
                .json({ error: "У пользователя нет активной сессии" });
        }

        logger.info("Admin ended active session", {
            requestId: req.requestId,
            adminStreamUserId: req.streamUserId,
            targetStreamUserId: req.params.id,
            sessionId: session.id,
        });

        res.json(session);
    } catch (error) {
        logger.error("Admin end session error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const resetOnboardingController = async (
    req: Request,
    res: Response
) => {
    try {
        const user = await resetOnboarding(req.params.id);
        if (!user) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        logger.info("Admin reset onboarding", {
            requestId: req.requestId,
            adminStreamUserId: req.streamUserId,
            targetStreamUserId: req.params.id,
        });

        res.json({
            id: user.id,
            onboardingCompletedAt: user.onboardingCompletedAt,
        });
    } catch (error) {
        logger.error("Admin reset onboarding error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
