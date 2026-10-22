import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { streamUserExists } from "../services/stream-user-service.js";

// Аналог authenticateToken (middleware/auth.ts), но для полностью отдельной
// системы пользователей сервиса стрим-оверлеев: свой секрет, свой payload
// (streamUserId вместо userId/role), пишет только в req.streamUserId - не
// пересекается с req.userId/req.userRole админки.
export const authenticateStreamUser = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Токен не предоставлен" });
    }

    let streamUserId: string;
    try {
        const decoded = jwt.verify(token, env.streamJwtSecret, {
            algorithms: ["HS256"],
        }) as { streamUserId: string };
        streamUserId = String(decoded.streamUserId);
    } catch {
        return res.status(401).json({ error: "Недействительный токен" });
    }

    // WK-192 - the JWT is still validly signed after the account is
    // deleted; 401 makes every client drop the session (refresh fails too:
    // the refresh tokens were cascaded away with the account).
    try {
        if (!(await streamUserExists(streamUserId))) {
            return res.status(401).json({ error: "Аккаунт не найден" });
        }
    } catch (error) {
        return next(error);
    }

    req.streamUserId = streamUserId;
    next();
};
