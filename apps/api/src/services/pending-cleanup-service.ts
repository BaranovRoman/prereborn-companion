import fs from "fs/promises";
import path from "path";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { isInsideUploadsDir } from "../utils/upload-security.js";
import { logger } from "../utils/logger.js";

// WK-192 - work that has to happen outside the database after an account (or
// a Twitch link) is deleted: removing uploaded files and revoking tokens at
// Twitch. Tasks are inserted in the SAME transaction as the DELETE, so a
// crash or a provider outage right after the commit can't silently lose
// them, and every task is idempotent (a missing file or an already-dead
// token counts as done), so retries are safe.
//
// A row holds the minimum needed to finish the job: a random upload
// basename or the token to revoke, plus the numeric account id for log
// correlation. It is deleted as soon as the task succeeds; a task that
// keeps failing is dropped after MAX_ATTEMPTS / MAX_AGE_MS so a token is
// never kept around indefinitely.

export type CleanupTask =
    | { kind: "upload"; payload: string }
    | { kind: "twitch_revoke"; payload: string };

const MAX_ATTEMPTS = 12;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 50;

export const enqueueCleanups = async (
    client: PoolClient,
    subjectId: string,
    tasks: CleanupTask[]
): Promise<void> => {
    for (const task of tasks) {
        await client.query(
            `INSERT INTO pending_data_cleanups (kind, payload, subject_id) VALUES ($1, $2, $3)`,
            [task.kind, task.payload, subjectId]
        );
    }
};

type Outcome = "done" | "retry";

const removeUpload = async (basename: string, uploadsDir: string): Promise<Outcome> => {
    const target = path.join(uploadsDir, path.basename(basename));
    if (!isInsideUploadsDir(uploadsDir, target)) return "done";
    try {
        await fs.unlink(target);
        return "done";
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "done" : "retry";
    }
};

// POST id.twitch.tv/oauth2/revoke. 200 = revoked, 400 = already invalid
// (expired/revoked) - both mean nothing is left to revoke. Network errors,
// 429 and 5xx are retried. Without a client id there is nothing we can call.
const revokeTwitchToken = async (token: string): Promise<Outcome> => {
    const clientId = env.twitchClientId;
    if (!clientId) return "done";
    try {
        const response = await fetch("https://id.twitch.tv/oauth2/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, token }),
        });
        return response.ok || response.status === 400 ? "done" : "retry";
    } catch {
        return "retry";
    }
};

interface CleanupRow {
    id: number;
    kind: string;
    payload: string;
    subject_id: number;
    attempts: number;
    created_at: Date;
}

const runTask = (row: CleanupRow, uploadsDir: string): Promise<Outcome> => {
    if (row.kind === "upload") return removeUpload(row.payload, uploadsDir);
    if (row.kind === "twitch_revoke") return revokeTwitchToken(row.payload);
    return Promise.resolve("done");
};

// Claims due rows by pushing their not_before forward (exponential backoff)
// in one UPDATE, so an immediate run and the periodic sweep never work on
// the same row at once; then deletes each row that succeeded. Pass
// subjectId to process only one account's tasks (right after its deletion).
export const processPendingCleanups = async (
    options: { subjectId?: string; uploadsDir?: string } = {}
): Promise<{ done: number; failed: number; dropped: number }> => {
    const uploadsDir = options.uploadsDir ?? env.uploadsDir;
    const claimed = await pool.query<CleanupRow>(
        `UPDATE pending_data_cleanups
            SET attempts = attempts + 1,
                not_before = NOW() + LEAST(POWER(2, attempts) * INTERVAL '1 minute', INTERVAL '6 hours')
          WHERE id IN (
                SELECT id FROM pending_data_cleanups
                 WHERE not_before <= NOW() AND ($1::int IS NULL OR subject_id = $1)
                 ORDER BY id
                 LIMIT ${BATCH_SIZE}
                 FOR UPDATE SKIP LOCKED)
          RETURNING id, kind, payload, subject_id, attempts, created_at`,
        [options.subjectId ?? null]
    );

    let done = 0;
    let failed = 0;
    let dropped = 0;
    for (const row of claimed.rows) {
        const outcome = await runTask(row, uploadsDir);
        if (outcome === "done") {
            await pool.query("DELETE FROM pending_data_cleanups WHERE id = $1", [row.id]);
            done += 1;
            continue;
        }
        const expired =
            row.attempts >= MAX_ATTEMPTS || Date.now() - row.created_at.getTime() > MAX_AGE_MS;
        if (expired) {
            await pool.query("DELETE FROM pending_data_cleanups WHERE id = $1", [row.id]);
            dropped += 1;
            logger.error("Data cleanup given up", {
                streamUserId: row.subject_id.toString(),
                kind: row.kind,
                attempts: row.attempts,
            });
        } else {
            failed += 1;
            logger.warn("Data cleanup failed, will retry", {
                streamUserId: row.subject_id.toString(),
                kind: row.kind,
                attempts: row.attempts,
            });
        }
    }
    return { done, failed, dropped };
};

// Single PM2 fork instance (see ecosystem.config.cjs) - one in-process timer
// is enough; the claim above keeps it safe even if that ever changes.
export const startPendingCleanupSweeper = (): (() => void) => {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await processPendingCleanups();
        } catch (error) {
            logger.error("Data cleanup sweep failed", {
                message: error instanceof Error ? error.message : String(error),
            });
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(tick, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
};
