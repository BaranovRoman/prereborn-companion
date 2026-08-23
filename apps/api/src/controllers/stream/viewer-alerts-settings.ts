import type { Request, Response } from "express";
import {
    getViewerAlertsSettings,
    InvalidViewerAlertsSettingsError,
    saveViewerAlertsSettings,
} from "../../services/stream-viewer-alerts-settings-service.js";
import { logger } from "../../utils/logger.js";

export const getViewerAlertsSettingsController = async (req: Request, res: Response) => {
    try {
        res.json(await getViewerAlertsSettings(req.streamUserId as string));
    } catch (error) {
        logger.error("Stream get viewer alerts settings error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
    }
};

export const putViewerAlertsSettingsController = async (req: Request, res: Response) => {
    try {
        res.json(await saveViewerAlertsSettings(req.streamUserId as string, req.body));
    } catch (error) {
        if (error instanceof InvalidViewerAlertsSettingsError) {
            return res.status(400).json({ error: error.message });
        }
        logger.error("Stream put viewer alerts settings error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
    }
};
