import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

// Не логируем тела запросов/ответов (могут содержать пароли, токены, контент
// CMS) — только метаданные, достаточные для диагностики и корреляции с
// requestId.
export const requestLogger = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const start = Date.now();

    res.on("finish", () => {
        const level = res.statusCode >= 500 ? "error" : "debug";
        logger[level]("request", {
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - start,
        });
    });

    next();
};
