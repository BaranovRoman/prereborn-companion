import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";

// ADMIN_EMAILS в vitest.config.ts зафиксирован как admin_wk52_test@example.com -
// только пользователь с этим email становится администратором (requireAdmin).
const suffix = `${Date.now()}-admin-wk52`;
const adminEmail = "admin_wk52_test@example.com";
const plainEmail = `plain_${suffix}@example.com`;
const targetEmail = `target_${suffix}@example.com`;

let adminUserId: number;
let plainUserId: number;
let targetUserId: number;
let adminToken: string;
let plainToken: string;

const signToken = (streamUserId: number) =>
    jwt.sign({ streamUserId: streamUserId.toString() }, process.env.STREAM_JWT_SECRET!, {
        expiresIn: "5m",
    });

beforeAll(async () => {
    await createTables();
    const hashed = await bcrypt.hash("test-password-123", 10);

    const admin = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [adminEmail, hashed, randomUUID()]
    );
    adminUserId = admin.rows[0].id;

    const plain = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [plainEmail, hashed, randomUUID()]
    );
    plainUserId = plain.rows[0].id;

    // Целевой пользователь - с активной сессией, Steam-привязкой и
    // companion-токеном, чтобы проверить и полезные поля, и отсутствие
    // чувствительных данных в admin-ответах.
    const target = await pool.query(
        `INSERT INTO stream_users
            (email, password_hash, public_token, steam_id64, dota_account_id, steam_connected_at,
             companion_token_hash, companion_token_created_at)
         VALUES ($1, $2, $3, '76500000000000001', 123456, CURRENT_TIMESTAMP, 'fakehash', CURRENT_TIMESTAMP)
         RETURNING id`,
        [targetEmail, hashed, randomUUID()]
    );
    targetUserId = target.rows[0].id;
    await pool.query(`INSERT INTO stream_sessions (stream_user_id) VALUES ($1)`, [targetUserId]);

    adminToken = signToken(adminUserId);
    plainToken = signToken(plainUserId);
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [
        [adminUserId, plainUserId, targetUserId],
    ]);
    await pool.end();
});

describe("admin users API authorization", () => {
    it("denies unauthenticated requests", async () => {
        const res = await request(app).get("/api/admin/users");
        expect(res.status).toBe(401);
    });

    it("denies an ordinary authenticated user", async () => {
        const res = await request(app)
            .get("/api/admin/users")
            .set("Authorization", `Bearer ${plainToken}`);
        expect(res.status).toBe(403);
    });

    it("allows the administrator", async () => {
        const res = await request(app)
            .get("/api/admin/users")
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.users)).toBe(true);
    });
});

describe("admin users listing/search", () => {
    it("finds the target user by email substring", async () => {
        const res = await request(app)
            .get("/api/admin/users")
            .query({ q: targetEmail })
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.users[0].email).toBe(targetEmail);
        expect(res.body.users[0].steamConnected).toBe(true);
        expect(res.body.users[0].activeSessionStartedAt).toBeTruthy();
    });

    it("returns an empty page for a query that matches nobody", async () => {
        const res = await request(app)
            .get("/api/admin/users")
            .query({ q: `nobody-${suffix}` })
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(0);
        expect(res.body.users).toEqual([]);
    });

    it("bounds pageSize even if a huge value is requested", async () => {
        const res = await request(app)
            .get("/api/admin/users")
            .query({ pageSize: 5000 })
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.pageSize).toBeLessThanOrEqual(50);
    });
});

describe("admin user detail", () => {
    it("returns useful fields without sensitive data", async () => {
        const res = await request(app)
            .get(`/api/admin/users/${targetUserId}`)
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(targetEmail);
        expect(res.body.steam).toMatchObject({ steamId64: "76500000000000001" });
        expect(res.body.companionTokenConfigured).toBe(true);
        expect(res.body.latestSession).toBeTruthy();

        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toMatch(/password/i);
        expect(serialized).not.toMatch(/fakehash/);
        expect(res.body).not.toHaveProperty("passwordHash");
        expect(res.body.user).toBeUndefined();
    });

    it("404s for an unknown user id", async () => {
        const res = await request(app)
            .get("/api/admin/users/0")
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(404);
    });

    it("denies detail access to an ordinary user", async () => {
        const res = await request(app)
            .get(`/api/admin/users/${targetUserId}`)
            .set("Authorization", `Bearer ${plainToken}`);
        expect(res.status).toBe(403);
    });
});

describe("admin mutations", () => {
    it("denies session end / onboarding reset for an ordinary user", async () => {
        const endRes = await request(app)
            .post(`/api/admin/users/${targetUserId}/session/end`)
            .set("Authorization", `Bearer ${plainToken}`);
        expect(endRes.status).toBe(403);

        const resetRes = await request(app)
            .post(`/api/admin/users/${targetUserId}/onboarding/reset`)
            .set("Authorization", `Bearer ${plainToken}`);
        expect(resetRes.status).toBe(403);
    });

    it("ends the target user's active session", async () => {
        const res = await request(app)
            .post(`/api/admin/users/${targetUserId}/session/end`)
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.endedAt).toBeTruthy();

        const again = await request(app)
            .post(`/api/admin/users/${targetUserId}/session/end`)
            .set("Authorization", `Bearer ${adminToken}`);
        expect(again.status).toBe(409);
    });

    it("resets onboarding state", async () => {
        await pool.query(
            `UPDATE stream_users SET onboarding_completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [targetUserId]
        );

        const res = await request(app)
            .post(`/api/admin/users/${targetUserId}/onboarding/reset`)
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.onboardingCompletedAt).toBeNull();
    });
});
