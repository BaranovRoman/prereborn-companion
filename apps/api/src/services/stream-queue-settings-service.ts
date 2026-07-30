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
const channelGoalSchema = z.object({
    type: z.enum(["none", "rating", "custom"]),
    label: z.string().trim().max(48),
    startValue: z.number().finite(),
    targetValue: z.number().finite(),
});

export const queueSettingsSchema = z.object({
    version: z.literal(1),
    visibility: visibilitySchema,
    favoriteHeroIds: z.array(z.number().int().positive()).max(3).default([]),
    webcamImageUrl: z.string().max(512).nullable().default(null),
    channelGoal: channelGoalSchema.default({
        type: "none",
        label: "",
        startValue: 0,
        targetValue: 0,
    }),
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
        systemStatus: false,
    },
    favoriteHeroIds: [],
    webcamImageUrl: null,
    channelGoal: {
        type: "none",
        label: "",
        startValue: 0,
        targetValue: 0,
    },
};

export class InvalidQueueSettingsError extends Error {}

const queueSettingsInputSchema = z.object({
    version: z.literal(1).optional(),
    visibility: z.record(z.string(), z.boolean()).optional(),
    favoriteHeroIds: z.array(z.number().int().positive()).max(3).optional(),
    webcamImageUrl: z.string().max(512).nullable().optional(),
    channelGoal: channelGoalSchema.optional(),
});

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
    const parsed = queueSettingsInputSchema.safeParse(input);
    if (!parsed.success) {
        throw new InvalidQueueSettingsError("Invalid queue settings");
    }
    const current = await getQueueSettings(streamUserId);
    const next = queueSettingsSchema.parse({
        version: 1,
        visibility: {
            ...current.visibility,
            ...parsed.data.visibility,
        },
        favoriteHeroIds:
            parsed.data.favoriteHeroIds ?? current.favoriteHeroIds,
        webcamImageUrl:
            parsed.data.webcamImageUrl === undefined
                ? current.webcamImageUrl
                : parsed.data.webcamImageUrl,
        channelGoal:
            parsed.data.channelGoal ?? current.channelGoal,
    });
    await pool.query(
        `INSERT INTO stream_queue_settings (stream_user_id, settings)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (stream_user_id) DO UPDATE
         SET settings = EXCLUDED.settings, updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, JSON.stringify(next)]
    );
    return next;
};
