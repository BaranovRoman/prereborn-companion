import { Request, Response } from "express";
import { z } from "zod";
import {
    enqueueObsSceneCommand,
    takeObsSceneCommand,
} from "../../services/obs-scene-command-service.js";
import { getOverlayLayout } from "../../services/stream-overlay-layout-service.js";
import { touchCompanionPresence } from "../../services/stream-companion-service.js";
import { logger } from "../../utils/logger.js";

const sceneSchema = z.object({
    scene: z.enum(["betweenMatches", "draft", "gameplay"]),
});

export const postObsTestSceneController = async (req: Request, res: Response) => {
    const parsed = sceneSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Неизвестная сцена OBS" });
    }

    try {
        // Testing the draft scene needs to know WHICH draft protection mode
        // is currently saved, captured at test-trigger time and carried on
        // the override itself - see obs-scene-command-service.ts.
        const draftProtectionMode =
            parsed.data.scene === "draft"
                ? (await getOverlayLayout(req.streamUserId as string)).draftProtection.mode
                : null;

        const command = enqueueObsSceneCommand(
            req.streamUserId as string,
            parsed.data.scene,
            draftProtectionMode
        );
        res.status(202).json(command);
    } catch (error) {
        logger.error("Stream OBS test-scene error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const getCompanionObsCommandController = async (
    req: Request,
    res: Response
) => {
    await touchCompanionPresence(req.streamUserId as string);
    const command = takeObsSceneCommand(req.streamUserId as string);
    if (!command) return res.status(204).send();
    res.json(command);
};
