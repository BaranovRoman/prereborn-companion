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
import { deleteStreamUserAccount } from "../services/account-deletion-service.js";
import {
    getCleanupStats,
    processPendingCleanups,
    startPendingCleanupSweeper,
} from "../services/pending-cleanup-service.js";
import { logger } from "../utils/logger.js";

// WK-192 - account deletion: self-service with a password, admin action for
// requests that come in by email, and the out-of-database cleanup (files,
// Twitch tokens) that has to survive failures. ADMIN_EMAILS is pinned to
// admin_wk52_test@example.com in vitest.config.ts.
const suffix = `${Date.now()}-wk192`;
const adminEmail = "admin_wk52_test@example.com";
const password = "test-password-123";
const createdIds: number[] = [];
const seededSessionIds: number[] = [];
let adminId: number;
let emailCounter = 0;

const sessionJwt = (streamUserId: number) =>
    jwt.sign({ streamUserId: streamUserId.toString() }, process.env.STREAM_JWT_SECRET!, {
        expiresIn: "5m",
    });
const bearer = (streamUserId: number) => ({ Authorization: `Bearer ${sessionJwt(streamUserId)}` });

const insertUser = async (email = `user_${suffix}_${++emailCounter}@example.com`): Promise<number> => {
    const hashed = await bcrypt.hash(password, 4);
    const result = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    createdIds.push(result.rows[0].id);
    return result.rows[0].id;
};

// Every table that carries stream_user_id - discovered, not listed, so a
// new table is covered automatically - plus the tables that reach an
// account only through stream_sessions / quiz_rounds.
const remainingRows = async (streamUserId: number) => {
    const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name = 'stream_user_id'`
    );
    const counts: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
        const result = await pool.query(
            `SELECT COUNT(*)::int AS n FROM ${table_name} WHERE stream_user_id = $1`,
            [streamUserId]
        );
        counts[table_name] = result.rows[0].n;
    }
    const bySession = async (table: string) =>
        (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE stream_session_id = ANY($1::int[])`, [
            seededSessionIds,
        ])).rows[0].n;
    counts.quiz_viewer_scores = await bySession("quiz_viewer_scores");
    counts.quiz_answers = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM quiz_answers WHERE twitch_viewer_id = $1`,
        [`viewer-${suffix}-${streamUserId}`]
    )).rows[0].n;
    counts.stream_users = (await pool.query("SELECT COUNT(*)::int AS n FROM stream_users WHERE id = $1", [
        streamUserId,
    ])).rows[0].n;
    return counts;
};
const leftovers = async (streamUserId: number) =>
    Object.entries(await remainingRows(streamUserId)).filter(([, n]) => n > 0);

const pendingCleanups = async (streamUserId: number) =>
    (await pool.query<{ kind: string; attempts: number; payload: string; gave_up: boolean }>(
        `SELECT kind, attempts, payload, gave_up_at IS NOT NULL AS gave_up
           FROM pending_data_cleanups WHERE subject_id = $1 ORDER BY id`,
        [streamUserId]
    )).rows;

let questionId: number;

// Seeds the rows a real streamer accumulates, two uploaded files and a
// Twitch + DonationAlerts link.
const seedAccount = async (streamUserId: number) => {
    const id = streamUserId.toString();
    const session = (await getOrCreateActiveSession(id))!;
    seededSessionIds.push(Number(session.id));
    const viewer = `viewer-${suffix}-${id}`;
    await pool.query(
        `INSERT INTO quiz_viewer_scores (stream_session_id, twitch_viewer_id, twitch_display_name, score)
         VALUES ($1, $2, 'viewer', 3)`,
        [session.id, viewer]
    );
    const round = await pool.query(
        `INSERT INTO quiz_rounds (stream_user_id, stream_session_id, question_id, state)
         VALUES ($1, $2, $3, 'completed') RETURNING id`,
        [id, session.id, questionId]
    );
    await pool.query(
        `INSERT INTO quiz_answers (round_id, twitch_viewer_id, twitch_display_name, selected_option_ids, is_correct)
         VALUES ($1, $2, 'viewer', '[]', true)`,
        [round.rows[0].id, viewer]
    );
    await pool.query(
        `INSERT INTO stream_matches (stream_user_id, match_key, hero_id, kills, deaths, assists, result, started_at, ended_at)
         VALUES ($1, $2, 1, 1, 1, 1, 'win', NOW(), NOW())`,
        [id, `wk192-${id}`]
    );
    await pool.query(
        `INSERT INTO stream_match_events (stream_user_id, stream_session_id, match_id, hero_id, is_win, match_started_at)
         VALUES ($1, $2, $3, 1, true, NOW())`,
        [id, session.id, Number(id)]
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
    await pool.query(
        `INSERT INTO stream_donation_alerts_donations (donation_id, stream_user_id, username, amount, currency, message)
         VALUES ($1, $2, 'donor', 100, 'RUB', 'hi')`,
        [Number(id) * 1000 + 1, id]
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

// A fake of the two Twitch endpoints the cleanup uses. Default: revoke
// succeeds, and the refresh token is already dead (as it should be once the
// access token is revoked). This is a mock - it proves what we SEND and how
// we react to documented responses, not that Twitch really revokes.
const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type FakeTwitch = { revoke: (token: string) => Response; token: (refreshToken: string) => Response };
const defaultTwitch: FakeTwitch = {
    revoke: () => new Response(null, { status: 200 }),
    token: () => jsonResponse(400, { status: 400, message: "Invalid refresh token" }),
};
let twitch: FakeTwitch = defaultTwitch;
const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    if (String(url) === "https://id.twitch.tv/oauth2/revoke") return twitch.revoke(body.get("token") ?? "");
    if (String(url) === "https://id.twitch.tv/oauth2/token") return twitch.token(body.get("refresh_token") ?? "");
    return new Response(null, { status: 404 });
});
const bodiesFor = (endpoint: string) =>
    fetchMock.mock.calls
        .filter(([url]) => String(url) === `https://id.twitch.tv/oauth2/${endpoint}`)
        .map(([, init]) => new URLSearchParams(String(init?.body)));
