import { app } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/client.js";
import { startPendingCleanupSweeper } from "./services/pending-cleanup-service.js";

const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`PreReborn API listening on 127.0.0.1:${env.port}`);
});

// WK-192 - retries file removal / token revocation left over from deleted
// accounts and disconnected integrations.
const stopCleanupSweeper = startPendingCleanupSweeper();

const shutdown = (signal: string) => {
  stopCleanupSweeper();
  server.close(async () => {
    await pool.end();
    console.log(`Stopped after ${signal}`);
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

