import { Router } from "express";
import {
    connectSteamController,
    disconnectSteamController,
    getSteamStatusController,
    steamCallbackController,
} from "../../controllers/stream/steam.js";
import { syncDotaController } from "../../controllers/stream/dota-sync.js";
import { authenticateStreamUser } from "../../middleware/stream-auth.js";
import { steamCallbackRateLimiter } from "../../middleware/rate-limit.js";
import {
    connectTwitchController,
    disconnectTwitchController,
    getTwitchStatusController,
    twitchCallbackController,
} from "../../controllers/stream/twitch.js";

export const streamIntegrationsRouter = Router();

// Осознанно НЕ router.use(authenticateStreamUser) на весь роутер - у этого
// роутера единственный публичный маршрут (callback, см. controllers/stream/steam.ts
// про то, почему он не может быть авторизован Bearer-токеном), остальные
// защищены поштучно, чтобы порядок регистрации маршрутов не был источником
// случайной уязвимости.
streamIntegrationsRouter.get("/steam", authenticateStreamUser, getSteamStatusController);
streamIntegrationsRouter.get(
    "/steam/connect",
    authenticateStreamUser,
    connectSteamController
);
streamIntegrationsRouter.get(
    "/steam/callback",
    steamCallbackRateLimiter,
    steamCallbackController
);
streamIntegrationsRouter.delete(
    "/steam",
    authenticateStreamUser,
    disconnectSteamController
);

streamIntegrationsRouter.post(
    "/dota/sync",
    authenticateStreamUser,
    syncDotaController
);

streamIntegrationsRouter.get("/twitch", authenticateStreamUser, getTwitchStatusController);
streamIntegrationsRouter.get("/twitch/connect", authenticateStreamUser, connectTwitchController);
streamIntegrationsRouter.get("/twitch/callback", steamCallbackRateLimiter, twitchCallbackController);
streamIntegrationsRouter.delete("/twitch", authenticateStreamUser, disconnectTwitchController);
