import path from "path";
import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { clearTwitchUserState, twitchRevokeTasks } from "./twitch-integration-service.js";
import { clearObsSceneState } from "./obs-scene-command-service.js";
import { clearDotaSyncState } from "./dota-sync-service.js";
import { enqueueCleanups, processPendingCleanups, type CleanupTask } from "./pending-cleanup-service.js";
import { forgetIntegrationStatus } from "../controllers/stream/overlay.js";

// A request that read the Twitch link just before the deletion can still be
// mid-flight when the caches are cleared and refill them for a moment; a
// second pass shortly after catches that. In-memory state dies with the
// process, so an in-process timer is all this needs.
const SECOND_MEMORY_PASS_MS = 2 * 60 * 1000;

const clearUserMemoryState = (streamUserId: string) => {
    clearTwitchUserState(streamUserId);
    clearObsSceneState(streamUserId);
    clearDotaSyncState(streamUserId);
    forgetIntegrationStatus(streamUserId);
};

// WK-192 - deletes an account and everything tied to it (152-ФЗ ст. 14, 20,
// 21). Every table that refers to an account does so ON DELETE CASCADE -
// directly via stream_user_id or through stream_sessions / quiz_rounds - so
// the database part is a single DELETE. What the database can't cascade
// (uploaded files, Twitch tokens) is queued as cleanup tasks in the same
// transaction and run right after the commit; a failure there is retried by
// the cleanup sweeper instead of being lost (pending-cleanup-service.ts).
// Returns false if the account doesn't exist (already deleted, or a
// concurrent deletion won the row lock).
export const deleteStreamUserAccount = async (
    streamUserId: string,
    uploadsDir: string = env.uploadsDir
): Promise<boolean> => {
    // Stop the EventSub socket before the commit, so it doesn't keep
    // receiving chat for an account that is about to disappear.
    clearTwitchUserState(streamUserId);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const user = await client.query(
            "SELECT id FROM stream_users WHERE id = $1 FOR UPDATE",
            [streamUserId]
        );
        if (!user.rows[0]) {
            await client.query("ROLLBACK");
            return false;
        }

        const files = await client.query<{ filename: string | null }>(
            `SELECT filename FROM stream_overlay_reference_backgrounds WHERE stream_user_id = $1
             UNION ALL
             SELECT settings->>'webcamImageUrl' FROM stream_queue_settings WHERE stream_user_id = $1`,
            [streamUserId]
        );
        const twitch = await client.query<{ access_token: string | null; refresh_token: string | null }>(
            "SELECT access_token, refresh_token FROM stream_twitch_links WHERE stream_user_id = $1",
            [streamUserId]
        );

        const tasks: CleanupTask[] = [
            ...files.rows
                .map((row) => row.filename)
                .filter((name): name is string => Boolean(name))
                .map((name) => ({ kind: "upload" as const, payload: path.basename(name) })),
            ...(twitch.rows[0] ? twitchRevokeTasks(twitch.rows[0]) : []),
        ];
        await enqueueCleanups(client, streamUserId, tasks);
        // DonationAlerts has no revoke endpoint - its tokens go with the
        // cascaded stream_donation_alerts_links row.
        await client.query("DELETE FROM stream_users WHERE id = $1", [streamUserId]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    clearUserMemoryState(streamUserId);
    setTimeout(() => clearUserMemoryState(streamUserId), SECOND_MEMORY_PASS_MS).unref();

    // The account is gone at this point - a failure below must not turn the
    // response into an error; the sweeper retries whatever is left.
    await processPendingCleanups({ subjectId: streamUserId, uploadsDir }).catch((error) => {
        logger.warn("Account cleanup run failed, left to the cleanup sweeper", {
            streamUserId,
            message: error instanceof Error ? error.message : String(error),
        });
    });

    return true;
};