const revokedTokens = () => bodiesFor("revoke").map((body) => body.get("token"));
const redeemedRefreshTokens = () => bodiesFor("token").map((body) => body.get("refresh_token"));

beforeAll(async () => {
    await createTables();
    await pool.query("DELETE FROM stream_users WHERE email = $1", [adminEmail]);
    adminId = await insertUser(adminEmail);
    const question = await pool.query(
        `INSERT INTO quiz_questions (category, prompt, is_active) VALUES ('wk192', 'test', false) RETURNING id`
    );
    questionId = question.rows[0].id;
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    fetchMock.mockClear();
    twitch = defaultTwitch;
    vi.restoreAllMocks();
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [createdIds]);
    await pool.query("DELETE FROM pending_data_cleanups WHERE subject_id = ANY($1::int[])", [createdIds]);
    await pool.query("DELETE FROM quiz_questions WHERE id = $1", [questionId]);
    await pool.end();
});

describe("schema", () => {
    it("every foreign key to stream_users cascades", async () => {
        const result = await pool.query<{ table_name: string; delete_rule: string }>(
            `SELECT kcu.table_name, rc.delete_rule
               FROM information_schema.referential_constraints rc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
              WHERE ccu.table_name = 'stream_users' AND rc.constraint_schema = current_schema()`
        );
        expect(result.rows.length).toBeGreaterThan(10);
        expect(result.rows.filter((row) => row.delete_rule !== "CASCADE")).toEqual([]);
    });
});

