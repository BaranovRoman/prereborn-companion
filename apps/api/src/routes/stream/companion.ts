import { Router } from "express";
import {
    getCompanionSessionController,
    getCompanionTwitchChatController,
    putCompanionGsiStateController,
    resetCompanionSessionController,
} from "../../controllers/stream/companion.js";
import { getCompanionObsCommandController } from "../../controllers/stream/obs-scene.js";
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
