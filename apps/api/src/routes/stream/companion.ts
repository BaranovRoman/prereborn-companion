import { Router } from "express";
import { putCompanionGsiStateController } from "../../controllers/stream/companion.js";
import { authenticateCompanionToken } from "../../middleware/authenticate-companion-token.js";
import { streamCompanionRateLimiter } from "../../middleware/rate-limit.js";

export const streamCompanionRouter = Router();

streamCompanionRouter.put(
    "/gsi-state",
    streamCompanionRateLimiter,
    authenticateCompanionToken,
    putCompanionGsiStateController
);
