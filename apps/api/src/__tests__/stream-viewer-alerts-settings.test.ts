import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import {
    DEFAULT_VIEWER_ALERTS_SETTINGS,
    filterViewerEventsForPublicOverlay,
    getViewerAlertsSettings,
    InvalidViewerAlertsSettingsError,
    saveViewerAlertsSettings,
} from "../services/stream-viewer-alerts-settings-service.js";
import type { TwitchViewerEvent } from "../services/twitch-eventsub-chat.js";

const suffix = `${Date.now()}-viewer-alerts-settings`;
const createdUserIds: string[] = [];

const createTestUser = async (): Promise<string> => {
    const email = `stream_va_${suffix}_${createdUserIds.length + 1}@example.com`;
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    const id = result.rows[0].id.toString();
    createdUserIds.push(id);
    return id;
};

beforeAll(async () => {
    await createTables();
});

afterAll(async () => {
    if (createdUserIds.length > 0) {
        await pool.query(`DELETE FROM stream_users WHERE id = ANY($1::int[])`, [createdUserIds.map(Number)]);
    }
    await pool.end();
});

describe("viewer alerts settings", () => {
    it("defaults to enabled with every event type on, before any settings are saved", async () => {
        const streamUserId = await createTestUser();
        expect(await getViewerAlertsSettings(streamUserId)).toEqual(DEFAULT_VIEWER_ALERTS_SETTINGS);
    });

    it("persists a partial update, merging it onto the current settings rather than replacing them", async () => {
        const streamUserId = await createTestUser();

        const afterDisablingRaid = await saveViewerAlertsSettings(streamUserId, { types: { raid: false } });
        expect(afterDisablingRaid).toEqual({
            enabled: true,
            types: { follow: true, subscribe: true, giftSub: true, raid: false },
        });

        const afterDisablingAll = await saveViewerAlertsSettings(streamUserId, { enabled: false });
        expect(afterDisablingAll).toEqual({
            enabled: false,
            types: { follow: true, subscribe: true, giftSub: true, raid: false },
        });

        expect(await getViewerAlertsSettings(streamUserId)).toEqual(afterDisablingAll);
    });

    it("rejects a malformed payload instead of silently ignoring it", async () => {
        const streamUserId = await createTestUser();
        await expect(saveViewerAlertsSettings(streamUserId, { enabled: "yes" })).rejects.toBeInstanceOf(
            InvalidViewerAlertsSettingsError
        );
    });
});

// WK-72 review follow-up - GET /api/stream/overlay/:publicToken is public
// and unauthenticated: a disabled alert type/global toggle must mean that
// viewer's event never leaves the server in the JSON payload, not just
// "the widget won't render it" client-side.
describe("filterViewerEventsForPublicOverlay", () => {
    const follow = (id: string): TwitchViewerEvent => ({ id, type: "follow", userName: "Alice", userLogin: null, receivedAt: "2026-08-23T00:00:00Z" });
    const raid = (id: string): TwitchViewerEvent => ({ id, type: "raid", userName: "Raider", userLogin: null, viewerCount: 10, receivedAt: "2026-08-23T00:00:00Z" });

    it("passes through every event when all types are enabled", () => {
        const events = [follow("1"), raid("2")];
        expect(filterViewerEventsForPublicOverlay(events, DEFAULT_VIEWER_ALERTS_SETTINGS)).toEqual(events);
    });

    it("drops a specific disabled type but keeps the rest", () => {
        const settings = { ...DEFAULT_VIEWER_ALERTS_SETTINGS, types: { ...DEFAULT_VIEWER_ALERTS_SETTINGS.types, raid: false } };
        const result = filterViewerEventsForPublicOverlay([follow("1"), raid("2")], settings);
        expect(result.map((e) => e.id)).toEqual(["1"]);
    });

    it("returns nothing at all once alerts are globally disabled, even if a type is still individually on", () => {
        const settings = { enabled: false, types: { ...DEFAULT_VIEWER_ALERTS_SETTINGS.types, raid: true } };
        expect(filterViewerEventsForPublicOverlay([follow("1"), raid("2")], settings)).toEqual([]);
    });
});
