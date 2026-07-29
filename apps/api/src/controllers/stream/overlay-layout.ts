import { Request, Response } from "express";
import {
    getOverlayLayout,
    saveOverlayLayout,
    InvalidOverlayLayoutError,
} from "../../services/stream-overlay-layout-service.js";
import { logger } from "../../utils/logger.js";

export const getOverlayLayoutController = async (req: Request, res: Response) => {
    try {
        const layout = await getOverlayLayout(req.streamUserId as string);
        res.json(layout);
    } catch (error) {
        logger.error("Stream get overlay layout error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const putOverlayLayoutController = async (req: Request, res: Response) => {
    try {
        const layout = await saveOverlayLayout(req.streamUserId as string, req.body);
        res.json(layout);
    } catch (error) {
        if (error instanceof InvalidOverlayLayoutError) {
            return res.status(400).json({ error: error.message });
        }
        logger.error("Stream put overlay layout error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
