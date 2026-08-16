import { describe, expect, it } from "vitest";
import {
    DEFAULT_QUEUE_SETTINGS,
    migrateQueueSettings,
    queueSettingsSchema,
} from "../services/stream-queue-settings-service.js";

describe("queue settings migration", () => {
    it("upgrades the legacy five-game default to fifteen without losing settings", () => {
        const legacy = queueSettingsSchema.parse({
            ...DEFAULT_QUEUE_SETTINGS,
            version: 1,
            visibility: {
                ...DEFAULT_QUEUE_SETTINGS.visibility,
                twitchChat: false,
            },
            widgets: {
                ...DEFAULT_QUEUE_SETTINGS.widgets,
                recentGamesLimit: 5,
            },
        });

        expect(migrateQueueSettings(legacy)).toMatchObject({
            version: 2,
            visibility: { twitchChat: false },
            widgets: { recentGamesLimit: 15 },
        });
    });

    it("preserves an already migrated explicit limit", () => {
        const current = queueSettingsSchema.parse({
            ...DEFAULT_QUEUE_SETTINGS,
            widgets: {
                ...DEFAULT_QUEUE_SETTINGS.widgets,
                recentGamesLimit: 12,
            },
        });

        expect(migrateQueueSettings(current).widgets.recentGamesLimit).toBe(12);
    });
});
