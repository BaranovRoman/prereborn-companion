import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { seedQuizQuestions } from "../db/seed-quiz-questions.js";
import { enterBetweenMatches, getQuizState } from "../services/quiz-round-service.js";

// WK-116 Phase 4 - the Twitch Extension's backend surface. Tests exercise
// the JWT verification middleware and the two viewer-facing endpoints
// against a real database, same "createTables in beforeAll, real Postgres"
// convention as quiz-round-service.test.ts.

const TEST_SECRET = "dGVzdC1vbmx5LXR3aXRjaC1leHRlbnNpb24tc2VjcmV0LTMyYg=="; // must match vitest.config.ts
const secretKey = Buffer.from(TEST_SECRET, "base64");

const suffix = `${Date.now()}-ext`;
let userCounter = 0;
const createdUserIds: string[] = [];

const createLinkedTestUser = async (): Promise<{ streamUserId: string; twitchChannelId: string }> => {
    userCounter += 1;
    const email = `stream_ext_${suffix}_${userCounter}@example.com`;
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    const streamUserId = result.rows[0].id.toString();
    createdUserIds.push(streamUserId);
    await pool.query(
        `INSERT INTO stream_sessions (stream_user_id) VALUES ($1)`,
        [streamUserId]
    );
    const twitchChannelId = `channel-${suffix}-${userCounter}`;
    await pool.query(
        `INSERT INTO stream_twitch_links (stream_user_id, twitch_user_id, login, display_name)
         VALUES ($1, $2, 'streamer_login', 'Streamer Display')`,
        [streamUserId, twitchChannelId]
    );
    return { streamUserId, twitchChannelId };
};

const extensionToken = (payload: {
    channel_id: string;
    opaque_user_id: string;
    user_id?: string;
    role?: "viewer" | "broadcaster" | "moderator" | "external";
    expiresInSeconds?: number;
    secret?: Buffer;
}): string =>
    jwt.sign(
        {
            channel_id: payload.channel_id,
            opaque_user_id: payload.opaque_user_id,
            ...(payload.user_id ? { user_id: payload.user_id } : {}),
            role: payload.role ?? "viewer",
        },
        payload.secret ?? secretKey,
        { algorithm: "HS256", expiresIn: payload.expiresInSeconds ?? 3600 }
    );

const correctOptionIdFor = async (roundId: string): Promise<string> => {
    const row = await pool.query<{ id: number }>(
        `SELECT o.id FROM quiz_question_options o
         JOIN quiz_rounds r ON r.question_id = o.question_id
         WHERE r.id = $1 AND o.is_correct = true`,
        [roundId]
    );
    return row.rows[0].id.toString();
};

beforeAll(async () => {
    await createTables();
    await seedQuizQuestions();
});

afterAll(async () => {
    if (createdUserIds.length > 0) {
        await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [createdUserIds]);
    }
    await pool.end();
});

describe("authenticateTwitchExtension", () => {
    it("rejects a request with no token", async () => {
        const res = await request(app).get("/api/stream/extension/quiz/state");
        expect(res.status).toBe(401);
    });

    it("rejects a token signed with the wrong secret", async () => {
        const wrongSecret = Buffer.from("d3Jvbmctc2VjcmV0LWZvci10ZXN0LW9ubHktMzJi", "base64");
        const token = extensionToken({ channel_id: "1", opaque_user_id: "U1", secret: wrongSecret });
        const res = await request(app).get("/api/stream/extension/quiz/state").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
    });

    it("rejects an expired token", async () => {
        const token = extensionToken({ channel_id: "1", opaque_user_id: "U1", expiresInSeconds: -10 });
        const res = await request(app).get("/api/stream/extension/quiz/state").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
    });

    it("accepts a validly signed, unexpired token", async () => {
        const { twitchChannelId } = await createLinkedTestUser();
        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "U1" });
        const res = await request(app).get("/api/stream/extension/quiz/state").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
    });
});