describe("DELETE /api/stream/account/me", () => {
    it("requires a session and the account password", async () => {
        const id = await insertUser();

        expect((await request(app).delete("/api/stream/account/me").send({ password })).status).toBe(401);
        expect((await request(app).delete("/api/stream/account/me").set(bearer(id)).send({})).status).toBe(403);
        const wrong = await request(app).delete("/api/stream/account/me").set(bearer(id)).send({ password: "nope" });
        expect(wrong.status).toBe(403);

        expect((await remainingRows(id)).stream_users).toBe(1);
    });

    it("removes every row, uploaded file and provider token of the account", async () => {
        const email = `deleted_${suffix}@example.com`;
        const id = await insertUser(email);
        // A real login leaves a refresh-token row behind too.
        expect((await request(app).post("/api/stream/auth/login").send({ email, password })).status).toBe(200);
        const { files } = await seedAccount(id);

        const before = await remainingRows(id);
        for (const table of [
            "stream_sessions",
            "stream_refresh_tokens",
            "stream_matches",
            "stream_match_events",
            "stream_twitch_links",
            "stream_donation_alerts_links",
            "stream_donation_alerts_donations",
            "stream_overlay_reference_backgrounds",
            "stream_queue_settings",
            "companion_activity_days",
            "quiz_rounds",
            "quiz_answers",
            "quiz_viewer_scores",
        ]) {
            expect(before[table], table).toBeGreaterThan(0);
        }

        const res = await request(app).delete("/api/stream/account/me").set(bearer(id)).send({ password });
        expect(res.status).toBe(204);

        expect(await leftovers(id)).toEqual([]);
        for (const file of files) expect(fs.existsSync(file)).toBe(false);
        expect(revokedTokens()).toEqual([`access-${id}`]);
        // The refresh token is checked to be dead, not assumed dead.
        expect(redeemedRefreshTokens()).toEqual([`refresh-${id}`]);
        const [revoke] = bodiesFor("revoke");
        expect(Object.fromEntries(revoke)).toEqual({ client_id: "test-twitch-client-id", token: `access-${id}` });
        expect(await pendingCleanups(id)).toEqual([]);
    });

    it("ends every session of the account at once, on every device", async () => {
        const email = `devices_${suffix}@example.com`;
        const id = await insertUser(email);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const site = await request(app).post("/api/stream/auth/login").send({ email, password });
        const companion = await request(app).post("/api/stream/auth/login").send({ email, password });
        await new Promise((resolve) => setTimeout(resolve, 1100)); // 1s/5-request test bucket

        await request(app)
            .delete("/api/stream/account/me")
            .set("Authorization", `Bearer ${site.body.accessToken}`)
            .send({ password })
            .expect(204);

        // The other device's access JWT is still validly signed - and refused.
        const otherDevice = { Authorization: `Bearer ${companion.body.accessToken}` };
        expect((await request(app).get("/api/stream/account/me").set(otherDevice)).status).toBe(401);
        expect((await request(app).post("/api/stream/companion/heartbeat").set(otherDevice).send({})).status).toBe(401);
        expect((await request(app).get("/api/stream/companion/session").set(otherDevice)).status).toBe(401);
        // ...and neither refresh token can mint a new one.
        for (const refreshToken of [site.body.refreshToken, companion.body.refreshToken]) {
            expect((await request(app).post("/api/stream/auth/refresh").send({ refreshToken })).status).toBe(401);
        }
    });

    it("blocks signing in with the deleted email; registering again starts an empty account", async () => {
        const email = `reborn_${suffix}@example.com`;
        const id = await insertUser(email);
        await seedAccount(id);
        await request(app).delete("/api/stream/account/me").set(bearer(id)).send({ password }).expect(204);
        await new Promise((resolve) => setTimeout(resolve, 1100));

        expect((await request(app).post("/api/stream/auth/login").send({ email, password })).status).toBe(401);

        const registered = await request(app).post("/api/stream/auth/register").send({ email, password });
        expect(registered.status).toBe(201);
        const newId = Number(registered.body.user.id);
        createdIds.push(newId);
        expect(newId).not.toBe(id);
        expect(
            (await leftovers(newId)).filter(([table]) => !["stream_users", "stream_refresh_tokens"].includes(table))
        ).toEqual([]);
    });

    it("a repeated request after deletion is refused, not re-run", async () => {
        const id = await insertUser();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await request(app).delete("/api/stream/account/me").set(bearer(id)).send({ password }).expect(204);
        expect((await request(app).delete("/api/stream/account/me").set(bearer(id)).send({ password })).status).toBe(401);
    });
});

describe("concurrent and repeated deletion", () => {
    it("two parallel deletions: one deletes, the other finds nothing; tokens revoked once", async () => {
        const id = await insertUser();
        const { files } = await seedAccount(id);

        const results = await Promise.all([
            deleteStreamUserAccount(id.toString()),
            deleteStreamUserAccount(id.toString()),
        ]);
        expect(results.sort()).toEqual([false, true]);
        expect(await leftovers(id)).toEqual([]);
        for (const file of files) expect(fs.existsSync(file)).toBe(false);
        expect(revokedTokens()).toEqual([`access-${id}`]);
        expect(redeemedRefreshTokens()).toEqual([`refresh-${id}`]);
        expect(await deleteStreamUserAccount(id.toString())).toBe(false);
    });

    it("parallel self + admin requests resolve to one 204", async () => {
        const email = `race_${suffix}@example.com`;
        const id = await insertUser(email);
        await seedAccount(id);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const [self, admin] = await Promise.all([
            request(app).delete("/api/stream/account/me").set(bearer(id)).send({ password }),
            request(app).delete(`/api/admin/users/${id}`).set(bearer(adminId)).send({ confirmEmail: email }),
        ]);
        expect([self.status, admin.status].filter((status) => status === 204)).toHaveLength(1);
        expect([self.status, admin.status].every((status) => [204, 401, 403, 404].includes(status))).toBe(true);
        expect(await leftovers(id)).toEqual([]);
    });
});

