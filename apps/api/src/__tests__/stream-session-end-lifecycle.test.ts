import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";
import {
    endActiveSession,
    getOrCreateActiveSession,
    resetActiveSession,
} from "../services/stream-session-service.js";
import { processGsiPayloadForMatch } from "../services/stream-match-service.js";
import { heroSelectionTick, postGameTick } from "./fixtures/gsi-payloads.js";

// WK-53 - "конец стрим-сессии": self-service End (POST /account/session/end)
// closes the active session WITHOUT opening a new one, is idempotent, and -
// critically - a stale GSI tick arriving after End must not resurrect the
// ended session or silently create a new one (see stream-match-service.ts's
// createMatch guard). Uses direct calls to processGsiPayloadForMatch to
// simulate "Companion keeps running and posting GSI after the streamer
// clicked End", exactly like stream-match-lifecycle.test.ts does for the
// rest of the match pipeline.

let userCounter = 0;
const suffix = `${Date.now()}-end-lifecycle`;
const createdUserIds: string[] = [];

interface TestUser {
    streamUserId: string;
    publicToken: string;
    jwtToken: string;
    companionToken: string;
}

const createTestUser = async (): Promise<TestUser> => {
    userCounter += 1;
    const email = `stream_end_lifecycle_${suffix}_${userCounter}@example.com`;
    const publicToken = randomUUID();
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, publicToken]
    );
    const streamUserId = result.rows[0].id.toString();
    createdUserIds.push(streamUserId);

    const jwtToken = jwt.sign(
        { streamUserId },
        process.env.STREAM_JWT_SECRET!,
        { expiresIn: "5m" }
    );
    const regenerated = await regenerateCompanionToken(streamUserId);
    const companionToken = regenerated!.token;

    return { streamUserId, publicToken, jwtToken, companionToken };
};

const finalizeWin = async (streamUserId: string, heroId: number, matchId: string) => {
    await processGsiPayloadForMatch(streamUserId, heroSelectionTick(heroId, matchId));
    await processGsiPayloadForMatch(streamUserId, postGameTick(heroId, "win", { matchId }));
    await processGsiPayloadForMatch(streamUserId, postGameTick(heroId, "win", { matchId }));
};

beforeAll(async () => {
    await createTables();
});

afterAll(async () => {
    if (createdUserIds.length > 0) {
        await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [
            createdUserIds.map(Number),
        ]);
    }
    await pool.end();
});

describe("self-service end-of-stream (POST /account/session/end)", () => {
    it("returns 409 and creates nothing when the account has never had a session", async () => {
        const user = await createTestUser();
        const res = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        expect(res.status).toBe(409);
        const rows = await pool.query("SELECT id FROM stream_sessions WHERE stream_user_id = $1", [
            user.streamUserId,
        ]);
        expect(rows.rows).toHaveLength(0);
    });

    it("closes the active session without opening a new one, and returns an honest summary", async () => {
        const user = await createTestUser();
        // Первое касание (создаёт первую сессию через true first-run lazy-create).
        await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        await finalizeWin(user.streamUserId, 10, "910000001");
        await finalizeWin(user.streamUserId, 11, "910000002");

        const res = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        expect(res.status).toBe(200);
        expect(res.body.session.endedAt).not.toBeNull();
        expect(res.body.summary.wins).toBe(2);
        expect(res.body.summary.losses).toBe(0);
        expect(res.body.summary.matchCount).toBe(2);
        expect(res.body.summary.startedAt).toEqual(expect.any(String));
        expect(res.body.summary.endedAt).toEqual(expect.any(String));
        expect(res.body.summary.durationMs).toBeGreaterThanOrEqual(0);

        const rows = await pool.query(
            "SELECT ended_at FROM stream_sessions WHERE stream_user_id = $1",
            [user.streamUserId]
        );
        // Exactly one session row - End did not open a second one.
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0].ended_at).not.toBeNull();
    });

    it("is idempotent: a double-click returns the same summary without erroring or creating another session", async () => {
        const user = await createTestUser();
        await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        await finalizeWin(user.streamUserId, 12, "910000003");

        const first = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        const second = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.session.id).toBe(first.body.session.id);
        expect(second.body.summary).toEqual(first.body.summary);

        const rows = await pool.query("SELECT id FROM stream_sessions WHERE stream_user_id = $1", [
            user.streamUserId,
        ]);
        expect(rows.rows).toHaveLength(1);
    });

    it("PATCH after End returns 409 and does not change or resurrect the ended session", async () => {
        const user = await createTestUser();
        await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        const res = await request(app)
            .patch("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`)
            .send({ rating: 4200 });

        expect(res.status).toBe(409);

        const rows = await pool.query("SELECT id FROM stream_sessions WHERE stream_user_id = $1", [
            user.streamUserId,
        ]);
        expect(rows.rows).toHaveLength(1);
    });

    it("GET session reflects state=ended with a summary, then state=active again after Start New", async () => {
        const user = await createTestUser();
        await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        const ended = await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(ended.status).toBe(200);
        expect(ended.body.state).toBe("ended");
        expect(ended.body.summary).not.toBeNull();

        await request(app)
            .post("/api/stream/account/session/reset")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        const active = await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(active.status).toBe(200);
        expect(active.body.state).toBe("active");
        expect(active.body.summary).toBeNull();
    });

    it("a stale GSI tick after End does not resurrect the session or create a match", async () => {
        const user = await createTestUser();
        await getOrCreateActiveSession(user.streamUserId);
        const ended = await endActiveSession(user.streamUserId);
        expect(ended).not.toBeNull();

        // Companion is still running and keeps posting GSI - a full match
        // start/finalize sequence arriving after End must be a no-op.
        await finalizeWin(user.streamUserId, 13, "910000004");

        const sessionRows = await pool.query(
            "SELECT id, ended_at FROM stream_sessions WHERE stream_user_id = $1",
            [user.streamUserId]
        );
        expect(sessionRows.rows).toHaveLength(1);
        expect(sessionRows.rows[0].ended_at).not.toBeNull();

        const matchRows = await pool.query(
            "SELECT id FROM stream_matches WHERE stream_user_id = $1",
            [user.streamUserId]
        );
        expect(matchRows.rows).toHaveLength(0);
    });

    it("Companion's GET session reports state=ended (no 'continue' should be offered)", async () => {
        const user = await createTestUser();
        await request(app)
            .get("/api/stream/companion/session")
            .set("Authorization", `Bearer ${user.companionToken}`);
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        const res = await request(app)
            .get("/api/stream/companion/session")
            .set("Authorization", `Bearer ${user.companionToken}`);

        expect(res.status).toBe(200);
        expect(res.body.state).toBe("ended");
        expect(res.body.endedAt).not.toBeNull();
    });

    it("public overlay shows sessionState=ended with no live companion payload, but keeps account-wide history", async () => {
        const user = await createTestUser();
        await getOrCreateActiveSession(user.streamUserId);
        await finalizeWin(user.streamUserId, 14, "910000005");
        await endActiveSession(user.streamUserId);

        // Companion "still running" - posts a fresh GSI payload after End.
        await request(app)
            .put("/api/stream/companion/gsi-state")
            .set("Authorization", `Bearer ${user.companionToken}`)
            .send({ payload: heroSelectionTick(15, "910000006") });

        const res = await request(app).get(`/api/stream/overlay/${user.publicToken}`);

        expect(res.status).toBe(200);
        expect(res.body.sessionState).toBe("ended");
        expect(res.body.sessionSummary).not.toBeNull();
        expect(res.body.sessionSummary.wins).toBe(1);
        // Defense in depth - the frontend scene resolver reads this field;
        // it must be null so a stale GSI tick can never be read as "playing".
        expect(res.body.companion.payload).toBeNull();
        // Account-wide Recent Games/Last Match must still work after End.
        expect(res.body.recentMatches.length).toBeGreaterThan(0);
    });
});

