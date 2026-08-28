import { Router } from "express";
import {
    endCompanionSessionController,
    getCompanionSessionController,
    getCompanionTwitchChatController,
    putCompanionGsiStateController,
    resetCompanionSessionController,
} from "../../controllers/stream/companion.js";
import { getCompanionObsCommandController } from "../../controllers/stream/obs-scene.js";
import {
    getCompanionAccountSettingsController,
    getSyncCorrectionsController,
    postSyncEventController,
} from "../../controllers/stream/sync.js";
import { authenticateCompanionToken } from "../../middleware/authenticate-companion-token.js";
import { streamCompanionRateLimiter } from "../../middleware/rate-limit.js";

export const streamCompanionRouter = Router();

streamCompanionRouter.get(
    "/twitch-chat",
    authenticateCompanionToken,
    getCompanionTwitchChatController
);

// WK-83 - startup "продолжить прошлый стрим?" предложение в Companion.
streamCompanionRouter.get(
    "/session",
    authenticateCompanionToken,
    getCompanionSessionController
);
streamCompanionRouter.post(
    "/session/reset",
    authenticateCompanionToken,
    resetCompanionSessionController
);
// WK-100 - "Завершить стрим" self-service action from inside Companion.
streamCompanionRouter.post(
    "/session/end",
    authenticateCompanionToken,
    endCompanionSessionController
);

streamCompanionRouter.get(
    "/commands",
    authenticateCompanionToken,
    getCompanionObsCommandController
);

streamCompanionRouter.put(
    "/gsi-state",
    streamCompanionRateLimiter,
    authenticateCompanionToken,
    putCompanionGsiStateController
);

// WK-113 - local-first cutover: session/match/MMR now reach the backend
// through these, not through gsi-state above (see
// putCompanionGsiStateController's doc comment).
streamCompanionRouter.post(
    "/sync/events",
    streamCompanionRateLimiter,
    authenticateCompanionToken,
    postSyncEventController
);
streamCompanionRouter.get(
    "/sync/corrections",
    authenticateCompanionToken,
    getSyncCorrectionsController
);
streamCompanionRouter.get(
    "/account-settings",
    authenticateCompanionToken,
    getCompanionAccountSettingsController
);
