import { z } from "zod";
import { pool } from "../db/client.js";

export const queueWidgetIdSchema = z.enum([
    "playerProfile",
    "streamProfile",
    "featuredMatch",
    "webcam",
    "favoriteHeroes",
    "recentGames",
    "twitchChat",
    "systemStatus",
]);

const visibilitySchema = z.record(queueWidgetIdSchema, z.boolean());

export const queueSettingsSchema = z.object({
    version: z.literal(1),
    visibility: visibilitySchema,
});

export type QueueSettings = z.infer<typeof queueSettingsSchema>;

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
    version: 1,
    visibility: {
        playerProfile: true,
        streamProfile: true,
        featuredMatch: true,
        webcam: true,
        favoriteHeroes: true,
        recentGames: true,
        twitchChat: true,
        systemStatus: true,
    },
};

export class InvalidQueueSettingsError extends Error {}

export const getQueueSettings = async (streamUserId: string): Promise<QueueSettings> => {
    const { rows } = await pool.query<{ settings: unknown }>(
        "SELECT settings FROM stream_queue_settings WHERE stream_user_id = $1",
        [streamUserId]
    );
    const parsed = queueSettingsSchema.safeParse(rows[0]?.settings);
    return parsed.success ? parsed.data : DEFAULT_QUEUE_SETTINGS;
};

export const saveQueueSettings = async (
    streamUserId: string,
    input: unknown
): Promise<QueueSettings> => {
    const parsed = queueSettingsSchema.safeParse(input);
    if (!parsed.success) {
        throw new InvalidQueueSettingsError("Invalid queue settings");
    }
    await pool.query(
        `INSERT INTO stream_queue_settings (stream_user_id, settings)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (stream_user_id) DO UPDATE
         SET settings = EXCLUDED.settings, updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, JSON.stringify(parsed.data)]
    );
    return parsed.data;
};
