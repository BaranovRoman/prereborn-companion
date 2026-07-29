import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { AppError } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

export const notFoundHandler = (req: Request, res: Response) => {
    res.status(404).json({
        error: "Маршрут не найден",
        code: "NOT_FOUND",
        requestId: req.requestId,
    });
};

// err.field - имя multer-поля формы (см. upload.single("video")/.single("image")/
// .array("images")), позволяет назвать точный лимит вместо общей фразы.
// Значение для видео берётся из env.maxVideoUploadSizeMb - того же источника,
// что и multer.limits.fileSize в controllers/upload-video.ts, так что текст
// ошибки не может разойтись с реальным лимитом.
const multerErrorMessage = (err: multer.MulterError): string => {
    switch (err.code) {
        case "LIMIT_FILE_SIZE":
            if (err.field === "video") {
                return `Максимальный размер видео — ${env.maxVideoUploadSizeMb} МБ`;
            }
            return "Файл превышает допустимый размер";
        case "LIMIT_FILE_COUNT":
        case "LIMIT_UNEXPECTED_FILE":
            return "Превышено допустимое количество файлов";
        default:
            return "Ошибка при загрузке файла";
    }
};

// Единый обработчик ошибок. Должен быть подключён последним, после routes и 404.
export const errorHandler = (
    err: unknown,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: NextFunction
) => {
    const requestId = req.requestId;

    if (err instanceof AppError) {
        if (err.statusCode >= 500) {
            logger.error(err.message, { requestId, code: err.code });
        }
        return res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
            requestId,
        });
    }

    if (err instanceof multer.MulterError) {
        const statusCode = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(statusCode).json({
            error: multerErrorMessage(err),
            code: `UPLOAD_${err.code}`,
            requestId,
        });
    }

    // body-parser (express.json/urlencoded) ошибки
    const bodyError = err as { type?: string; status?: number };
    if (bodyError?.type === "entity.too.large") {
        return res.status(413).json({
            error: "Тело запроса превышает допустимый размер",
            code: "PAYLOAD_TOO_LARGE",
            requestId,
        });
    }
    if (bodyError?.type === "entity.parse.failed") {
        return res.status(400).json({
            error: "Некорректный формат запроса (JSON)",
            code: "MALFORMED_JSON",
            requestId,
        });
    }

    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error("Unhandled error", { requestId, message, stack });

    res.status(500).json({
        error: "Внутренняя ошибка сервера",
        code: "INTERNAL_ERROR",
        requestId,
    });
};
