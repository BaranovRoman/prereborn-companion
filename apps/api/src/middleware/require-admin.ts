import { Request, Response, NextFunction } from "express";
import { findStreamUserById } from "../services/stream-user-service.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

// WK-189 - one definition of "administrator" for both the guard below and
// GET /account/me's isAdmin flag (which only decides whether the site shows
// the /admin link - the guard is what actually protects the data).
export const isAdminEmail = (email: string): boolean =>
    env.adminEmails.includes(email.trim().toLowerCase());

// Должен идти ПОСЛЕ authenticateStreamUser (нужен req.streamUserId). Нет
// отдельной роли/таблицы - администратор определяется allowlist'ом email
// в env.adminEmails (см. config/env.ts). Обычный аутентифицированный
// пользователь получает 403, а не редирект/пустой список - скрывать сам
// факт существования admin-API не входит в задачу.
export const requireAdmin = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const user = await findStreamUserById(req.streamUserId as string);
        if (!user || !isAdminEmail(user.email)) {
            return res.status(403).json({ error: "Доступ запрещён" });
        }
        next();
    } catch (error) {
        logger.error("Require admin check error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
