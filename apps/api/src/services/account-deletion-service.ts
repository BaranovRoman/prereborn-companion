import path from "path";
import { pool } from "../db/client.js";
import { env } from "../config/env.js";
import { isInsideUploadsDir, safeUnlink } from "../utils/upload-security.js";
import { clearTwitchUserState, revokeTwitchTokens } from "./twitch-integration-service.js";
import { clearObsSceneState } from "./obs-scene-command-service.js";
import { clearDotaSyncState } from "./dota-sync-service.js";
import { forgetIntegrationStatus } from "../controllers/stream/overlay.js";

// WK-192 - deletes an account and everything tied to it (152-ФЗ ст. 14, 20,
// 21). Every stream_* / quiz_* / companion_activity_days row references
// stream_users ON DELETE CASCADE (directly or via stream_sessions), so the
// database part is a single DELETE inside one transaction. What the database
// can't cascade is done after the commit: uploaded files, provider tokens and
// in-memory state. Those steps are best-effort - a failed revoke or unlink
// must not leave the account half-alive in the database.
export const deleteStreamUserAccount = async (
    streamUserId: string,
    uploadsDir: string = env.uploadsDir
): Promise<boolean> => {
    const client = await pool.connect();
    let uploads: string[];
    let twitch: { access_token: string | null; refresh_token: string | null } | undefined;
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
        uploads = files.rows
            .map((row) => row.filename)
            .filter((name): name is string => Boolean(name))
            .map((name) => path.basename(name));

        twitch = (
            await client.query<{ access_token: string | null; refresh_token: string | null }>(
                "SELECT access_token, refresh_token FROM stream_twitch_links WHERE stream_user_id = $1",
                [streamUserId]
            )
        ).rows[0];

        await client.query("DELETE FROM stream_users WHERE id = $1", [streamUserId]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    for (const name of uploads) {
        const target = path.join(uploadsDir, name);
        if (isInsideUploadsDir(uploadsDir, target)) await safeUnlink(target);
    }

    clearTwitchUserState(streamUserId);
    clearObsSceneState(streamUserId);
    clearDotaSyncState(streamUserId);
    forgetIntegrationStatus(streamUserId);

    if (twitch) {
        await revokeTwitchTokens(streamUserId, {
            accessToken: twitch.access_token,
            refreshToken: twitch.refresh_token,
        });
    }
    // DonationAlerts has no revoke endpoint - its tokens went with the
    // cascaded stream_donation_alerts_links row.

    return true;
};
