import express from "express";
import cors from "cors";
import path from "path";
import { streamAuthRouter } from "./routes/stream/auth.js";
import { streamAccountRouter } from "./routes/stream/account.js";
import { streamOverlayRouter } from "./routes/stream/overlay.js";
import { streamIntegrationsRouter } from "./routes/stream/integrations.js";
import { streamCompanionRouter } from "./routes/stream/companion.js";
import { adminUsersRouter } from "./routes/admin/users.js";
import { corsOptions } from "./config/cors.js";
import { securityHeaders } from "./config/security-headers.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { pool } from "./db/client.js";
import { env } from "./config/env.js";

export const app = express();
app.set("trust proxy", 1);
app.use(requestId, securityHeaders, cors(corsOptions), express.json({ limit: "1mb" }), requestLogger);
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use("/api/stream/auth", streamAuthRouter);
app.use("/api/stream/account", streamAccountRouter);
app.use("/api/stream/overlay", streamOverlayRouter);
app.use("/api/stream/integrations", streamIntegrationsRouter);
app.use("/api/stream/companion", streamCompanionRouter);
app.use("/api/admin/users", adminUsersRouter);
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      database: "connected",
      integrations: {
        twitchConfigured: Boolean(
          env.twitchClientId && env.twitchClientSecret && env.twitchRedirectUri
        ),
        donationAlertsConfigured: Boolean(
          env.donationAlertsClientId && env.donationAlertsClientSecret
        ),
        adminAccessConfigured: env.adminEmails.length > 0,
      },
    });
  } catch {
    res.json({ status: "ok", database: "disconnected" });
  }
});
app.use(notFoundHandler, errorHandler);
