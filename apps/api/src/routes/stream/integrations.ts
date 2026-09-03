import { Router } from "express";
import {
    connectSteamController,
    disconnectSteamController,
    getSteamStatusController,
    steamCallbackController,
} from "../../controllers/stream/steam.js";
import { syncDotaController } from "../../controllers/stream/dota-sync.js";
import { getOpenDotaHeroStatsController } from "../../controllers/stream/opendota.js";
import { authenticateStreamUser } from "../../middleware/stream-auth.js";
import { steamCallbackRateLimiter } from "../../middleware/rate-limit.js";
import {
    connectTwitchController,
    disconnectTwitchController,
    getTwitchStatusController,
    twitchCallbackController,
} from "../../controllers/stream/twitch.js";
import {
    connectDonationAlertsController,
    disconnectDonationAlertsController,
    donationAlertsCallbackController,
    getDonationAlertsStatusController,
} from "../../controllers/stream/donation-alerts.js";

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

// WK-133 - Hero Detail's OpenDota per-hero statistics (product contract, see
// controllers/stream/opendota.ts) - reuses the same Steam identity link,
// never a second "connect OpenDota" account.
streamIntegrationsRouter.get(
    "/opendota/hero-stats/:heroId",
    authenticateStreamUser,
    getOpenDotaHeroStatsController
);

streamIntegrationsRouter.get("/twitch", authenticateStreamUser, getTwitchStatusController);
streamIntegrationsRouter.get("/twitch/connect", authenticateStreamUser, connectTwitchController);
streamIntegrationsRouter.get("/twitch/callback", steamCallbackRateLimiter, twitchCallbackController);
streamIntegrationsRouter.delete("/twitch", authenticateStreamUser, disconnectTwitchController);
streamIntegrationsRouter.get("/donation-alerts", authenticateStreamUser, getDonationAlertsStatusController);
streamIntegrationsRouter.get("/donation-alerts/connect", authenticateStreamUser, connectDonationAlertsController);
streamIntegrationsRouter.get("/donation-alerts/callback", steamCallbackRateLimiter, donationAlertsCallbackController);
streamIntegrationsRouter.delete("/donation-alerts", authenticateStreamUser, disconnectDonationAlertsController);
