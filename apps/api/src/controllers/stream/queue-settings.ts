import type { Request, Response } from "express";
import {
    getQueueSettings,
    InvalidQueueSettingsError,
    saveQueueSettings,
} from "../../services/stream-queue-settings-service.js";
import { logger } from "../../utils/logger.js";

export const getQueueSettingsController = async (req: Request, res: Response) => {
    try {
        res.json(await getQueueSettings(req.streamUserId as string));
    } catch (error) {
        logger.error("Stream get queue settings error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
    }
};

export const putQueueSettingsController = async (req: Request, res: Response) => {
    try {
        res.json(await saveQueueSettings(req.streamUserId as string, req.body));
    } catch (error) {
        if (error instanceof InvalidQueueSettingsError) {
            return res.status(400).json({ error: error.message });
        }
        logger.error("Stream put queue settings error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
    }
};