describe("GET /api/stream/extension/quiz/state", () => {
    it("returns quiz: null for a channel with no linked PreReborn account", async () => {
        const token = extensionToken({ channel_id: "no-such-channel", opaque_user_id: "U1" });
        const res = await request(app).get("/api/stream/extension/quiz/state").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.quiz).toBeNull();
    });

    it("returns the active round, reveal-gated exactly like the Companion/web poll", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "U1" });

        const res = await request(app).get("/api/stream/extension/quiz/state").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.quiz.phase).toBe("question");
        expect(res.body.quiz.correctOptionId).toBeNull();
        expect(res.body.quiz.distribution).toBeNull();
    });

    it("includes Companion-published interactiveRegions when present", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);

        await pool.query(`UPDATE quiz_rounds SET interactive_regions = $1::jsonb WHERE id = $2`, [
            JSON.stringify([{ id: "0", x: 0.1, y: 0.1, width: 0.1, height: 0.05, value: state!.options[0].id }]),
            state!.roundId,
        ]);

        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "U1" });
        const res = await request(app).get("/api/stream/extension/quiz/state").set("Authorization", `Bearer ${token}`);
        expect(res.body.quiz.interactiveRegions).toHaveLength(1);
    });
});

describe("POST /api/stream/extension/quiz/answer", () => {
    it("rejects a malformed body", async () => {
        const { twitchChannelId } = await createLinkedTestUser();
        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "U1" });
        const res = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${token}`)
            .send({ roundId: "1" }); // missing optionId
        expect(res.status).toBe(400);
    });

    it("returns 404 for a channel with no linked account", async () => {
        const token = extensionToken({ channel_id: "no-such-channel", opaque_user_id: "U1" });
        const res = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${token}`)
            .send({ roundId: "1", optionId: "1" });
        expect(res.status).toBe(404);
    });

    it("accepts a valid submission and NEVER echoes correctness in the response", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);

        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "viewer-opaque-1", user_id: "111222333" });
        const res = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${token}`)
            .send({ roundId: state!.roundId, optionId: correctOptionId, displayName: "some_viewer" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(JSON.stringify(res.body).toLowerCase()).not.toContain("correct");

        // Scoring is deferred to reveal (see quiz-round-service.test.ts) -
        // an accepted submission alone must not have scored anything yet.
        const answer = await pool.query(
            "SELECT is_correct FROM quiz_answers WHERE round_id = $1 AND twitch_viewer_id = $2",
            [state!.roundId, "111222333"]
        );
        expect(answer.rows[0].is_correct).toBe(true);
        const scoreRows = await pool.query("SELECT * FROM quiz_viewer_scores WHERE twitch_viewer_id = $1", ["111222333"]);
        expect(scoreRows.rows).toHaveLength(0);
    });

    it("keys the viewer by the real user_id when identity is shared, or an opaque-derived id otherwise", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const optionId = state!.options[0].id;

        const anonymousToken = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "opaque-anon-viewer" });
        const res = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${anonymousToken}`)
            .send({ roundId: state!.roundId, optionId });
        expect(res.status).toBe(200);

        const stored = await pool.query("SELECT twitch_viewer_id FROM quiz_answers WHERE round_id = $1", [state!.roundId]);
        expect(stored.rows[0].twitch_viewer_id).toBe("ext:opaque-anon-viewer");
    });

    it("two different viewers can independently answer the same round", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);

        const tokenA = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "A", user_id: "1001" });
        const tokenB = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "B", user_id: "1002" });

        const resA = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ roundId: state!.roundId, optionId: state!.options[0].id });
        const resB = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${tokenB}`)
            .send({ roundId: state!.roundId, optionId: state!.options[1].id });

        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
        const count = await pool.query("SELECT COUNT(*) FROM quiz_answers WHERE round_id = $1", [state!.roundId]);
        expect(Number(count.rows[0].count)).toBe(2);
    });

    it("rejects a duplicate submission from the same viewer in the same round", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "dup", user_id: "2001" });

        const first = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${token}`)
            .send({ roundId: state!.roundId, optionId: state!.options[0].id });
        expect(first.status).toBe(200);

        const second = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${token}`)
            .send({ roundId: state!.roundId, optionId: state!.options[1].id });
        expect(second.status).toBe(409);
        expect(second.body.reason).toBe("already_answered");
    });

    it("rejects a late answer once the round has moved to reveal", async () => {
        const { streamUserId, twitchChannelId } = await createLinkedTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        await pool.query(
            `UPDATE quiz_rounds SET question_started_at = question_started_at - interval '31 seconds' WHERE id = $1`,
            [state!.roundId]
        );

        const token = extensionToken({ channel_id: twitchChannelId, opaque_user_id: "late", user_id: "3001" });
        const res = await request(app)
            .post("/api/stream/extension/quiz/answer")
            .set("Authorization", `Bearer ${token}`)
            .send({ roundId: state!.roundId, optionId: state!.options[0].id });
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe("no_active_question");
    });
});
