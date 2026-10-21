import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { recordCompanionHeartbeat, resetUsageStatsCacheForTests } from "../services/usage-stats-service.js";

// WK-189 - minimal account page + /admin users screen. ADMIN_EMAILS is
// pinned to admin_wk52_test@example.com in vitest.config.ts.
const suffix = `${Date.now()}-wk189`;
const adminEmail = "admin_wk52_test@example.com";
const plainEmail = `plain_${suffix}@example.com`;
const activeEmail = `active_${suffix}@example.com`;
const password = "test-password-123";

let adminId: number;
let plainId: number;
let activeId: number;

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
    return result.rows[0].id;
};

beforeAll(async () => {
    await createTables();
    // A previous aborted run may have left the pinned admin row behind.
    await pool.query("DELETE FROM stream_users WHERE email = $1", [adminEmail]);
    adminId = await insertUser(adminEmail);
    plainId = await insertUser(plainEmail);
    activeId = await insertUser(activeEmail);
    await recordCompanionHeartbeat(activeId);
});

beforeEach(() => {
    resetUsageStatsCacheForTests();
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [[adminId, plainId, activeId]]);
    await pool.end();
});

describe("GET /api/stream/account/me isAdmin", () => {
    it("is false for an ordinary user and true for an allowlisted admin", async () => {
        const plain = await request(app)
            .get("/api/stream/account/me")
            .set("Authorization", `Bearer ${sessionJwt(plainId)}`);
        expect(plain.status).toBe(200);
        expect(plain.body.isAdmin).toBe(false);

        const admin = await request(app)
            .get("/api/stream/account/me")
            .set("Authorization", `Bearer ${sessionJwt(adminId)}`);
        expect(admin.body.isAdmin).toBe(true);
    });

    it("rejects a guest", async () => {
        expect((await request(app).get("/api/stream/account/me")).status).toBe(401);
    });
});

describe("/admin access is enforced by the backend", () => {
    const adminEndpoints = ["/api/admin/users", "/api/admin/usage-stats", "/api/admin/users/1"];

    it.each(adminEndpoints)("%s: 401 for a guest, 403 for an ordinary user", async (path) => {
        expect((await request(app).get(path)).status).toBe(401);
        expect(
            (await request(app).get(path).set("Authorization", `Bearer ${sessionJwt(plainId)}`)).status
        ).toBe(403);
    });

    it("a forged token is not an admin token", async () => {
        const forged = jwt.sign({ streamUserId: adminId.toString() }, "wrong-secret-wrong-secret-wrong-secret");
        expect(
            (await request(app).get("/api/admin/users").set("Authorization", `Bearer ${forged}`)).status
        ).toBe(401);
    });

    it("the public stats endpoint exposes aggregates only, never a user list", async () => {
        const res = await request(app).get("/api/public/usage-stats");
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
            ["activeUsers30d", "activeUsers7d", "generatedAt", "registeredUsers", "trackingSince"].sort()
        );
        expect(JSON.stringify(res.body)).not.toContain("@");
    });
});

describe("admin users list (WK-189 fields)", () => {
    const list = (query: Record<string, string | number> = {}) =>
        request(app).get("/api/admin/users").query(query).set("Authorization", `Bearer ${sessionJwt(adminId)}`);

    it("shows Companion activity, admin flag and legacy-token state", async () => {
        const active = await list({ q: activeEmail });
        expect(active.body.users[0]).toMatchObject({
            email: activeEmail,
            activeDays30d: 1,
            legacyTokenConfigured: false,
            isAdmin: false,
        });
        expect(active.body.users[0].lastCompanionActivityAt).toBeTruthy();

        const plain = await list({ q: plainEmail });
        expect(plain.body.users[0]).toMatchObject({ activeDays30d: 0, lastCompanionActivityAt: null });

        const admin = await list({ q: adminEmail });
        expect(admin.body.users[0].isAdmin).toBe(true);
    });

    it("never leaks password or token hashes", async () => {
        const res = await list();
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toMatch(/password|hash/i);
    });

    it("sorts by last Companion activity with inactive accounts last", async () => {
        const res = await list({ sort: "activity_desc", pageSize: 50 });
        expect(res.status).toBe(200);
        const seen = res.body.users.map((u: { lastCompanionActivityAt: string | null }) => u.lastCompanionActivityAt);
        const firstNull = seen.indexOf(null);
        if (firstNull >= 0) expect(seen.slice(firstNull).every((v: string | null) => v === null)).toBe(true);
        expect(res.body.users.findIndex((u: { id: string }) => u.id === activeId.toString())).toBeLessThan(
            res.body.users.findIndex((u: { id: string }) => u.id === plainId.toString())
        );
    });

    it("rejects an unknown sort key instead of interpolating it", async () => {
        expect((await list({ sort: "u.id; DROP TABLE stream_users" })).status).toBe(400);
    });

    it("total, admin stats and public stats all match COUNT(*) of stream_users", async () => {
        const dbCount = (await pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM stream_users")).rows[0]
            .count;
        expect((await list()).body.total).toBe(dbCount);

        const adminStats = await request(app)
            .get("/api/admin/usage-stats")
            .set("Authorization", `Bearer ${sessionJwt(adminId)}`);
        expect(adminStats.body.registeredUsers).toBe(dbCount);

        expect((await request(app).get("/api/public/usage-stats")).body.registeredUsers).toBe(dbCount);
    });
});

describe("Companion connection credentials", () => {
    it("the current Companion sign-in (email/password session) authenticates Companion routes", async () => {
        const login = await request(app).post("/api/stream/auth/login").send({ email: plainEmail, password });
        expect(login.status).toBe(200);
        const heartbeat = await request(app)
            .post("/api/stream/companion/heartbeat")
            .set("Authorization", `Bearer ${login.body.accessToken}`);
        expect(heartbeat.status).toBe(204);
    });

    it("a revoked legacy token stops working; the session keeps working", async () => {
        const auth = { Authorization: `Bearer ${sessionJwt(plainId)}` };
        const issued = await request(app).post("/api/stream/account/me/companion-token/regenerate").set(auth);
        const legacyToken = issued.body.token as string;
        expect(
            (await request(app).post("/api/stream/companion/heartbeat").set("Authorization", `Bearer ${legacyToken}`))
                .status
        ).toBe(204);

        const revoked = await request(app).delete("/api/stream/account/me/companion-token").set(auth);
        expect(revoked.status).toBe(200);
        expect(revoked.body.companionTokenConfigured).toBe(false);
        expect(revoked.body.companionTokenCreatedAt).toBeNull();
        expect(JSON.stringify(revoked.body)).not.toContain(legacyToken);

        expect(
            (await request(app).post("/api/stream/companion/heartbeat").set("Authorization", `Bearer ${legacyToken}`))
                .status
        ).toBe(401);
        expect((await request(app).post("/api/stream/companion/heartbeat").set(auth)).status).toBe(204);
    });

    it("revoking requires a signed-in user", async () => {
        expect((await request(app).delete("/api/stream/account/me/companion-token")).status).toBe(401);
    });
});

describe("integration callbacks land on the new account page", () => {
    it("Twitch callback redirects to /account", async () => {
        const res = await request(app).get("/api/stream/integrations/twitch/callback");
        expect(res.status).toBe(302);
        expect(new URL(res.headers.location).pathname).toBe("/account");
        expect(new URL(res.headers.location).searchParams.get("twitch")).toBe("error");
    });
});
