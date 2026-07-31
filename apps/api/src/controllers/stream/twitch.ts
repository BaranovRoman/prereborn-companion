import { Request, Response } from "express";
import { z } from "zod";
import {
    consumeTwitchState,
    createTwitchState,
    disconnectTwitch,
    exchangeTwitchCode,
    getTwitchConfig,
    getTwitchStatus,
    getTwitchUser,
    saveTwitchLink,
    TwitchAccountAlreadyLinkedError,
} from "../../services/twitch-integration-service.js";
import { logger } from "../../utils/logger.js";

export const getTwitchStatusController = async (req: Request, res: Response) => {
    try {
        res.json(await getTwitchStatus(req.streamUserId as string));
    } catch (error) {
        logger.error("Twitch status error", { message: error instanceof Error ? error.message : String(error) });
        res.status(502).json({ error: "Не удалось получить данные Twitch" });
    }
};

export const connectTwitchController = async (req: Request, res: Response) => {
    const config = getTwitchConfig();
    if (!config) return res.status(503).json({ error: "Twitch-интеграция не настроена на сервере" });
    const state = await createTwitchState(req.streamUserId as string);
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    // No privileged Helix endpoint is used: an empty scope is sufficient to
    // identify the consenting account while keeping requested access minimal.
    url.searchParams.set("scope", "");
    url.searchParams.set("state", state);
    url.searchParams.set(
        "scope",
        "chat:read channel:read:subscriptions moderator:read:followers"
    );
    url.searchParams.set("force_verify", "true");
    res.json({ redirectUrl: url.toString() });
};

const callbackSchema = z.discriminatedUnion("result", [
    z.object({
        result: z.literal("success"),
        code: z.string().min(1),
        state: z.string().min(1),
    }),
    z.object({
        result: z.literal("error"),
        error: z.string().min(1),
        state: z.string().min(1),
    }),
]);

export const twitchCallbackController = async (req: Request, res: Response) => {
    const config = getTwitchConfig();
    if (!config) return res.status(503).send("Twitch integration is not configured");
    const redirect = (status: string, reason?: string) => {
        const url = new URL("/stream", config.frontendOrigin);
        url.searchParams.set("twitch", status);
        if (reason) url.searchParams.set("reason", reason);
        res.redirect(url.toString());
    };
    try {
        const callback = "error" in req.query
            ? { result: "error" as const, error: req.query.error, state: req.query.state }
            : { result: "success" as const, code: req.query.code, state: req.query.state };
        const parsed = callbackSchema.safeParse(callback);
        if (!parsed.success) return redirect("error", "invalid_callback");
        const streamUserId = await consumeTwitchState(parsed.data.state);
        if (!streamUserId) return redirect("error", "invalid_state");
        if (parsed.data.result === "error") {
            return redirect(
                "error",
                parsed.data.error === "access_denied" ? "access_denied" : "oauth_error"
            );
        }
        const token = await exchangeTwitchCode(parsed.data.code);
        const user = await getTwitchUser(token.access_token);
        await saveTwitchLink(streamUserId, user, token);
        redirect("connected");
    } catch (error) {
        if (error instanceof TwitchAccountAlreadyLinkedError) {
            return redirect("error", "already_linked");
        }
        logger.error("Twitch callback error", { message: error instanceof Error ? error.message : String(error) });
        redirect("error", "internal");
    }
};

export const disconnectTwitchController = async (req: Request, res: Response) => {
    await disconnectTwitch(req.streamUserId as string);
    res.status(204).send();
};
