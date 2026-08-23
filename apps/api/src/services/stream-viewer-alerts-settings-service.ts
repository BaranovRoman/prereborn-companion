import { z } from "zod";
import { pool } from "../db/client.js";

// WK-72 - same table/service shape as stream-queue-settings-service.ts
// (jsonb blob keyed by stream_user_id, upserted via ON CONFLICT), kept as
// its own table rather than folded into queue settings: viewer alerts are a
// distinct domain (Twitch follow/sub/raid overlay alerts) from queue widget
// visibility, and this keeps either from having to migrate around the
// other's schema changes.
export const viewerAlertsSettingsSchema = z.object({
    enabled: z.boolean(),
    types: z.object({
        follow: z.boolean(),
        subscribe: z.boolean(),
        giftSub: z.boolean(),
        raid: z.boolean(),
    }),
});

export type ViewerAlertsSettings = z.infer<typeof viewerAlertsSettingsSchema>;

// Opt-out, not opt-in - same default posture as the existing twitchChat
// queue widget (DEFAULT_QUEUE_SETTINGS.visibility.twitchChat: true): these
// alerts surface no new category of viewer data (WK-54), so there's no
// privacy reason to default them off.
export const DEFAULT_VIEWER_ALERTS_SETTINGS: ViewerAlertsSettings = {
    enabled: true,
    types: { follow: true, subscribe: true, giftSub: true, raid: true },
};

export class InvalidViewerAlertsSettingsError extends Error {}

const viewerAlertsSettingsInputSchema = z.object({
    enabled: z.boolean().optional(),
    types: z.object({
        follow: z.boolean().optional(),
        subscribe: z.boolean().optional(),
        giftSub: z.boolean().optional(),
        raid: z.boolean().optional(),
    }).optional(),
});

export const getViewerAlertsSettings = async (streamUserId: string): Promise<ViewerAlertsSettings> => {
    const { rows } = await pool.query<{ settings: unknown }>(
        "SELECT settings FROM stream_viewer_alerts_settings WHERE stream_user_id = $1",
        [streamUserId]
    );
    const parsed = viewerAlertsSettingsSchema.safeParse(rows[0]?.settings);
    return parsed.success ? parsed.data : DEFAULT_VIEWER_ALERTS_SETTINGS;
};

export const saveViewerAlertsSettings = async (
    streamUserId: string,
    input: unknown
): Promise<ViewerAlertsSettings> => {
    const parsed = viewerAlertsSettingsInputSchema.safeParse(input);
    if (!parsed.success) {
        throw new InvalidViewerAlertsSettingsError("Invalid viewer alerts settings");
    }
    const current = await getViewerAlertsSettings(streamUserId);
    const next: ViewerAlertsSettings = {
        enabled: parsed.data.enabled ?? current.enabled,
        types: { ...current.types, ...parsed.data.types },
    };
    await pool.query(
        `INSERT INTO stream_viewer_alerts_settings (stream_user_id, settings)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (stream_user_id) DO UPDATE
         SET settings = EXCLUDED.settings, updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, JSON.stringify(next)]
    );
    return next;
};
