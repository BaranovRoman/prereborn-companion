import { Request, Response } from "express";
import { z } from "zod";
import { acceptTerms, getTermsStatus } from "../../services/terms-acceptance-service.js";
import { logger } from "../../utils/logger.js";

// WK-191 - user agreement acceptance, shared by the site (/account/me/terms)
// and Companion (/companion/terms). req.streamUserId comes from
// authenticateStreamUser or authenticateCompanionSession on the router.

const acceptSchema = z.object({ version: z.string().min(1).max(32) });

const fail = (req: Request, res: Response, what: string, error: unknown) => {
    logger.error(what, {
        requestId: req.requestId,
        message: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
};

export const getTermsStatusController = async (req: Request, res: Response) => {
    try {
        const status = await getTermsStatus(req.streamUserId as string);
        if (!status) return res.status(404).json({ error: "Пользователь не найден" });
        res.json(status);
    } catch (error) {
        fail(req, res, "Stream terms status error", error);
    }
};

export const acceptTermsController = async (req: Request, res: Response) => {
    try {
        const { version } = acceptSchema.parse(req.body);
        const result = await acceptTerms(req.streamUserId as string, version);
        if (result === "not_found") return res.status(404).json({ error: "Пользователь не найден" });
        if (result === "stale_version") {
            return res.status(409).json({ error: "Соглашение обновилось. Откройте его ещё раз и примите действующую редакцию." });
        }
        logger.info("Stream terms accepted", { streamUserId: req.streamUserId, version, via: req.baseUrl });
        res.json(await getTermsStatus(req.streamUserId as string));
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
        fail(req, res, "Stream terms accept error", error);
    }
};
