import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { env } from "../config/env.js";
import { recordCompanionHeartbeat } from "../services/usage-stats-service.js";
import { getOrCreateActiveSession } from "../services/stream-session-service.js";
import { saveQueueSettings } from "../services/stream-queue-settings-service.js";
import { disconnectTwitch, saveTwitchLink } from "../services/twitch-integration-service.js";
import { saveDonationAlertsLink } from "../services/donation-alerts-integration-service.js";

// WK-192 - account deletion: self-service with a password, admin action for
// requests that come in by email. ADMIN_EMAILS is pinned to
// admin_wk52_test@example.com in vitest.config.ts.
const suffix = `${Date.now()}-wk192`;
const adminEmail = "admin_wk52_test@example.com";
const password = "test-password-123";
const createdIds: number[] = [];
let adminId: number;

const sessionJwt = (streamUserId: number) =>
    jwt.sign({ streamUserId: streamUserId.toString() }, process.env.STREAM_JWT_SECRET!, {
        expiresIn: "5m",
    });

const insertUser = async (email: string): Promise<number> => {
    const hashed = await bcrypt.hash(password, 4);
    const result = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    createdIds.push(result.rows[0].id);
    return result.rows[0].id;
};

// Every table that carries stream_user_id - discovered, not listed, so a
// table added later without ON DELETE CASCADE fails this test.
const remainingRows = async (streamUserId: number) => {
    const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name = 'stream_user_id'`
    );
    const counts: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
        const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table_name} WHERE stream_user_id = $1`, [
            streamUserId,
        ]);
        counts[table_name] = result.rows[0].n;
    }
    const scores = await pool.query(
        `SELECT COUNT(*)::int AS n FROM quiz_viewer_scores WHERE stream_session_id = ANY($1::int[])`,
        [seededSessionIds]
    );
    counts.quiz_viewer_scores = scores.rows[0].n;
    counts.stream_users = (await pool.query("SELECT COUNT(*)::int AS n FROM stream_users WHERE id = $1", [streamUserId])).rows[0].n;
    return counts;
};

let seededSessionIds: number[] = [];

// Seeds the user with rows across the tables a real streamer accumulates,
// two uploaded files and a Twitch + DonationAlerts link.
const seedAccount = async (streamUserId: number) => {
    const id = streamUserId.toString();
    const session = await getOrCreateActiveSession(id);
    seededSessionIds.push(Number(session.id));
    await pool.query(
        `INSERT INTO quiz_viewer_scores (stream_session_id, twitch_viewer_id, twitch_display_name, score)
         VALUES ($1, $2, 'viewer', 3)`,
        [session.id, `viewer-${suffix}`]
    );
    await recordCompanionHeartbeat(streamUserId);
    await saveTwitchLink(
        id,
        { id: `tw-${suffix}-${id}`, login: "streamer", display_name: "Streamer", profile_image_url: "" },
        { access_token: `access-${id}`, refresh_token: `refresh-${id}`, expires_in: 3600 }
    );
    await saveDonationAlertsLink(
        id,
        { id: Number(id), code: "streamer", name: "Streamer", avatar: null },
        { access_token: `da-${id}`, refresh_token: `da-refresh-${id}`, expires_in: 3600, token_type: "Bearer" }
    );

    fs.mkdirSync(env.uploadsDir, { recursive: true });
    const background = `wk192-bg-${id}.png`;
    const webcam = `wk192-cam-${id}.png`;
    fs.writeFileSync(path.join(env.uploadsDir, background), "x");
    fs.writeFileSync(path.join(env.uploadsDir, webcam), "x");
    await pool.query(
        `INSERT INTO stream_overlay_reference_backgrounds (stream_user_id, filename, width, height, opacity)
         VALUES ($1, $2, 1920, 1080, 0.7)`,
        [id, background]
    );
    await saveQueueSettings(id, { webcamImageUrl: `/uploads/${webcam}` });
    return { files: [background, webcam].map((name) => path.join(env.uploadsDir, name)) };
};

const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

beforeAll(async () => {
    await createTables();
    await pool.query("DELETE FROM stream_users WHERE email = $1", [adminEmail]);
    adminId = await insertUser(adminEmail);
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    fetchMock.mockClear();
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [createdIds]);
    await pool.end();
});

const revokedTokens = () =>
    fetchMock.mock.calls
        .filter(([url]) => String(url) === "https://id.twitch.tv/oauth2/revoke")
        .map(([, init]) => new URLSearchParams(String((init as RequestInit).body)).get("token"));

