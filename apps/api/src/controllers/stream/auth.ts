import { Request, Response } from "express";
import { z } from "zod";
import {
    createStreamUser,
    emailExists,
    issueRefreshToken,
    rotateRefreshToken,
    revokeRefreshToken,
    signAccessToken,
    verifyStreamUserCredentials,
} from "../../services/stream-user-service.js";
import { logger } from "../../utils/logger.js";

const registerSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(200),
});

const loginSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
});

const refreshSchema = z.object({
    refreshToken: z.string().min(1),
});

export const registerController = async (req: Request, res: Response) => {
    try {
        const { email, password } = registerSchema.parse(req.body);

        if (await emailExists(email)) {
            return res.status(409).json({ error: "Этот email уже занят" });
        }

        const user = await createStreamUser(email, password);
        const accessToken = signAccessToken(user.id);
        const refreshToken = await issueRefreshToken(user.id);

        res.status(201).json({ user, accessToken, refreshToken });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Stream register error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const loginController = async (req: Request, res: Response) => {
    try {
        const { email, password } = loginSchema.parse(req.body);

        const user = await verifyStreamUserCredentials(email, password);
        if (!user) {
            return res.status(401).json({ error: "Неверный email или пароль" });
        }

        const accessToken = signAccessToken(user.id);
        const refreshToken = await issueRefreshToken(user.id);

        res.json({ user, accessToken, refreshToken });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Stream login error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const refreshController = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = refreshSchema.parse(req.body);

        const rotated = await rotateRefreshToken(refreshToken);
        if (!rotated) {
            return res
                .status(401)
                .json({ error: "Недействительный или истёкший refresh-токен" });
        }

        const accessToken = signAccessToken(rotated.streamUserId);
        res.json({ accessToken, refreshToken: rotated.refreshToken });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Stream refresh error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

export const logoutController = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = refreshSchema.parse(req.body);
        await revokeRefreshToken(refreshToken);
        res.status(204).send();
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        logger.error("Stream logout error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
