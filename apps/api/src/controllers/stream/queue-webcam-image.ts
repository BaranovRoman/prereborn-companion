import type { Request, RequestHandler, Response } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import {
    createUploadStorage,
    isInsideUploadsDir,
    safeUnlink,
    validateAndFinalizeImage,
} from "../../utils/upload-security.js";
import {
    getQueueSettings,
    saveQueueSettings,
} from "../../services/stream-queue-settings-service.js";
import { logger } from "../../utils/logger.js";

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
    storage: createUploadStorage(uploadsDir),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
        callback(null, /\.(?:jpe?g|png|webp)$/i.test(path.extname(file.originalname)));
    },
});

export const uploadQueueWebcamImageMiddleware: RequestHandler =
    upload.single("image");

const removeStoredImage = async (url: string | null) => {
    if (!url?.startsWith("/uploads/")) return;
    const target = path.join(uploadsDir, path.basename(url));
    if (isInsideUploadsDir(uploadsDir, target)) {
        await safeUnlink(target);
    }
};

export const uploadQueueWebcamImageController = async (
    req: Request,
    res: Response
) => {
    if (!req.file) {
        return res.status(400).json({ error: "Изображение не загружено" });
    }

    try {
        const result = await validateAndFinalizeImage(
            req.file.path,
            uploadsDir,
            "generic"
        );
        if (!result.ok) {
            await safeUnlink(req.file.path);
            return res.status(415).json({ error: "Неподдерживаемое изображение" });
        }

        const streamUserId = req.streamUserId as string;
        const current = await getQueueSettings(streamUserId);
        const webcamImageUrl = `/uploads/${result.finalFilename}`;
        const saved = await saveQueueSettings(streamUserId, { webcamImageUrl });
        await removeStoredImage(current.webcamImageUrl);
        res.json({ webcamImageUrl, settings: saved });
    } catch (error) {
        await safeUnlink(req.file.path);
        logger.error("Queue webcam image upload error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Не удалось сохранить изображение" });
    }
};

export const deleteQueueWebcamImageController = async (
    req: Request,
    res: Response
) => {
    try {
        const streamUserId = req.streamUserId as string;
        const current = await getQueueSettings(streamUserId);
        await saveQueueSettings(streamUserId, { webcamImageUrl: null });
        await removeStoredImage(current.webcamImageUrl);
        res.status(204).end();
    } catch (error) {
        logger.error("Queue webcam image delete error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Не удалось удалить изображение" });
    }
};
