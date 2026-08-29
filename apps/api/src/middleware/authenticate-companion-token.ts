import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
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

// WK-122 - Companion Token UX audit (§7): a raw opaque secret the user had
// to copy from the website and paste into Companion is a real desktop-auth
// gap. Rather than inventing a new scheme, Companion can now instead log in
// with the SAME email/password → access/refresh-token session the website
// itself already uses (`/stream/auth/login`, `authenticateStreamUser`) -
// see apps/companion/src-tauri/src/backend/mod.rs's session refresher. This
// middleware is what lets that session's short-lived JWT access token work
// on the exact same companion-scoped routes the legacy static token already
// authorizes, with ZERO changes to those routes or their controllers:
// req.streamUserId ends up identical either way. JWT is tried first (cheap,
// no DB round-trip); a token that isn't a valid JWT at all (the legacy
// token's shape - `crypto.randomBytes(32).toString("base64url")`, never
// base64url-decodes into three dot-separated JWT segments) falls through to
// the existing hash-lookup unchanged - so every already-token-authenticated
// Companion install keeps working verbatim, with no forced migration and no
// server-side change to how that legacy token is stored or verified.
export const authenticateCompanionSession = async (
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
        const decoded = jwt.verify(token, env.streamJwtSecret, {
            algorithms: ["HS256"],
        }) as { streamUserId: string };
        req.streamUserId = decoded.streamUserId;
        return next();
    } catch {
        // Not a valid session JWT (or none was ever issued for this
        // install) - fall through to the legacy companion-token path below,
        // never treated as a hard failure on its own.
    }

    return authenticateCompanionToken(req, res, next);
};
