import { Router } from "express";
import {
    endCompanionSessionController,
    getCompanionFavoriteHeroesController,
    getCompanionSessionController,
    getCompanionTwitchChatController,
    putCompanionFavoriteHeroesController,
    putCompanionGsiStateController,
    resetCompanionSessionController,
} from "../../controllers/stream/companion.js";
import { getCompanionObsCommandController } from "../../controllers/stream/obs-scene.js";
import {
    getCompanionAccountSettingsController,
    getSyncCorrectionsController,
    postSyncEventController,
} from "../../controllers/stream/sync.js";
import { authenticateCompanionSession } from "../../middleware/authenticate-companion-token.js";
import { streamCompanionRateLimiter } from "../../middleware/rate-limit.js";

export const streamCompanionRouter = Router();

streamCompanionRouter.get(
    "/twitch-chat",
    authenticateCompanionSession,
    getCompanionTwitchChatController
);

// WK-83 - startup "продолжить прошлый стрим?" предложение в Companion.
streamCompanionRouter.get(
    "/session",
    authenticateCompanionSession,
    getCompanionSessionController
);
streamCompanionRouter.post(
    "/session/reset",
    authenticateCompanionSession,
    resetCompanionSessionController
);
// WK-100 - "Завершить стрим" self-service action from inside Companion.
streamCompanionRouter.post(
    "/session/end",
    authenticateCompanionSession,
    endCompanionSessionController
);

streamCompanionRouter.get(
    "/commands",
    authenticateCompanionSession,
    getCompanionObsCommandController
);

streamCompanionRouter.put(
    "/gsi-state",
    streamCompanionRateLimiter,
    authenticateCompanionSession,
    putCompanionGsiStateController
);

// WK-113 - local-first cutover: session/match/MMR now reach the backend
// through these, not through gsi-state above (see
// putCompanionGsiStateController's doc comment).
streamCompanionRouter.post(
    "/sync/events",
    streamCompanionRateLimiter,
    authenticateCompanionSession,
    postSyncEventController
);
streamCompanionRouter.get(
    "/sync/corrections",
    authenticateCompanionSession,
    getSyncCorrectionsController
);
streamCompanionRouter.get(
    "/account-settings",
    authenticateCompanionSession,
    getCompanionAccountSettingsController
);

// WK-121 - favorite heroes, backed by the same stream_queue_settings row
// the web cabinet's Favorite Heroes picker already owns (see the
// controller's doc comment for why this isn't a new store).
streamCompanionRouter.get(
    "/favorite-heroes",
    authenticateCompanionSession,
    getCompanionFavoriteHeroesController
);
streamCompanionRouter.put(
    "/favorite-heroes",
    authenticateCompanionSession,
    putCompanionFavoriteHeroesController
);
