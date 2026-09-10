import { Request, Response } from "express";
import { z } from "zod";
import { findStreamUserIdByTwitchChannelId } from "../../services/twitch-integration-service.js";
import { getQuizState, submitAnswer } from "../../services/quiz-round-service.js";
import { logger } from "../../utils/logger.js";

// WK-116 Phase 4 - the Twitch Extension's read path. Same reveal-gating
// guarantee as the Companion/web poll (getQuizState never includes
// correctOptionId/distribution outside "reveal") - the Extension gets
// exactly the same public shape, including interactiveRegions (Companion-
// published geometry, safe to expose - it's coordinates, not a secret).
export const getExtensionQuizStateController = async (req: Request, res: Response) => {
    try {
        const channelId = req.twitchExtension!.channelId;
        const streamUserId = await findStreamUserIdByTwitchChannelId(channelId);
        if (!streamUserId) {
            return res.json({ quiz: null });
        }
        const state = await getQuizState(streamUserId);
        res.json({ quiz: state });
    } catch (error) {
        logger.error("Extension quiz state fetch error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const submitAnswerSchema = z.object({
    roundId: z.string().min(1),
    optionId: z.string().min(1),
    // Client-supplied, cosmetic only (see authenticate-twitch-extension.ts's
    // doc comment) - never trusted for identity or correctness, only for
    // what name the shared TOP 5 shows next to a score that IS trustworthy
    // (server-computed from the JWT-verified viewer id).
    displayName: z.string().min(1).max(64).optional(),
});

// WK-116 Phase 4 - the Twitch Extension's write path. The viewer sends only
// round + selected option intent, exactly per the locked architecture -
// never a correctness claim, never a score. Backend remains the sole
// authority (submitAnswer only ever records the selection; scoring is
// applied later, exactly once, at question->reveal - see
// quiz-round-service.ts). `roundId` is accepted from the client but not
// trusted as "the current round" - submitAnswer itself re-resolves the
// actual active round server-side and rejects a mismatched/stale one via
// "no_active_question", so a client racing a phase transition can't submit
// against a round that already moved on.
export const postExtensionAnswerController = async (req: Request, res: Response) => {
    const parsed = submitAnswerSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid_answer", issues: parsed.error.issues });
    }
    try {
        const channelId = req.twitchExtension!.channelId;
        const streamUserId = await findStreamUserIdByTwitchChannelId(channelId);
        if (!streamUserId) {
            return res.status(404).json({ error: "channel_not_linked" });
        }

        const viewerId = req.twitchExtension!.userId ?? `ext:${req.twitchExtension!.opaqueUserId}`;
        const displayName = parsed.data.displayName ?? "Viewer";

        const outcome = await submitAnswer(streamUserId, viewerId, displayName, [parsed.data.optionId]);
        if (!outcome.accepted) {
            return res.status(409).json({ ok: false, reason: outcome.reason });
        }
        res.json({ ok: true });
    } catch (error) {
        logger.error("Extension answer submit error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
