import { Router } from "express";
import { authenticateStreamUser } from "../../middleware/stream-auth.js";
import { requireAdmin } from "../../middleware/require-admin.js";
import { getAdminUsageStatsController } from "../../controllers/usage-stats.js";

// WK-186 - internal usage metrics (DAU, 30-day average DAU, ...), same
// admin allowlist as /api/admin/users.
export const adminUsageStatsRouter = Router();

adminUsageStatsRouter.use(authenticateStreamUser, requireAdmin);
adminUsageStatsRouter.get("/", getAdminUsageStatsController);
