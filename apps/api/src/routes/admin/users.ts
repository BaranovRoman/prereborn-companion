import { Router } from "express";
import { authenticateStreamUser } from "../../middleware/stream-auth.js";
import { requireAdmin } from "../../middleware/require-admin.js";
import {
    listUsersController,
    getUserController,
    endSessionController,
    resetOnboardingController,
} from "../../controllers/admin/users.js";

export const adminUsersRouter = Router();

// Тот же JWT, что и /api/stream/* (authenticateStreamUser) - admin не
// отдельная система входа, requireAdmin поверх неё сужает круг до
// allowlist'а email (см. config/env.ts).
adminUsersRouter.use(authenticateStreamUser, requireAdmin);

adminUsersRouter.get("/", listUsersController);
adminUsersRouter.get("/:id", getUserController);
adminUsersRouter.post("/:id/session/end", endSessionController);
adminUsersRouter.post("/:id/onboarding/reset", resetOnboardingController);