describe("cleanup after the database delete", () => {
    it("keeps a failed Twitch revoke queued and finishes it on a later sweep", async () => {
        const id = await insertUser();
        await seedAccount(id);
        twitch = { ...defaultTwitch, revoke: () => new Response(null, { status: 503 }) };

        expect(await deleteStreamUserAccount(id.toString())).toBe(true);
        expect(await leftovers(id)).toEqual([]);
        expect((await pendingCleanups(id)).map((row) => row.kind)).toEqual(["twitch_revoke"]);

        // Backed off: a sweep right away doesn't hammer Twitch again.
        fetchMock.mockClear();
        await processPendingCleanups({ subjectId: id.toString() });
        expect(revokedTokens()).toEqual([]);

        twitch = defaultTwitch;
        await pool.query("UPDATE pending_data_cleanups SET not_before = NOW() WHERE subject_id = $1", [id]);
        await processPendingCleanups({ subjectId: id.toString() });
        expect(revokedTokens()).toEqual([`access-${id}`]);
        expect(await pendingCleanups(id)).toEqual([]);
    });

    it("retries a file that couldn't be removed; a missing file counts as done", async () => {
        const id = await insertUser();
        const { files } = await seedAccount(id);
        const [background, webcam] = files;
        // A directory in the file's place makes unlink fail (EISDIR/EPERM).
        fs.unlinkSync(background);
        fs.mkdirSync(background);
        fs.unlinkSync(webcam);

        expect(await deleteStreamUserAccount(id.toString())).toBe(true);
        expect((await pendingCleanups(id)).map((row) => row.kind)).toEqual(["upload"]);

        fs.rmdirSync(background);
        fs.writeFileSync(background, "x");
        await pool.query("UPDATE pending_data_cleanups SET not_before = NOW() WHERE subject_id = $1", [id]);
        await processPendingCleanups({ subjectId: id.toString() });
        expect(fs.existsSync(background)).toBe(false);
        expect(await pendingCleanups(id)).toEqual([]);
    });

    it("gives up after the limit: error log, token wiped, failure still countable", async () => {
        const id = await insertUser();
        const statsBefore = await getCleanupStats();
        const stale = JSON.stringify({ accessToken: "stale-access", refreshToken: "stale-refresh" });
        await pool.query(
            `INSERT INTO pending_data_cleanups (kind, payload, subject_id, attempts, created_at)
             VALUES ('twitch_revoke', $2, $1, 0, NOW() - INTERVAL '8 days'),
                    ('twitch_revoke', $2, $1, 12, NOW())`,
            [id, stale]
        );
        twitch = { ...defaultTwitch, revoke: () => new Response(null, { status: 503 }) };
        const errorLog = vi.spyOn(logger, "error");

        const result = await processPendingCleanups({ subjectId: id.toString() });
        expect(result.gaveUp).toBe(2);
        expect(await pendingCleanups(id)).toEqual([
            { kind: "twitch_revoke", attempts: 1, payload: "", gave_up: true },
            { kind: "twitch_revoke", attempts: 13, payload: "", gave_up: true },
        ]);
        const logged = errorLog.mock.calls.filter(([message]) => message === "Data cleanup given up");
        expect(logged).toHaveLength(2);
        expect(JSON.stringify(logged)).not.toContain("stale-");

        const statsAfter = await getCleanupStats();
        expect(statsAfter.failed - statsBefore.failed).toBe(2);
        // Tombstones are never picked up again.
        fetchMock.mockClear();
        await pool.query("UPDATE pending_data_cleanups SET not_before = NOW() WHERE subject_id = $1", [id]);
        expect((await processPendingCleanups({ subjectId: id.toString() })).gaveUp).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an expired access token doesn't end the job: the live refresh token is redeemed and its new access token revoked", async () => {
        const id = await insertUser();
        await seedAccount(id);
        twitch = {
            revoke: (token) =>
                token === `access-${id}`
                    ? jsonResponse(400, { status: 400, message: "Invalid token" })
                    : new Response(null, { status: 200 }),
            token: () => jsonResponse(200, { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
        };
        const warn = vi.spyOn(logger, "warn");

        expect(await deleteStreamUserAccount(id.toString())).toBe(true);
        expect(revokedTokens()).toEqual([`access-${id}`, "fresh-access"]);
        expect(redeemedRefreshTokens()).toEqual([`refresh-${id}`]);
        expect(await pendingCleanups(id)).toEqual([]);
        expect(warn.mock.calls.some(([message]) => String(message).startsWith("Twitch refresh token was still valid"))).toBe(true);
    });

    it.each([
        ["404 client does not exist", () => jsonResponse(404, { status: 404, message: "client does not exist" })],
        ["400 with another message", () => jsonResponse(400, { status: 400, message: "missing client id" })],
        ["429", () => new Response(null, { status: 429 })],
        ["a network error", () => { throw new Error("offline"); }],
    ])("keeps retrying on %s", async (_label, revoke) => {
        const id = await insertUser();
        await seedAccount(id);
        twitch = { ...defaultTwitch, revoke };
        expect(await deleteStreamUserAccount(id.toString())).toBe(true);
        expect(await pendingCleanups(id)).toMatchObject([{ kind: "twitch_revoke", gave_up: false }]);
        await pool.query("DELETE FROM pending_data_cleanups WHERE subject_id = $1", [id]);
    });

    it("tasks left before a restart are picked up by the sweeper on startup", async () => {
        const id = await insertUser();
        await pool.query(
            `INSERT INTO pending_data_cleanups (kind, payload, subject_id) VALUES ('twitch_revoke', $2, $1)`,
            [id, JSON.stringify({ accessToken: "left-over-access", refreshToken: null })]
        );
        const stop = startPendingCleanupSweeper();
        try {
            await vi.waitFor(async () => expect(await pendingCleanups(id)).toEqual([]), { timeout: 5000 });
        } finally {
            stop();
        }
        expect(revokedTokens()).toContain("left-over-access");
    });
});

describe("DELETE /api/admin/users/:id", () => {
    it("is admin-only", async () => {
        const id = await insertUser();
        const other = await insertUser();
        expect((await request(app).delete(`/api/admin/users/${id}`)).status).toBe(401);
        expect((await request(app).delete(`/api/admin/users/${id}`).set(bearer(other))).status).toBe(403);
        expect((await remainingRows(id)).stream_users).toBe(1);
    });

    it("refuses to delete the admin's own account", async () => {
        const res = await request(app)
            .delete(`/api/admin/users/${adminId}`)
            .set(bearer(adminId))
            .send({ confirmEmail: adminEmail });
        expect(res.status).toBe(403);
        expect((await remainingRows(adminId)).stream_users).toBe(1);
    });

    it("requires the target's email as confirmation, then deletes everything", async () => {
        const email = `requested_${suffix}@example.com`;
        const id = await insertUser(email);
        const { files } = await seedAccount(id);
        const admin = (body: object) => request(app).delete(`/api/admin/users/${id}`).set(bearer(adminId)).send(body);

        expect((await admin({})).status).toBe(400);
        expect((await admin({ confirmEmail: "someone-else@example.com" })).status).toBe(400);
        expect((await remainingRows(id)).stream_users).toBe(1);

        expect((await admin({ confirmEmail: email.toUpperCase() })).status).toBe(204);
        expect(await leftovers(id)).toEqual([]);
        for (const file of files) expect(fs.existsSync(file)).toBe(false);
        expect(revokedTokens()).toContain(`access-${id}`);

        expect((await admin({ confirmEmail: email })).status).toBe(404);
    });
});

describe("disconnecting Twitch", () => {
    it("revokes the stored tokens at Twitch, and queues them if Twitch is down", async () => {
        const id = await insertUser();
        const link = (n: number) =>
            saveTwitchLink(
                id.toString(),
                { id: `tw-disc-${suffix}`, login: "s", display_name: "S", profile_image_url: "" },
                { access_token: `disc-access-${n}`, refresh_token: `disc-refresh-${n}`, expires_in: 3600 }
            );
        await link(1);
        await disconnectTwitch(id.toString());
        expect(revokedTokens()).toEqual(["disc-access-1"]);
        expect(redeemedRefreshTokens()).toEqual(["disc-refresh-1"]);
        expect((await remainingRows(id)).stream_twitch_links).toBe(0);

        await link(2);
        twitch = {
            ...defaultTwitch,
            revoke: () => {
                throw new Error("network down");
            },
        };
        await disconnectTwitch(id.toString());
        expect((await remainingRows(id)).stream_twitch_links).toBe(0);
        expect(await pendingCleanups(id)).toMatchObject([{ kind: "twitch_revoke", gave_up: false }]);
    });
});
