import { Request, Response } from "express";
import { z } from "zod";
import {
    enqueueObsSceneCommand,
    takeObsSceneCommand,
} from "../../services/obs-scene-command-service.js";

const sceneSchema = z.object({
    scene: z.enum(["betweenMatches", "draft", "gameplay"]),
});

export const postObsTestSceneController = (req: Request, res: Response) => {
    const parsed = sceneSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Неизвестная сцена OBS" });
    }
    const command = enqueueObsSceneCommand(
        req.streamUserId as string,
        parsed.data.scene
    );
    res.status(202).json(command);
};

export const getCompanionObsCommandController = (
    req: Request,
    res: Response
) => {
    const command = takeObsSceneCommand(req.streamUserId as string);
    if (!command) return res.status(204).send();
    res.json(command);
};
