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

// WK-157 - "Viewer Quiz" setting: must default to false for any settings
// blob stored before this field existed (the feature doesn't yet work
// reliably for viewers - existing users must not be opted in silently), via
// zod's per-field default rather than an explicit version-bump migration
// like the recentGamesLimit one above.
describe("viewerQuizEnabled default", () => {
    it("defaults to false on a pre-existing settings blob that predates this field", () => {
        const stored = { ...DEFAULT_QUEUE_SETTINGS };
        const widgetsWithoutViewerQuiz = { ...stored.widgets } as Partial<typeof stored.widgets>;
        delete widgetsWithoutViewerQuiz.viewerQuizEnabled;

        const parsed = queueSettingsSchema.parse({ ...stored, widgets: widgetsWithoutViewerQuiz });

        expect(parsed.widgets.viewerQuizEnabled).toBe(false);
    });

    it("is false in DEFAULT_QUEUE_SETTINGS itself", () => {
        expect(DEFAULT_QUEUE_SETTINGS.widgets.viewerQuizEnabled).toBe(false);
    });

    it("round-trips an explicit true through the schema", () => {
        const parsed = queueSettingsSchema.parse({
            ...DEFAULT_QUEUE_SETTINGS,
            widgets: { ...DEFAULT_QUEUE_SETTINGS.widgets, viewerQuizEnabled: true },
        });

        expect(parsed.widgets.viewerQuizEnabled).toBe(true);
    });
});
