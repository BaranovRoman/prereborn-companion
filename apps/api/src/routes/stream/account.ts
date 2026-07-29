import { Router } from "express";
import {
    getMeController,
    regenerateTokenController,
    regenerateCompanionTokenController,
    patchGameModeController,
} from "../../controllers/stream/account.js";
import {
    getSessionController,
    patchSessionController,
    resetSessionController,
} from "../../controllers/stream/session.js";
import {
    getMatchesController,
    patchMatchController,
} from "../../controllers/stream/matches.js";
import {
    getOverlayLayoutController,
    putOverlayLayoutController,
} from "../../controllers/stream/overlay-layout.js";
import {
    getQueueSettingsController,
    putQueueSettingsController,
} from "../../controllers/stream/queue-settings.js";
import {
    getReferenceBackgroundController,
    uploadReferenceBackgroundMiddleware,
    uploadReferenceBackgroundController,
    patchReferenceBackgroundOpacityController,
    deleteReferenceBackgroundController,
} from "../../controllers/stream/overlay-reference-background.js";
import { authenticateStreamUser } from "../../middleware/stream-auth.js";
import { uploadRateLimiter } from "../../middleware/rate-limit.js";

export const streamAccountRouter = Router();

streamAccountRouter.use(authenticateStreamUser);

streamAccountRouter.get("/me", getMeController);
streamAccountRouter.patch("/me/game-mode", patchGameModeController);
streamAccountRouter.post("/me/regenerate-token", regenerateTokenController);
streamAccountRouter.post(
    "/me/companion-token/regenerate",
    regenerateCompanionTokenController
);

streamAccountRouter.get("/session", getSessionController);
streamAccountRouter.patch("/session", patchSessionController);
streamAccountRouter.post("/session/reset", resetSessionController);

streamAccountRouter.get("/me/matches", getMatchesController);
streamAccountRouter.patch("/me/matches/:matchId", patchMatchController);

streamAccountRouter.get("/me/overlay-layout", getOverlayLayoutController);
streamAccountRouter.put("/me/overlay-layout", putOverlayLayoutController);
streamAccountRouter.get("/me/queue-settings", getQueueSettingsController);
streamAccountRouter.put("/me/queue-settings", putQueueSettingsController);

streamAccountRouter.get(
    "/me/overlay-reference-background",
    getReferenceBackgroundController
);
streamAccountRouter.post(
    "/me/overlay-reference-background",
    uploadRateLimiter,
    uploadReferenceBackgroundMiddleware,
    uploadReferenceBackgroundController
);
streamAccountRouter.patch(
    "/me/overlay-reference-background",
    patchReferenceBackgroundOpacityController
);
streamAccountRouter.delete(
    "/me/overlay-reference-background",
    deleteReferenceBackgroundController
);
