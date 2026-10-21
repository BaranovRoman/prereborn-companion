import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";
import {
    ACTIVITY_RETENTION_DAYS,
    computeUsageStats,
    getPublicUsageStats,
    pruneActivity,
    recordCompanionHeartbeat,
    resetUsageStatsCacheForTests,
    toPublicUsageStats,
    type UsageStats,
} from "../services/usage-stats-service.js";

// WK-186 - Companion usage stats. Window tests run at fixed dates far in the
// future so rows written by other test files (at real "now") never fall into
// the windows being asserted.
const suffix = `${Date.now()}-usage-stats`;
const createdUserIds: number[] = [];

const createUser = async (label: string): Promise<number> => {
    const hashed = await bcrypt.hash("test-password-123", 4);
    const result = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [`usage_${label}_${suffix}@example.com`, hashed, randomUUID()]
    );
    createdUserIds.push(result.rows[0].id);
    return result.rows[0].id;
};

const sessionJwt = (streamUserId: number) =>
    jwt.sign({ streamUserId: streamUserId.toString() }, process.env.STREAM_JWT_SECRET!, {
        expiresIn: "5m",
    });

const activityRows = async (streamUserId: number) =>
    (
        await pool.query(
            `SELECT to_char(activity_date, 'YYYY-MM-DD') AS day, last_seen_at
               FROM companion_activity_days WHERE stream_user_id = $1 ORDER BY activity_date`,
            [streamUserId]
        )
    ).rows as { day: string; last_seen_at: Date }[];

beforeAll(async () => {
    await createTables();
});

beforeEach(() => {
    resetUsageStatsCacheForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [createdUserIds]);
    await pool.end();
});

