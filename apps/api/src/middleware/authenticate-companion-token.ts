import { Request, Response, NextFunction } from "express";
import { findStreamUserIdByCompanionToken } from "../services/stream-user-service.js";

// Третья, отдельная схема авторизации сервиса стрим-оверлеев (после JWT
// access-токена и публичного overlay-токена) - companion (apps/dota-companion)
// не проходит login-флоу, у него один статический секрет, вставленный
// пользователем один раз в настройках /stream. Токен передаётся так же,
// как JWT (Authorization: Bearer <token>), но проверяется поиском по
// sha256-хэшу в БД (services/stream-user-service.ts), а не verify подписи -
// это не JWT. req.streamUserId используется тот же, что и у
// authenticateStreamUser: downstream-коду (контроллерам) неважно, каким
// способом был установлен streamUserId.
export const authenticateCompanionToken = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Companion token не предоставлен" });
    }

    try {
        const streamUserId = await findStreamUserIdByCompanionToken(token);
        if (!streamUserId) {
            return res.status(401).json({ error: "Недействительный companion token" });
        }
        req.streamUserId = streamUserId;
        next();
    } catch {
        return res.status(401).json({ error: "Недействительный companion token" });
    }
};
