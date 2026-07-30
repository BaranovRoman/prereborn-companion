import { Request, Response } from "express";
import { z } from "zod";
import {
    consumeDonationAlertsState, createDonationAlertsState, disconnectDonationAlerts,
    DONATION_ALERTS_SCOPES, exchangeDonationAlertsCode, getDonationAlertsConfig,
    getDonationAlertsStatus, getDonationAlertsUser, saveDonationAlertsLink,
} from "../../services/donation-alerts-integration-service.js";
import { logger } from "../../utils/logger.js";

export const getDonationAlertsStatusController = async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await getDonationAlertsStatus(req.streamUserId as string)); }
    catch (error) {
        logger.error("DonationAlerts status error", { message: error instanceof Error ? error.message : String(error) });
        res.status(502).json({ error: "Не удалось получить данные DonationAlerts" });
    }
};

export const connectDonationAlertsController = async (req: Request, res: Response) => {
    const config = getDonationAlertsConfig();
    if (!config) return res.status(503).json({ error: "DonationAlerts не настроен на сервере" });
    const state = await createDonationAlertsState(req.streamUserId as string);
    const url = new URL("https://www.donationalerts.com/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", DONATION_ALERTS_SCOPES);
    url.searchParams.set("state", state);
    res.json({ redirectUrl: url.toString() });
};

const callbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
export const donationAlertsCallbackController = async (req: Request, res: Response) => {
    const config = getDonationAlertsConfig();
    if (!config) return res.status(503).send("DonationAlerts integration is not configured");
    const redirect = (status: string) => {
        const url = new URL("/stream", config.frontendOrigin);
        url.searchParams.set("donationAlerts", status);
        res.redirect(url.toString());
    };
    try {
        const parsed = callbackSchema.safeParse(req.query);
        if (!parsed.success) return redirect("error");
        const streamUserId = await consumeDonationAlertsState(parsed.data.state);
        if (!streamUserId) return redirect("error");
        const token = await exchangeDonationAlertsCode(parsed.data.code);
        const user = await getDonationAlertsUser(token.access_token);
        await saveDonationAlertsLink(streamUserId, user, token);
        redirect("connected");
    } catch (error) {
        logger.error("DonationAlerts callback error", { message: error instanceof Error ? error.message : String(error) });
        redirect("error");
    }
};

export const disconnectDonationAlertsController = async (req: Request, res: Response) => {
    await disconnectDonationAlerts(req.streamUserId as string);
    res.status(204).send();
};
