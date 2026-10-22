import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

// WK-196 - публичный токен оверлея действует до перевыпуска, в логах ему не
// место (то же маскирование делает nginx, см. deploy/nginx/prereborn-logging.conf).
// Query string сюда не попадает: req.path её не содержит.
const OVERLAY_TOKEN_PATH = /^(\/(?:api\/stream\/)?overlay\/)[^/]+/;

export const maskLogPath = (path: string): string =>
    path.replace(OVERLAY_TOKEN_PATH, "$1[token]");

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
            path: maskLogPath(req.path),
            status: res.statusCode,
            durationMs: Date.now() - start,
        });
    });

    next();
};
