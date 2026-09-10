import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// WK-116 Phase 4 - verifies the JWT Twitch's Extension Helper hands the
// Extension frontend via `onAuthorized` (and which the frontend forwards on
// every request to us, same Bearer-header convention as
// authenticateStreamUser). Genuinely new auth mechanism, not reusable from
// stream-auth.ts: a different signing secret (the Extension's own, base64-
// encoded, from the Twitch Developer Console - NOT streamJwtSecret, which
// signs OUR OWN tokens for OUR OWN users), a different payload shape (
// Twitch's own contract: channel_id/opaque_user_id/user_id/role), and a
// trust boundary that is Twitch's, not ours - we only ever verify a
// signature Twitch produced, never issue this kind of token ourselves.
//
// `user_id` (a real numeric Twitch id) is present ONLY when the viewer
// explicitly shared identity with the Extension; `opaque_user_id` (an
// Extension-scoped pseudonymous id, stable per viewer per extension) is
// ALWAYS present. Scoring/leaderboard keys on whichever is available -
// preferring the real id when shared, since that's what the "TOP 5" ever
// shows a recognizable name for; the opaque id still lets an anonymous
// viewer answer and score correctly, just without a friendly display name
// (the frontend sends a client-supplied label in that case - cosmetic only,
// never trusted for identity/correctness, see controllers/stream/extension.ts).
interface TwitchExtensionJwtPayload {
    channel_id: string;
    opaque_user_id: string;
    user_id?: string;
    role: "viewer" | "broadcaster" | "moderator" | "external";
    exp: number;
}

export const authenticateTwitchExtension = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (!env.twitchExtensionSecret) {
        // Not configured yet (pre-Twitch-registration) - see the Phase 4
        // delivery report's external-gate instructions. 503, not 500/401:
        // this is a "the feature isn't turned on server-side", not a
        // client auth failure or an internal bug.
        return res.status(503).json({ error: "twitch_extension_not_configured" });
    }

    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ error: "Токен не предоставлен" });
    }

    try {
        const secretKey = Buffer.from(env.twitchExtensionSecret, "base64");
        const decoded = jwt.verify(token, secretKey, {
            algorithms: ["HS256"],
        }) as TwitchExtensionJwtPayload;

        req.twitchExtension = {
            channelId: decoded.channel_id,
            opaqueUserId: decoded.opaque_user_id,
            userId: decoded.user_id ?? null,
            role: decoded.role,
        };
        next();
    } catch {
        return res.status(401).json({ error: "Недействительный токен" });
    }
};