// Full end-to-end regression requested by the task: session A -> matches ->
// End A -> A stays ended -> Recent Games/Last Match preserved -> stale GSI
// doesn't resurrect A or create B -> overlay shows final/ended state ->
// Start New -> B created -> B has 0W/0L/0 delta -> history of A remains ->
// new match belongs to B -> overlay works as active again.
describe("full lifecycle: session A -> End -> stale GSI -> Start New -> session B", () => {
    it("carries the invariants across the whole flow", async () => {
        const user = await createTestUser();

        // 1. Session A plays two matches.
        await getOrCreateActiveSession(user.streamUserId);
        await finalizeWin(user.streamUserId, 20, "920000001");
        await finalizeWin(user.streamUserId, 21, "920000002");

        const beforeEnd = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        const sessionAId = beforeEnd.body.matches[0].streamSessionId as string;

        // 2. End A.
        const endRes = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(endRes.status).toBe(200);
        expect(endRes.body.session.id).toBe(sessionAId);
        expect(endRes.body.summary.wins).toBe(2);

        // 3. A stays ended; Recent Games/Last Match (account-wide) preserved.
        const afterEnd = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(afterEnd.body.sessionState).toBe("ended");
        expect(afterEnd.body.recentMatches).toHaveLength(2);
        expect(
            afterEnd.body.recentMatches.every(
                (m: { streamSessionId: string }) => m.streamSessionId === sessionAId
            )
        ).toBe(true);

        // 4. Stale/delayed GSI does not resurrect A or create session B.
        await finalizeWin(user.streamUserId, 22, "920000003");
        const stillA = await pool.query(
            "SELECT id FROM stream_sessions WHERE stream_user_id = $1",
            [user.streamUserId]
        );
        expect(stillA.rows).toHaveLength(1);
        expect(stillA.rows[0].id.toString()).toBe(sessionAId);

        // 5. Overlay still shows the final/ended state, not gameplay.
        const stillEnded = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(stillEnded.body.sessionState).toBe("ended");

        // 6. Start New -> session B.
        const resetRes = await request(app)
            .post("/api/stream/account/session/reset")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        const sessionBId = resetRes.body.id as string;
        expect(sessionBId).not.toBe(sessionAId);
        expect(resetRes.body.wins).toBe(0);
        expect(resetRes.body.losses).toBe(0);

        // 7. B starts at 0W/0L/0 delta; overlay is active again.
        const afterReset = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(afterReset.body.sessionState).toBe("active");
        expect(afterReset.body.wins).toBe(0);
        expect(afterReset.body.losses).toBe(0);
        expect(afterReset.body.sessionRatingDelta === null || afterReset.body.sessionRatingDelta === 0).toBe(true);
        // A's history remains, dimmable via streamSessionId, but not counted
        // toward B's gameplay HUD (`matches`, session-scoped).
        expect(afterReset.body.matches).toEqual([]);
        expect(afterReset.body.recentMatches).toHaveLength(2);

        // 8. A new match under B.
        await finalizeWin(user.streamUserId, 23, "920000004");
        const afterNewMatch = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(afterNewMatch.body.sessionState).toBe("active");
        expect(afterNewMatch.body.matches).toHaveLength(1);
        expect(afterNewMatch.body.matches[0].streamSessionId).toBe(sessionBId);
        expect(afterNewMatch.body.recentMatches).toHaveLength(3);
    });
});
