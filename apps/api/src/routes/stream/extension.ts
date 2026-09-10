import { Router } from "express";
import {
    getExtensionQuizStateController,
    postExtensionAnswerController,
} from "../../controllers/stream/extension.js";
import { authenticateTwitchExtension } from "../../middleware/authenticate-twitch-extension.js";
import { twitchExtensionAnswerRateLimiter } from "../../middleware/rate-limit.js";

// WK-116 Phase 4 - the Twitch Video Overlay Extension's only backend
// surface. Every route requires a valid Extension JWT (see
// authenticate-twitch-extension.ts) - there is no unauthenticated path
// here, unlike /stream/overlay/:publicToken (which is deliberately public
// for OBS). The Extension never receives a companion_token or streamJwt;
// its only credential is the Twitch-issued JWT scoped to this one
// extension.
export const streamExtensionRouter = Router();

streamExtensionRouter.get(
    "/quiz/state",
    authenticateTwitchExtension,
    getExtensionQuizStateController
);

streamExtensionRouter.post(
    "/quiz/answer",
    twitchExtensionAnswerRateLimiter,
    authenticateTwitchExtension,
    postExtensionAnswerController
);
