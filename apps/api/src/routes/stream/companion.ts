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
    getOverlayLayoutController,
    putOverlayLayoutController,
} from "../../controllers/stream/overlay-layout.js";
import { getQueueSettingsController, putQueueSettingsController } from "../../controllers/stream/queue-settings.js";
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

// Same account-owned Between Matches configuration used by the old web
// dashboard. Companion auth changes only how the existing row is reached.
streamCompanionRouter.get("/queue-settings", authenticateCompanionSession, getQueueSettingsController);
streamCompanionRouter.put("/queue-settings", authenticateCompanionSession, putQueueSettingsController);

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

// WK-122 §19 - OverlayLayout source of truth. Same JWT-only gap favorite
// heroes had before WK-121: the saved layout was only reachable via
// GET/PUT /account/me/overlay-layout (authenticateStreamUser), so the local
// overlay renderer/editor had no access to it and fell back to fixed
// default widget positions. Reuses the EXACT SAME controllers the web
// cabinet's editor already calls (getOverlayLayoutController/
// putOverlayLayoutController, controllers/stream/overlay-layout.ts) - no
// narrowed wire shape here (unlike favorite-heroes) since Companion, now
// the authoring surface (see this slice's research doc §"OverlayLayout
// source of truth"), needs the exact same full layout a web session would
// read/write, not a subset.
streamCompanionRouter.get(
    "/overlay-layout",
    authenticateCompanionSession,
    getOverlayLayoutController
);
streamCompanionRouter.put(
    "/overlay-layout",
    authenticateCompanionSession,
    putOverlayLayoutController
);
