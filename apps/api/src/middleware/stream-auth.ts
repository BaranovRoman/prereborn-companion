import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Аналог authenticateToken (middleware/auth.ts), но для полностью отдельной
// системы пользователей сервиса стрим-оверлеев: свой секрет, свой payload
// (streamUserId вместо userId/role), пишет только в req.streamUserId - не
// пересекается с req.userId/req.userRole админки.
export const authenticateStreamUser = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Токен не предоставлен" });
    }

    try {
        const decoded = jwt.verify(token, env.streamJwtSecret, {
            algorithms: ["HS256"],
        }) as { streamUserId: string };

        req.streamUserId = decoded.streamUserId;
        next();
    } catch {
        return res.status(401).json({ error: "Недействительный токен" });
    }
};
