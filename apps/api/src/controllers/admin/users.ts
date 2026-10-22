import { Request, Response } from "express";
import { z } from "zod";
import {
    ADMIN_USER_SORTS,
    listAdminUsers,
    getAdminUserDetail,
    type AdminUserSort,
} from "../../services/admin-user-service.js";
import {
    endActiveSession,
} from "../../services/stream-session-service.js";
import { findStreamUserById, resetOnboarding } from "../../services/stream-user-service.js";
import { deleteStreamUserAccount } from "../../services/account-deletion-service.js";
import { logger } from "../../utils/logger.js";

// req.streamUserId гарантирован authenticateStreamUser, admin-статус -
// requireAdmin, оба подключены в routes/admin/users.ts перед этими
// контроллерами.

const listQuerySchema = z.object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().optional(),
    q: z.string().optional(),
    sort: z
        .enum(Object.keys(ADMIN_USER_SORTS) as [AdminUserSort, ...AdminUserSort[]])
        .optional(),
});

export const listUsersController = async (req: Request, res: Response) => {
    try {
        const { page, pageSize, q, sort } = listQuerySchema.parse(req.query);
        const result = await listAdminUsers({ page, pageSize, query: q, sort });
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

const adminDeleteSchema = z.object({ confirmEmail: z.string().min(1).max(320) });

// WK-192 - executes a deletion request that came in by email, without SQL.
// An admin can't delete their own account here (that goes through /account
// with a password). The body must repeat the target's email - a guard
// against deleting the wrong id, not an auth factor. The log line carries
// ids only.
export const deleteUserController = async (req: Request, res: Response) => {
    if (!/^\d{1,10}$/.test(req.params.id)) {
        return res.status(404).json({ error: "Пользователь не найден" });
    }
    const targetId = String(Number(req.params.id));
    try {
        if (targetId === req.streamUserId) {
            return res.status(403).json({ error: "Нельзя удалить собственный аккаунт из админки" });
        }
        const parsed = adminDeleteSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Укажите email удаляемого пользователя" });
        }
        const target = await findStreamUserById(targetId);
        if (!target) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }
        if (target.email.toLowerCase() !== parsed.data.confirmEmail.trim().toLowerCase()) {
            return res.status(400).json({ error: "Email не совпадает" });
        }

        const deleted = await deleteStreamUserAccount(targetId);
        if (!deleted) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }
        logger.info("Stream account deleted", {
            requestId: req.requestId,
            streamUserId: targetId,
            initiatedBy: "admin",
            adminStreamUserId: req.streamUserId,
        });
        res.status(204).end();
    } catch (error) {
        logger.error("Admin delete user error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
