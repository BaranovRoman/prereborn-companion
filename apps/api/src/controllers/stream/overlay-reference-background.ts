import { Request, Response, RequestHandler } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { z } from "zod";
import {
    createUploadStorage,
    validateAndFinalizeImage,
    safeUnlink,
} from "../../utils/upload-security.js";
import {
    getReferenceBackground,
    saveReferenceBackground,
    setReferenceBackgroundOpacity,
    deleteReferenceBackground,
} from "../../services/stream-overlay-reference-background-service.js";
import { logger } from "../../utils/logger.js";

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = createUploadStorage(uploadsDir);

const ALLOWED_EXTENSIONS = /jpeg|jpg|png|webp/;

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
    },
    fileFilter: (_req, file, cb) => {
        const extname = ALLOWED_EXTENSIONS.test(
            path.extname(file.originalname).toLowerCase()
        );
        cb(null, extname);
    },
});

export const uploadReferenceBackgroundMiddleware: RequestHandler =
    upload.single("image");

const toResponse = (record: {
    filename: string;
    width: number;
    height: number;
    opacity: number;
}) => ({
    url: `/uploads/${record.filename}`,
    fileName: record.filename,
    naturalWidth: record.width,
    naturalHeight: record.height,
    opacity: record.opacity,
});

export const getReferenceBackgroundController = async (
    req: Request,
    res: Response
) => {
    try {
        const record = await getReferenceBackground(req.streamUserId as string);
        res.json(record ? toResponse(record) : null);
    } catch (error) {
        logger.error("Stream get overlay reference background error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const uploadReferenceBackgroundController = async (
    req: Request,
    res: Response
) => {
    if (!req.file) {
        return res.status(400).json({ error: "Файл не загружен" });
    }

    try {
        const result = await validateAndFinalizeImage(
            req.file.path,
            uploadsDir,
            "streamReference"
        );

        if (!result.ok) {
            await safeUnlink(req.file.path);
            return res.status(415).json({
                error: "Файл не является поддерживаемым изображением",
                code: "UNSUPPORTED_FILE_TYPE",
                requestId: req.requestId,
            });
        }

        const record = await saveReferenceBackground(
            req.streamUserId as string,
            uploadsDir,
            {
                filename: result.finalFilename,
                width: result.width,
                height: result.height,
            }
        );

        res.json(toResponse(record));
    } catch (error) {
        await safeUnlink(req.file.path);
        logger.error("Stream upload overlay reference background error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const opacityBodySchema = z.object({
    opacity: z.number().min(0).max(1),
});

export const patchReferenceBackgroundOpacityController = async (
    req: Request,
    res: Response
) => {
    try {
        const { opacity } = opacityBodySchema.parse(req.body);
        const record = await setReferenceBackgroundOpacity(
            req.streamUserId as string,
            opacity
        );
        if (!record) {
            return res.status(404).json({ error: "Референс не найден" });
        }
        res.json(toResponse(record));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Некорректное значение прозрачности" });
        }
        logger.error("Stream patch overlay reference background opacity error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const deleteReferenceBackgroundController = async (
    req: Request,
    res: Response
) => {
    try {
        await deleteReferenceBackground(req.streamUserId as string, uploadsDir);
        res.status(204).end();
    } catch (error) {
        logger.error("Stream delete overlay reference background error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
