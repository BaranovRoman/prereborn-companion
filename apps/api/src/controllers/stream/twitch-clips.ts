import { Request, Response } from "express";
import { z } from "zod";
import {
    CLIP_DURATION_MAX_SECONDS,
    CLIP_DURATION_MIN_SECONDS,
    createTwitchClip,
    getTwitchClipsAccess,
    type ClipErrorCode,
} from "../../services/twitch-clips-service.js";
import { logger } from "../../utils/logger.js";

// WK-178 - Companion clip hotkey. Errors always carry a stable `code` next to
// the human-readable `error`, so Companion can branch (e.g. offer re-auth)
// without parsing text.
const STATUS_BY_CODE: Record<ClipErrorCode, number> = {
    not_configured: 503,
    not_connected: 409,
    reauth_required: 403,
    not_live: 409,
    clips_restricted: 403,
    clip_rejected: 422,
    rate_limited: 429,
    twitch_unavailable: 502,
    clip_failed: 502,
};

const createClipSchema = z.object({
    durationSeconds: z.number().min(CLIP_DURATION_MIN_SECONDS).max(CLIP_DURATION_MAX_SECONDS).optional(),
});

export const postCompanionTwitchClipController = async (req: Request, res: Response) => {
    const parsed = createClipSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ code: "invalid_request", error: "Некорректная длительность клипа" });
    }
    try {
        const result = await createTwitchClip(req.streamUserId as string, parsed.data.durationSeconds);
        if (result.ok) return res.status(201).json({ clip: result.clip });
        res.status(STATUS_BY_CODE[result.code]).json({ code: result.code, error: result.message });
    } catch (error) {
        logger.error("Companion Twitch clip error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ code: "internal", error: "Внутренняя ошибка сервера" });
    }
};

export const getCompanionTwitchClipsAccessController = async (req: Request, res: Response) => {
    try {
        res.json(await getTwitchClipsAccess(req.streamUserId as string));
    } catch (error) {
        logger.error("Companion Twitch clips access error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(502).json({ error: "Не удалось проверить доступ к клипам Twitch" });
    }
};
