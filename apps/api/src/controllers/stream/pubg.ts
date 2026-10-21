import { Request, Response } from "express";
import { z } from "zod";
import { getPubgMatches, MAX_MATCHES, PUBG_PLATFORMS } from "../../services/pubg-match-service.js";
import { logger } from "../../utils/logger.js";

// WK-183 - recent matches for the installed PUBG plugin. Discriminated
// `status` instead of HTTP error codes (same pattern as opendota.ts): the
// plugin renders "not configured"/"player not found"/"try later" without
// treating each case as a transport failure.
const querySchema = z.object({
    platform: z.enum(PUBG_PLATFORMS),
    // PUBG nicknames: latin letters, digits, "_" and "-".
    player: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/),
    limit: z.coerce.number().int().min(1).max(MAX_MATCHES).default(MAX_MATCHES),
});

export const getPubgMatchesController = async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: "Некорректный ник или платформа" });
    }
    const { platform, player, limit } = parsed.data;
    try {
        return res.json(await getPubgMatches(platform, player, limit));
    } catch (error) {
        logger.error("PUBG matches failed", { requestId: req.requestId, error });
        return res.json({ status: "unavailable" });
    }
};
