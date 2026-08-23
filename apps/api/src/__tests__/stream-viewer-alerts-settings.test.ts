import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import {
    DEFAULT_VIEWER_ALERTS_SETTINGS,
    getViewerAlertsSettings,
    InvalidViewerAlertsSettingsError,
    saveViewerAlertsSettings,
} from "../services/stream-viewer-alerts-settings-service.js";

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