describe("DELETE /api/stream/account/me", () => {
    it("requires a session and the account password", async () => {
        const id = await insertUser(`guarded_${suffix}@example.com`);

        expect((await request(app).delete("/api/stream/account/me").send({ password })).status).toBe(401);
        const noPassword = await request(app)
            .delete("/api/stream/account/me")
            .set("Authorization", `Bearer ${sessionJwt(id)}`)
            .send({});
        expect(noPassword.status).toBe(403);
        const wrongPassword = await request(app)
            .delete("/api/stream/account/me")
            .set("Authorization", `Bearer ${sessionJwt(id)}`)
            .send({ password: "not-the-password" });
        expect(wrongPassword.status).toBe(403);

        expect((await remainingRows(id)).stream_users).toBe(1);
    });

    it("removes every row, uploaded file and provider token of the account", async () => {
        const email = `deleted_${suffix}@example.com`;
        const id = await insertUser(email);
        // A real login leaves a refresh-token row behind too.
        const login = await request(app).post("/api/stream/auth/login").send({ email, password });
        expect(login.status).toBe(200);
        const { files } = await seedAccount(id);

        const before = await remainingRows(id);
        for (const table of [
            "stream_sessions",
            "stream_refresh_tokens",
            "stream_twitch_links",
            "stream_donation_alerts_links",
            "stream_overlay_reference_backgrounds",
            "stream_queue_settings",
            "companion_activity_days",
            "quiz_viewer_scores",
        ]) {
            expect(before[table], table).toBeGreaterThan(0);
        }

        const res = await request(app)
            .delete("/api/stream/account/me")
            .set("Authorization", `Bearer ${sessionJwt(id)}`)
            .send({ password });
        expect(res.status).toBe(204);

        const after = await remainingRows(id);
        expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
        for (const file of files) expect(fs.existsSync(file)).toBe(false);
        expect(revokedTokens().sort()).toEqual([`access-${id}`, `refresh-${id}`]);
    });

    it("blocks signing in with the deleted email; registering again starts an empty account", async () => {
        const email = `reborn_${suffix}@example.com`;
        const id = await insertUser(email);
        await seedAccount(id);
        await request(app)
            .delete("/api/stream/account/me")
            .set("Authorization", `Bearer ${sessionJwt(id)}`)
            .send({ password })
            .expect(204);
        // Deletion shares the 1s/5-request test bucket with login/register.
        await new Promise((resolve) => setTimeout(resolve, 1100));

        expect((await request(app).post("/api/stream/auth/login").send({ email, password })).status).toBe(401);

        const registered = await request(app).post("/api/stream/auth/register").send({ email, password });
        expect(registered.status).toBe(201);
        const newId = Number(registered.body.user.id);
        createdIds.push(newId);
        expect(newId).not.toBe(id);
        const fresh = await remainingRows(newId);
        expect(Object.entries(fresh).filter(([table, n]) => table !== "stream_users" && table !== "stream_refresh_tokens" && n > 0)).toEqual([]);
    });
});

describe("DELETE /api/admin/users/:id", () => {
    it("is admin-only", async () => {
        const id = await insertUser(`target_${suffix}@example.com`);
        const other = await insertUser(`other_${suffix}@example.com`);
        expect((await request(app).delete(`/api/admin/users/${id}`)).status).toBe(401);
        expect(
            (await request(app).delete(`/api/admin/users/${id}`).set("Authorization", `Bearer ${sessionJwt(other)}`)).status
        ).toBe(403);
        expect((await remainingRows(id)).stream_users).toBe(1);
    });

    it("refuses to delete the admin's own account", async () => {
        const res = await request(app)
            .delete(`/api/admin/users/${adminId}`)
            .set("Authorization", `Bearer ${sessionJwt(adminId)}`)
            .send({ confirmEmail: adminEmail });
        expect(res.status).toBe(403);
        expect((await remainingRows(adminId)).stream_users).toBe(1);
    });

    it("requires the target's email as confirmation, then deletes everything", async () => {
        const email = `requested_${suffix}@example.com`;
        const id = await insertUser(email);
        const { files } = await seedAccount(id);
        const admin = (body: object) =>
            request(app).delete(`/api/admin/users/${id}`).set("Authorization", `Bearer ${sessionJwt(adminId)}`).send(body);

        expect((await admin({})).status).toBe(400);
        expect((await admin({ confirmEmail: "someone-else@example.com" })).status).toBe(400);
        expect((await remainingRows(id)).stream_users).toBe(1);

        expect((await admin({ confirmEmail: email.toUpperCase() })).status).toBe(204);
        expect(Object.entries(await remainingRows(id)).filter(([, n]) => n > 0)).toEqual([]);
        for (const file of files) expect(fs.existsSync(file)).toBe(false);
        expect(revokedTokens()).toContain(`access-${id}`);

        expect((await admin({ confirmEmail: email })).status).toBe(404);
    });
});

describe("disconnecting Twitch", () => {
    it("revokes the stored tokens at Twitch", async () => {
        const id = await insertUser(`disconnect_${suffix}@example.com`);
        await saveTwitchLink(
            id.toString(),
            { id: `tw-disc-${suffix}`, login: "s", display_name: "S", profile_image_url: "" },
            { access_token: "disc-access", refresh_token: "disc-refresh", expires_in: 3600 }
        );
        await disconnectTwitch(id.toString());
        expect(revokedTokens().sort()).toEqual(["disc-access", "disc-refresh"]);
        expect((await remainingRows(id)).stream_twitch_links).toBe(0);
    });
});
