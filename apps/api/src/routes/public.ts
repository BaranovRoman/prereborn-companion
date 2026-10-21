import { Router } from "express";
import { publicUsageStatsRateLimiter } from "../middleware/rate-limit.js";
import { getPublicUsageStatsController } from "../controllers/usage-stats.js";

// WK-186 - unauthenticated read-only aggregates for the landing page.
export const publicRouter = Router();

publicRouter.get("/usage-stats", publicUsageStatsRateLimiter, getPublicUsageStatsController);
