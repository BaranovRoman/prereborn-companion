import { Request, Response } from "express";
import { z } from "zod";
import { getQuizState, publishInteractiveRegions } from "../../services/quiz-round-service.js";
import { logger } from "../../utils/logger.js";

// WK-116 - Companion's poll counterpart to poll_obs_command (backend/mod.rs)
// - see the plan's Phase 1 transport decision: a short-interval poll of a
// DB-backed endpoint, not a push channel, since Companion has no publicly
// reachable inbound endpoint for the backend to push to. Returns null (not
// a 404) when there's no active round - "not in Between Matches right now"
// is a normal, expected response shape, not an error.
export const getCompanionQuizStateController = async (req: Request, res: Response) => {
    try {
        const streamUserId = req.streamUserId as string;
        const state = await getQuizState(streamUserId);
        res.json({ quiz: state });
    } catch (error) {
        logger.error("Companion quiz state fetch error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const interactiveRegionSchema = z.object({
    id: z.string().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
    value: z.string().min(1),
});

const publishGeometrySchema = z.object({
    roundId: z.string().min(1),
    // Generic list, not a fixed 4-tuple - see quiz-round-service.ts's
    // InteractiveRegion doc comment; v1 always sends exactly 4, but nothing
    // here enforces that number specifically.
    interactiveRegions: z.array(interactiveRegionSchema).min(1).max(16),
});

// Companion measures its own rendered answer-button DOM rects and reports
// them here once per round (see the Phase 0 placement review's "Companion
// is the producer, not the Extension" decision) - the Extension will read
// these back via the quiz state it's served (Phase 4), never recomputing
// Companion's layout independently.
export const putCompanionQuizGeometryController = async (req: Request, res: Response) => {
    const parsed = publishGeometrySchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid_geometry", issues: parsed.error.issues });
    }
    try {
        const streamUserId = req.streamUserId as string;
        const applied = await publishInteractiveRegions(
            streamUserId,
            parsed.data.roundId,
            parsed.data.interactiveRegions
        );
        // A stale roundId (the round already ended/was cancelled by the
        // time this arrived) is a normal race, not an error - `applied:
        // false` lets Companion log it quietly instead of retrying forever.
        res.json({ ok: true, applied });
    } catch (error) {
        logger.error("Companion quiz geometry publish error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