describe("POST /api/stream/companion/heartbeat", () => {
    it("rejects requests without valid Companion auth and records nothing", async () => {
        expect((await request(app).post("/api/stream/companion/heartbeat")).status).toBe(401);
        expect(
            (
                await request(app)
                    .post("/api/stream/companion/heartbeat")
                    .set("Authorization", "Bearer not-a-real-token")
            ).status
        ).toBe(401);
        const forged = jwt.sign({ streamUserId: "1" }, "wrong-secret-wrong-secret-wrong-secret");
        expect(
            (
                await request(app)
                    .post("/api/stream/companion/heartbeat")
                    .set("Authorization", `Bearer ${forged}`)
            ).status
        ).toBe(401);
    });

    it("does not count a still-valid token of a deleted account", async () => {
        const userId = await createUser("deleted");
        const token = sessionJwt(userId);
        await pool.query("DELETE FROM stream_users WHERE id = $1", [userId]);

        const res = await request(app)
            .post("/api/stream/companion/heartbeat")
            .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
        expect(await activityRows(userId)).toHaveLength(0);
    });

    it("accepts both the session JWT and the legacy companion token", async () => {
        const userId = await createUser("auth");
        const legacy = (await regenerateCompanionToken(userId.toString()))!.token;

        const viaJwt = await request(app)
            .post("/api/stream/companion/heartbeat")
            .set("Authorization", `Bearer ${sessionJwt(userId)}`);
        const viaLegacy = await request(app)
            .post("/api/stream/companion/heartbeat")
            .set("Authorization", `Bearer ${legacy}`);

        expect(viaJwt.status).toBe(204);
        expect(viaLegacy.status).toBe(204);
        // Two "devices"/auth methods on one account, same day -> one row.
        expect(await activityRows(userId)).toHaveLength(1);
    });

    it("ignores any request body - nothing beyond the account id is stored", async () => {
        const userId = await createUser("body");
        const res = await request(app)
            .post("/api/stream/companion/heartbeat")
            .set("Authorization", `Bearer ${sessionJwt(userId)}`)
            .send({ hwid: "abc", chat: "secret", ip: "1.2.3.4" });
        expect(res.status).toBe(204);

        const columns = await pool.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'companion_activity_days' ORDER BY column_name`
        );
        expect(columns.rows.map((row) => row.column_name)).toEqual([
            "activity_date",
            "last_seen_at",
            "stream_user_id",
        ]);
    });
});

describe("recordCompanionHeartbeat", () => {
    it("deduplicates repeated heartbeats into one row per account per UTC day", async () => {
        const userId = await createUser("dedup");
        await recordCompanionHeartbeat(userId, new Date("2099-03-01T00:00:00Z"));
        await recordCompanionHeartbeat(userId, new Date("2099-03-01T10:15:00Z"));
        await recordCompanionHeartbeat(userId, new Date("2099-03-01T23:59:59Z"));
        // Out-of-order delivery never moves last_seen_at backwards.
        await recordCompanionHeartbeat(userId, new Date("2099-03-01T05:00:00Z"));
        await recordCompanionHeartbeat(userId, new Date("2099-03-02T00:00:01Z"));

        const rows = await activityRows(userId);
        expect(rows.map((row) => row.day)).toEqual(["2099-03-01", "2099-03-02"]);
        expect(new Date(rows[0].last_seen_at).toISOString()).toBe("2099-03-01T23:59:59.000Z");
    });

    it("prunes rows older than the retention window", async () => {
        const userId = await createUser("prune");
        const now = new Date("2099-12-31T12:00:00Z");
        const old = new Date(now.getTime() - (ACTIVITY_RETENTION_DAYS + 1) * 86_400_000);
        const kept = new Date(now.getTime() - (ACTIVITY_RETENTION_DAYS - 1) * 86_400_000);
        await recordCompanionHeartbeat(userId, old);
        await recordCompanionHeartbeat(userId, kept);

        await pruneActivity(now);
        expect((await activityRows(userId)).map((row) => row.day)).toEqual([
            kept.toISOString().slice(0, 10),
        ]);
    });
});

describe("computeUsageStats", () => {
    it("counts distinct accounts in exact rolling 24h / 7d / 30d windows", async () => {
        const now = new Date("2098-06-15T12:00:00Z");
        const [a, b, c, d, e] = await Promise.all(
            ["win-a", "win-b", "win-c", "win-d", "win-e"].map(createUser)
        );
        await recordCompanionHeartbeat(a, new Date("2098-06-15T01:00:00Z")); // all windows
        await recordCompanionHeartbeat(a, new Date("2098-06-15T11:45:00Z")); // repeat, same account
        await recordCompanionHeartbeat(b, new Date("2098-06-14T11:59:00Z")); // 24h01m ago -> 7d/30d
        await recordCompanionHeartbeat(c, new Date("2098-06-08T12:01:00Z")); // 6d23h59m ago -> 7d/30d
        await recordCompanionHeartbeat(d, new Date("2098-05-20T08:00:00Z")); // 30d only
        await recordCompanionHeartbeat(e, new Date("2098-05-16T11:59:00Z")); // 30d01m ago -> none

        const stats = await computeUsageStats(now);
        expect(stats.dau).toBe(1);
        expect(stats.wau).toBe(3);
        expect(stats.mau).toBe(4);
    });

    it("averages DAU over the last 30 full UTC calendar days, excluding today", async () => {
        const now = new Date("2097-06-15T12:00:00Z");
        const [a, b] = await Promise.all(["avg-a", "avg-b"].map(createUser));
        await recordCompanionHeartbeat(a, new Date("2097-05-16T00:00:00Z")); // first day in range
        await recordCompanionHeartbeat(a, new Date("2097-05-16T22:00:00Z")); // same day, no double count
        await recordCompanionHeartbeat(a, new Date("2097-06-01T10:00:00Z"));
        await recordCompanionHeartbeat(b, new Date("2097-06-01T11:00:00Z"));
        await recordCompanionHeartbeat(b, new Date("2097-06-14T23:59:59Z")); // last day in range
        await recordCompanionHeartbeat(a, new Date("2097-05-15T23:59:59Z")); // before range
        await recordCompanionHeartbeat(b, new Date("2097-06-15T00:00:00Z")); // today, excluded

        const stats = await computeUsageStats(now);
        expect(stats.averageDauFrom).toBe("2097-05-16");
        expect(stats.averageDauTo).toBe("2097-06-14");
        // 4 account-days / 30 days = 0.133 -> 0.1
        expect(stats.averageDau30d).toBe(0.1);
    });

    it("counts registered accounts, and accounts without heartbeats are never active", async () => {
        const before = await computeUsageStats(new Date("2096-01-01T00:00:00Z"));
        await createUser("old-client"); // e.g. an old Companion that never sends heartbeats
        const after = await computeUsageStats(new Date("2096-01-01T00:00:00Z"));
        expect(after.registeredUsers).toBe(before.registeredUsers + 1);
        expect(after.mau).toBe(before.mau);
        expect(after.dau).toBe(before.dau);
    });
});

describe("public usage stats", () => {
    const baseStats: UsageStats = {
        registeredUsers: 10,
        dau: 2,
        wau: 4,
        mau: 6,
        averageDau30d: 1.5,
        averageDauFrom: "2099-01-01",
        averageDauTo: "2099-01-30",
        trackingSince: "2099-01-01",
        trackedFullDays: 30,
        generatedAt: "2099-01-31T00:00:00.000Z",
    };

    it("exposes only registered/7d/30d aggregates and a readiness flag", () => {
        expect(toPublicUsageStats(baseStats)).toEqual({
            registeredUsers: 10,
            activeUsers7d: 4,
            activeUsers30d: 6,
            ready: true,
            generatedAt: "2099-01-31T00:00:00.000Z",
        });
    });

    it("is not ready until 30 full days of heartbeats are collected", () => {
        expect(toPublicUsageStats({ ...baseStats, trackedFullDays: 29 }).ready).toBe(false);
        expect(toPublicUsageStats({ ...baseStats, trackingSince: null, trackedFullDays: 0 }).ready).toBe(false);
    });

    it("GET /api/public/usage-stats returns aggregates without personal data", async () => {
        const userId = await createUser("public");
        await recordCompanionHeartbeat(userId);

        const res = await request(app).get("/api/public/usage-stats");
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
            ["activeUsers30d", "activeUsers7d", "generatedAt", "ready", "registeredUsers"]
        );
        expect(res.headers["cache-control"]).toBe("public, max-age=300");
        expect(JSON.stringify(res.body)).not.toContain("@example.com");
        expect(res.body.activeUsers30d).toBeGreaterThanOrEqual(1);
    });

    it("caches the aggregate and serves the cached value when the database fails", async () => {
        const now = new Date();
        const first = await getPublicUsageStats(now);

        const spy = vi.spyOn(pool, "query").mockRejectedValue(new Error("db down"));
        // Within TTL: no query at all.
        expect(await getPublicUsageStats(new Date(now.getTime() + 60_000))).toEqual(first);
        expect(spy).not.toHaveBeenCalled();
        // TTL expired and refresh fails: stale value, never zeros.
        expect(await getPublicUsageStats(new Date(now.getTime() + 10 * 60_000))).toEqual(first);
        expect(spy).toHaveBeenCalled();
    });

    it("responds 503 (not zeros) when stats were never computed and the database fails", async () => {
        vi.spyOn(pool, "query").mockRejectedValue(new Error("db down"));
        const res = await request(app).get("/api/public/usage-stats");
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Статистика временно недоступна" });
        expect(res.headers["cache-control"]).toBe("no-store");
    });
});

describe("GET /api/admin/usage-stats", () => {
    it("is admin-only", async () => {
        expect((await request(app).get("/api/admin/usage-stats")).status).toBe(401);
        const userId = await createUser("not-admin");
        const res = await request(app)
            .get("/api/admin/usage-stats")
            .set("Authorization", `Bearer ${sessionJwt(userId)}`);
        expect(res.status).toBe(403);
    });

    it("returns DAU and the 30-day average DAU for admins", async () => {
        const adminEmail = process.env.ADMIN_EMAILS!.split(",")[0];
        const existing = await pool.query("SELECT id FROM stream_users WHERE email = $1", [adminEmail]);
        let adminId: number = existing.rows[0]?.id;
        if (!adminId) {
            const created = await pool.query(
                `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, 'x', $2) RETURNING id`,
                [adminEmail, randomUUID()]
            );
            adminId = created.rows[0].id;
            createdUserIds.push(adminId);
        }

        const res = await request(app)
            .get("/api/admin/usage-stats")
            .set("Authorization", `Bearer ${sessionJwt(adminId)}`);
        expect(res.status).toBe(200);
        for (const key of ["registeredUsers", "dau", "wau", "mau", "averageDau30d", "trackingSince"]) {
            expect(res.body).toHaveProperty(key);
        }
    });
});
