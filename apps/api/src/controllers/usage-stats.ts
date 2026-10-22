import { Request, Response } from "express";
import {
    computeUsageStats,
    getPublicUsageStats,
    recordCompanionHeartbeat,
} from "../services/usage-stats-service.js";
import { getCleanupStats } from "../services/pending-cleanup-service.js";
import { logger } from "../utils/logger.js";

// WK-186 - see services/usage-stats-service.ts and
// docs/analytics/companion-usage-stats.md.

// POST /api/stream/companion/heartbeat - authenticated by
// authenticateCompanionSession. The body is intentionally ignored: the
// account id from the token is the only thing recorded.
export const postCompanionHeartbeatController = async (req: Request, res: Response) => {
    const streamUserId = Number(req.streamUserId);
    if (!Number.isSafeInteger(streamUserId) || streamUserId <= 0) {
        return res.status(401).json({ error: "Недействительный companion token" });
    }
    try {
        const recorded = await recordCompanionHeartbeat(streamUserId);
        if (!recorded) {
            return res.status(401).json({ error: "Аккаунт не найден" });
        }
        res.status(204).end();
    } catch (error) {
        logger.error("Companion heartbeat error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

// GET /api/public/usage-stats - aggregates only, no per-account data.
export const getPublicUsageStatsController = async (req: Request, res: Response) => {
    try {
        const stats = await getPublicUsageStats();
        res.set("Cache-Control", "public, max-age=300");
        res.json(stats);
    } catch (error) {
        logger.error("Public usage stats error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.set("Cache-Control", "no-store");
        res.status(503).json({ error: "Статистика временно недоступна" });
    }
};

// GET /api/admin/usage-stats - full internal metrics incl. DAU and the
// 30-day average DAU, computed fresh (admins only).
export const getAdminUsageStatsController = async (req: Request, res: Response) => {
    try {
        res.set("Cache-Control", "no-store");
        // WK-192 - counts of pending / permanently failed post-deletion
        // cleanups (files, Twitch revoke); counts only, no payloads.
        const [stats, dataCleanups] = await Promise.all([computeUsageStats(), getCleanupStats()]);
        res.json({ ...stats, dataCleanups });
    } catch (error) {
        logger.error("Admin usage stats error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
