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
// crash, a restart or a provider outage right after the commit can't lose
// them, and every task is idempotent (a missing file or an already-dead
// token counts as done), so retries are safe.
//
// A row holds the minimum needed to finish the job: a random upload
// basename or the Twitch token pair, plus the numeric account id for log
// correlation. It is deleted as soon as the task succeeds. A task that keeps
// failing is given up after MAX_ATTEMPTS / MAX_AGE_MS: the payload (the
// token) is wiped and the row stays as a tombstone, so failures can be
// counted (getCleanupStats) without keeping any secret.

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

export const twitchRevokeTask = (tokens: {
    accessToken: string | null;
    refreshToken: string | null;
}): CleanupTask[] =>
    tokens.accessToken || tokens.refreshToken
        ? [{ kind: "twitch_revoke", payload: JSON.stringify(tokens) }]
        : [];

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

// https://dev.twitch.tv/docs/authentication/revoke-tokens/ - POST,
// form-urlencoded client_id + token (an ACCESS token). 200 = revoked;
// 400 {"message":"Invalid token"} = it is already dead (expired/revoked).
// Anything else (404 "client does not exist", 429, 5xx, network) is retried.
type RevokeResult = "revoked" | "already_invalid" | "retry";

const revokeAccessToken = async (clientId: string, token: string): Promise<RevokeResult> => {
    try {
        const response = await fetch("https://id.twitch.tv/oauth2/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, token }),
        });
        if (response.ok) return "revoked";
        if (response.status === 400) {
            const body = (await response.json().catch(() => null)) as { message?: string } | null;
            if (body?.message?.toLowerCase() === "invalid token") return "already_invalid";
        }
        return "retry";
    } catch {
        return "retry";
    }
};

// The revoke endpoint documents access tokens only, and refresh tokens of a
// confidential client never expire - so a refresh token is never assumed
// dead. It is redeemed instead: 400/401 proves it is dead; a new access token
// means it was alive, and that new token is revoked in turn.
type RefreshResult = { status: "dead" } | { status: "alive"; accessToken: string } | { status: "retry" };

const redeemRefreshToken = async (
    clientId: string,
    clientSecret: string,
    refreshToken: string
): Promise<RefreshResult> => {
    try {
        const response = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "refresh_token",
                refresh_token: refreshToken,
            }),
        });
        if (response.status === 400 || response.status === 401) return { status: "dead" };
        if (!response.ok) return { status: "retry" };
        const body = (await response.json()) as { access_token?: string };
        return body.access_token ? { status: "alive", accessToken: body.access_token } : { status: "retry" };
    } catch {
        return { status: "retry" };
    }
};

// Revoke the stored access token, then make sure the refresh token can't mint
// a new one. Logs only outcomes, never a token.
const revokeTwitchTokens = async (payload: string, subjectId: string): Promise<Outcome> => {
    const clientId = env.twitchClientId;
    const clientSecret = env.twitchClientSecret;
    if (!clientId) return "done";
    let tokens: { accessToken: string | null; refreshToken: string | null };
    try {
        tokens = JSON.parse(payload);
    } catch {
        return "done";
    }

    if (tokens.accessToken) {
        const result = await revokeAccessToken(clientId, tokens.accessToken);
        if (result === "retry") return "retry";
    }
    if (!tokens.refreshToken || !clientSecret) return "done";

    const refreshed = await redeemRefreshToken(clientId, clientSecret, tokens.refreshToken);
    if (refreshed.status === "retry") return "retry";
    if (refreshed.status === "dead") {
        logger.info("Twitch tokens revoked", { streamUserId: subjectId, refreshTokenDead: true });
        return "done";
    }
    const second = await revokeAccessToken(clientId, refreshed.accessToken);
    if (second === "retry") return "retry";
    // Twitch doesn't document whether revoking an access token also ends its
    // refresh token; this line makes the answer visible in production logs.
    logger.warn("Twitch refresh token was still valid after access revoke; revoked the new access token", {
        streamUserId: subjectId,
    });
    return "done";
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
    if (row.kind === "twitch_revoke") return revokeTwitchTokens(row.payload, row.subject_id.toString());
    return Promise.resolve("done");
};

// Claims due rows by pushing their not_before forward (exponential backoff)
// in one UPDATE, so an immediate run and the periodic sweep never work on
// the same row at once; then deletes each row that succeeded. Pass
// subjectId to process only one account's tasks (right after its deletion).
export const processPendingCleanups = async (
    options: { subjectId?: string; uploadsDir?: string } = {}
): Promise<{ done: number; failed: number; gaveUp: number }> => {
    const uploadsDir = options.uploadsDir ?? env.uploadsDir;
    const claimed = await pool.query<CleanupRow>(
        `UPDATE pending_data_cleanups
            SET attempts = attempts + 1,
                not_before = NOW() + LEAST(POWER(2, attempts) * INTERVAL '1 minute', INTERVAL '6 hours')
          WHERE id IN (
                SELECT id FROM pending_data_cleanups
                 WHERE gave_up_at IS NULL AND not_before <= NOW()
                   AND ($1::int IS NULL OR subject_id = $1)
                 ORDER BY id
                 LIMIT ${BATCH_SIZE}
                 FOR UPDATE SKIP LOCKED)
          RETURNING id, kind, payload, subject_id, attempts, created_at`,
        [options.subjectId ?? null]
    );

    let done = 0;
    let failed = 0;
    let gaveUp = 0;
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
            await pool.query(
                "UPDATE pending_data_cleanups SET payload = '', gave_up_at = NOW() WHERE id = $1",
                [row.id]
            );
            gaveUp += 1;
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
    return { done, failed, gaveUp };
};

// Counts only - for /api/admin/usage-stats. No payloads, no ids.
export const getCleanupStats = async (): Promise<{ pending: number; failed: number }> => {
    const result = await pool.query<{ pending: number; failed: number }>(
        `SELECT COUNT(*) FILTER (WHERE gave_up_at IS NULL)::int AS pending,
                COUNT(*) FILTER (WHERE gave_up_at IS NOT NULL)::int AS failed
           FROM pending_data_cleanups`
    );
    return result.rows[0];
};

// Single PM2 fork instance (see ecosystem.config.cjs) - one in-process timer
// is enough; the claim above keeps it safe even if that ever changes. The
// first sweep runs at startup, so tasks left by a restart are picked up.
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
