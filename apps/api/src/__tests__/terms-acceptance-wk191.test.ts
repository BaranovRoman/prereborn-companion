import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { termsConfig } from "../config/legal.js";

// WK-191 - explicit acceptance of the user agreement: recorded at
// registration, asked from accounts created before publication (on the site
// and in Companion), never blocking sign-out or deletion.
const suffix = `${Date.now()}-wk191`;
const password = "test-password-123";
const createdIds: number[] = [];
let emailCounter = 0;
const VERSION = "2026-11-01";

const bearer = (streamUserId: number) => ({
    Authorization: `Bearer ${jwt.sign({ streamUserId: streamUserId.toString() }, process.env.STREAM_JWT_SECRET!, { expiresIn: "5m" })}`,
});

// The auth endpoints share a per-IP limiter; each call here gets its own IP
// (trust proxy is on) so the file's calls don't throttle each other.
let ipCounter = 0;
const ip = () => ({ "X-Forwarded-For": `10.191.0.${++ipCounter}` });

const newEmail = () => `terms_${suffix}_${++emailCounter}@example.com`;

const insertUser = async (): Promise<number> => {
    const result = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [newEmail(), await bcrypt.hash(password, 4), randomUUID()]
    );
    createdIds.push(result.rows[0].id);
    return result.rows[0].id;
};

const acceptance = async (id: number) =>
    (await pool.query<{ terms_accepted_version: string | null; terms_accepted_at: Date | null }>(
        "SELECT terms_accepted_version, terms_accepted_at FROM stream_users WHERE id = $1",
        [id]
    )).rows[0];

beforeAll(async () => {
    await createTables();
});

afterEach(() => {
    termsConfig.currentVersion = null;
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [createdIds]);
    await pool.end();
});

describe("while the agreement is unpublished", () => {
    it("asks nobody and refuses to record acceptance of a draft", async () => {
        const id = await insertUser();
        const me = await request(app).get("/api/stream/account/me").set(bearer(id));
        expect(me.body.terms).toMatchObject({ currentVersion: null, acceptanceRequired: false });

        const accept = await request(app).post("/api/stream/account/me/terms/accept").set(bearer(id)).send({ version: VERSION });
        expect(accept.status).toBe(409);
        expect((await acceptance(id)).terms_accepted_version).toBeNull();
    });

    it("registers without recording anything", async () => {
        const res = await request(app).post("/api/stream/auth/register").set(ip()).send({ email: newEmail(), password, acceptedTermsVersion: VERSION });
        expect(res.status).toBe(201);
        createdIds.push(Number(res.body.user.id));
        expect((await acceptance(Number(res.body.user.id))).terms_accepted_version).toBeNull();
    });
});

describe("once published", () => {
    it("records acceptance at registration only for the edition in force", async () => {
        termsConfig.currentVersion = VERSION;
        const current = await request(app).post("/api/stream/auth/register").set(ip()).send({ email: newEmail(), password, acceptedTermsVersion: VERSION });
        createdIds.push(Number(current.body.user.id));
        const row = await acceptance(Number(current.body.user.id));
        expect(row.terms_accepted_version).toBe(VERSION);
        expect(row.terms_accepted_at).toBeInstanceOf(Date);

        // A cached page that showed an older edition, or an old client that sends nothing.
        for (const body of [{ acceptedTermsVersion: "2026-01-01" }, {}]) {
            const res = await request(app).post("/api/stream/auth/register").set(ip()).send({ email: newEmail(), password, ...body });
            expect(res.status).toBe(201);
            createdIds.push(Number(res.body.user.id));
            expect((await acceptance(Number(res.body.user.id))).terms_accepted_version).toBeNull();
        }
    });

    it("asks an account created before publication on the site until it accepts", async () => {
        const id = await insertUser();
        termsConfig.currentVersion = VERSION;

        const before = await request(app).get("/api/stream/account/me").set(bearer(id));
        expect(before.body.terms).toMatchObject({ currentVersion: VERSION, acceptedVersion: null, acceptanceRequired: true });

        const stale = await request(app).post("/api/stream/account/me/terms/accept").set(bearer(id)).send({ version: "2026-01-01" });
        expect(stale.status).toBe(409);

        const accept = await request(app).post("/api/stream/account/me/terms/accept").set(bearer(id)).send({ version: VERSION });
        expect(accept.status).toBe(200);
        expect(accept.body).toMatchObject({ acceptedVersion: VERSION, acceptanceRequired: false });

        const after = await request(app).get("/api/stream/account/me").set(bearer(id));
        expect(after.body.terms.acceptanceRequired).toBe(false);
    });

    it("keeps the first acceptance time when the same edition is accepted again", async () => {
        const id = await insertUser();
        termsConfig.currentVersion = VERSION;
        await request(app).post("/api/stream/account/me/terms/accept").set(bearer(id)).send({ version: VERSION });
        const first = (await acceptance(id)).terms_accepted_at;
        await request(app).post("/api/stream/account/me/terms/accept").set(bearer(id)).send({ version: VERSION });
        expect((await acceptance(id)).terms_accepted_at).toEqual(first);
    });

    it("asks again for a new edition", async () => {
        const id = await insertUser();
        termsConfig.currentVersion = VERSION;
        await request(app).post("/api/stream/account/me/terms/accept").set(bearer(id)).send({ version: VERSION });
        termsConfig.currentVersion = "2027-01-01";
        const me = await request(app).get("/api/stream/account/me").set(bearer(id));
        expect(me.body.terms).toMatchObject({ acceptedVersion: VERSION, acceptanceRequired: true });
    });

    it("lets a Companion-only user read the status and accept with the Companion session", async () => {
        const id = await insertUser();
        termsConfig.currentVersion = VERSION;

        const status = await request(app).get("/api/stream/companion/terms").set(bearer(id));
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({ currentVersion: VERSION, acceptanceRequired: true });

        const accept = await request(app).post("/api/stream/companion/terms/accept").set(bearer(id)).send({ version: VERSION });
        expect(accept.status).toBe(200);
        expect((await acceptance(id)).terms_accepted_version).toBe(VERSION);

        expect((await request(app).get("/api/stream/companion/terms")).status).toBe(401);
    });

    it("does not block sign-out, deletion or Companion while not accepted", async () => {
        const id = await insertUser();
        termsConfig.currentVersion = VERSION;

        const heartbeat = await request(app).post("/api/stream/companion/heartbeat").set(bearer(id)).send({ appVersion: "1.0.0" });
        expect(heartbeat.status).toBeLessThan(400);

        const login = await request(app).post("/api/stream/auth/login").set(ip()).send({
            email: (await pool.query("SELECT email FROM stream_users WHERE id = $1", [id])).rows[0].email,
            password,
        });
        expect(login.status).toBe(200);
        expect((await request(app).post("/api/stream/auth/logout").send({ refreshToken: login.body.refreshToken })).status).toBeLessThan(400);

        const deleted = await request(app).delete("/api/stream/account/me").set(bearer(id)).set(ip()).send({ password });
        expect(deleted.status).toBeLessThan(300);
        expect((await pool.query("SELECT 1 FROM stream_users WHERE id = $1", [id])).rowCount).toBe(0);
    });
});
