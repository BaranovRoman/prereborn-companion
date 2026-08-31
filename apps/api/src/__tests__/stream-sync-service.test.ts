import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken, setGameMode } from "../services/stream-user-service.js";
import {
    applyMatchFinalized,
    applySessionEnded,
    applySessionStarted,
    getCorrectionsSince,
} from "../services/stream-sync-service.js";

// WK-113 - local-first cutover: Companion's local_runtime::detector/lifecycle
// (Rust) are the only match/session decision-makers now; these tests verify
// the backend accepts their ALREADY-RESOLVED outcomes idempotently, per the
// ticket's explicit failure matrix (#9 response-lost-then-retry, #10
// duplicate event, #17/#18 correction pull never rewrites detected history).

const suffix = `${Date.now()}-sync`;
let userCounter = 0;
const createdUserIds: string[] = [];

interface TestUser {
    streamUserId: string;
    companionToken: string;
}

const createTestUser = async (): Promise<TestUser> => {
    userCounter += 1;
    const email = `stream_sync_${suffix}_${userCounter}@example.com`;
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    const streamUserId = result.rows[0].id.toString();
    createdUserIds.push(streamUserId);
    const regenerated = await regenerateCompanionToken(streamUserId);
    return { streamUserId, companionToken: regenerated!.token };
};

beforeAll(async () => {
    await createTables();
});

afterAll(async () => {
    if (createdUserIds.length > 0) {
        await pool.query("DELETE FROM stream_users WHERE id = ANY($1::int[])", [createdUserIds]);
    }
    await pool.end();
});

describe("applySessionStarted", () => {
    it("creates a backend session tagged with the local_session_id", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = randomUUID();
        const result = await applySessionStarted(streamUserId, randomUUID(), {
            localSessionId,
            startedAt: new Date().toISOString(),
            ratingStart: 6000,
        });

        const row = await pool.query(
            "SELECT rating, local_session_id FROM stream_sessions WHERE id = $1",
            [result.backendSessionId]
        );
        expect(row.rows[0].rating).toBe(6000);
        expect(row.rows[0].local_session_id).toBe(localSessionId);
    });

    it("retrying the exact same eventId never creates a second session (event-ledger idempotency)", async () => {
        const { streamUserId } = await createTestUser();
        const eventId = randomUUID();
        const payload = { localSessionId: randomUUID(), startedAt: new Date().toISOString(), ratingStart: null };

        const first = await applySessionStarted(streamUserId, eventId, payload);
        const retried = await applySessionStarted(streamUserId, eventId, payload);
        expect(retried.backendSessionId).toBe(first.backendSessionId);

        const count = await pool.query("SELECT COUNT(*) FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(Number(count.rows[0].count)).toBe(1);
    });

    it("retrying with a DIFFERENT eventId but the SAME local_session_id still never duplicates (data-level idempotency)", async () => {
        // Simulates the sync worker crashing after the backend committed
        // but before it recorded delivery locally, then retrying with a
        // freshly-generated eventId on next startup.
        const { streamUserId } = await createTestUser();
        const localSessionId = randomUUID();
        const payload = { localSessionId, startedAt: new Date().toISOString(), ratingStart: null };

        const first = await applySessionStarted(streamUserId, randomUUID(), payload);
        const secondAttempt = await applySessionStarted(streamUserId, randomUUID(), payload);
        expect(secondAttempt.backendSessionId).toBe(first.backendSessionId);

        const count = await pool.query("SELECT COUNT(*) FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(Number(count.rows[0].count)).toBe(1);
    });
});

describe("applySessionEnded", () => {
    it("ends the session matching the local_session_id", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = randomUUID();
        await applySessionStarted(streamUserId, randomUUID(), { localSessionId, startedAt: new Date().toISOString(), ratingStart: null });

        const endedAt = new Date().toISOString();
        await applySessionEnded(streamUserId, randomUUID(), { localSessionId, endedAt });

        const row = await pool.query("SELECT ended_at FROM stream_sessions WHERE stream_user_id = $1 AND local_session_id = $2", [
            streamUserId,
            localSessionId,
        ]);
        expect(row.rows[0].ended_at).not.toBeNull();
    });

    it("is idempotent - ending twice does not error or move ended_at", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = randomUUID();
        await applySessionStarted(streamUserId, randomUUID(), { localSessionId, startedAt: new Date().toISOString(), ratingStart: null });
        await applySessionEnded(streamUserId, randomUUID(), { localSessionId, endedAt: new Date().toISOString() });

        const before = await pool.query("SELECT ended_at FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        await applySessionEnded(streamUserId, randomUUID(), { localSessionId, endedAt: new Date().toISOString() });
        const after = await pool.query("SELECT ended_at FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(after.rows[0].ended_at).toEqual(before.rows[0].ended_at);
    });
});

describe("applyMatchFinalized", () => {
    const startSession = async (streamUserId: string) => {
        const localSessionId = randomUUID();
        await applySessionStarted(streamUserId, randomUUID(), { localSessionId, startedAt: new Date().toISOString(), ratingStart: 6000 });
        return localSessionId;
    };

    it("inserts a finalized match and updates session wins/rating exactly once", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = await startSession(streamUserId);
        const localMatchId = randomUUID();

        await applyMatchFinalized(streamUserId, randomUUID(), {
            localSessionId,
            localMatchId,
            matchId: "123456",
            heroId: 14,
            result: "win",
            isRanked: true,
            ratingBefore: 6000,
            detectedRatingDelta: 25,
            ratingAfter: 6025,
            confidence: "confirmed",
            startedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
        });

        const match = await pool.query(
            "SELECT result, is_ranked, rating_delta, detected_rating_delta, rating_delta_correction, rating_after, state FROM stream_matches WHERE stream_user_id = $1 AND local_match_id = $2",
            [streamUserId, localMatchId]
        );
        expect(match.rows[0]).toMatchObject({
            result: "win",
            is_ranked: true,
            rating_delta: 25,
            detected_rating_delta: 25,
            rating_delta_correction: 0,
            rating_after: 6025,
            state: "finalized",
        });

        const session = await pool.query("SELECT wins, losses, rating FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(session.rows[0]).toMatchObject({ wins: 1, losses: 0, rating: 6025 });
    });

    it("retrying the same eventId after a lost response never double-counts W/L or re-applies the MMR delta", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = await startSession(streamUserId);
        const eventId = randomUUID();
        const payload = {
            localSessionId,
            localMatchId: randomUUID(),
            matchId: "999",
            heroId: 8,
            result: "win" as const,
            isRanked: true,
            ratingBefore: 6000,
            detectedRatingDelta: 25,
            ratingAfter: 6025,
            confidence: "confirmed" as const,
            startedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
        };

        await applyMatchFinalized(streamUserId, eventId, payload);
        await applyMatchFinalized(streamUserId, eventId, payload); // exact retry

        const matchCount = await pool.query("SELECT COUNT(*) FROM stream_matches WHERE stream_user_id = $1", [streamUserId]);
        expect(Number(matchCount.rows[0].count)).toBe(1);

        const session = await pool.query("SELECT wins, losses, rating FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(session.rows[0]).toMatchObject({ wins: 1, losses: 0, rating: 6025 });
    });

    it("retrying with a different eventId but the same local_match_id still never duplicates the match or the W/L increment", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = await startSession(streamUserId);
        const localMatchId = randomUUID();
        const payload = {
            localSessionId,
            localMatchId,
            matchId: "1000",
            heroId: 9,
            result: "loss" as const,
            isRanked: true,
            ratingBefore: 6000,
            detectedRatingDelta: -25,
            ratingAfter: 5975,
            confidence: "probable" as const,
            startedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
        };

        await applyMatchFinalized(streamUserId, randomUUID(), payload);
        await applyMatchFinalized(streamUserId, randomUUID(), payload); // different eventId, same local_match_id

        const matchCount = await pool.query("SELECT COUNT(*) FROM stream_matches WHERE stream_user_id = $1", [streamUserId]);
        expect(Number(matchCount.rows[0].count)).toBe(1);

        const session = await pool.query("SELECT wins, losses, rating FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(session.rows[0]).toMatchObject({ wins: 0, losses: 1, rating: 5975 });
    });

    it("an unranked/unknown match never fabricates a rating and does not move session.rating", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = await startSession(streamUserId);

        await applyMatchFinalized(streamUserId, randomUUID(), {
            localSessionId,
            localMatchId: randomUUID(),
            matchId: null,
            heroId: 1,
            result: "win",
            isRanked: null,
            ratingBefore: null,
            detectedRatingDelta: null,
            ratingAfter: null,
            confidence: "confirmed",
            startedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
        });

        const session = await pool.query("SELECT wins, rating FROM stream_sessions WHERE stream_user_id = $1", [streamUserId]);
        expect(session.rows[0]).toMatchObject({ wins: 1, rating: 6000 }); // W/L still counts; rating untouched
    });
});

describe("getCorrectionsSince", () => {
    it("returns only matches corrected after the cursor, and includes the session's current rating/adjustment", async () => {
        const { streamUserId } = await createTestUser();
        const localSessionId = await (async () => {
            const id = randomUUID();
            await applySessionStarted(streamUserId, randomUUID(), { localSessionId: id, startedAt: new Date().toISOString(), ratingStart: 6000 });
            return id;
        })();
        const localMatchId = randomUUID();
        await applyMatchFinalized(streamUserId, randomUUID(), {
            localSessionId,
            localMatchId,
            matchId: "2000",
            heroId: 5,
            result: "win",
            isRanked: true,
            ratingBefore: 6000,
            detectedRatingDelta: 25,
            ratingAfter: 6025,
            confidence: "confirmed",
            startedAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
        });

        const before = new Date().toISOString();
        await pool.query(
            `UPDATE stream_matches SET rating_delta = 26, rating_after = 6026, rating_delta_correction = 1, corrected_at = CURRENT_TIMESTAMP
             WHERE stream_user_id = $1 AND local_match_id = $2`,
            [streamUserId, localMatchId]
        );
        await pool.query(`UPDATE stream_sessions SET rating = 6026 WHERE stream_user_id = $1`, [streamUserId]);

        const corrections = await getCorrectionsSince(streamUserId, before);
        expect(corrections).toHaveLength(1);
        expect(corrections[0]).toMatchObject({ localMatchId, ratingDelta: 26, ratingAfter: 6026, sessionRating: 6026 });

        // +1ms past the correction's own recorded (already timezone-corrected
        // by getCorrectionsSince) timestamp - not the exact same instant,
        // since Postgres keeps microsecond precision and a JS Date only
        // keeps millisecond precision (the exact value could silently
        // truncate below the true stored instant and still match `>`). This
        // is the same "advance the cursor past, not to, the last seen
        // timestamp" rule the real sync worker's pull loop follows.
        const pastCursor = new Date(new Date(corrections[0].correctedAt).getTime() + 1).toISOString();
        const noneYet = await getCorrectionsSince(streamUserId, pastCursor);
        expect(noneYet).toHaveLength(0);
    });
});

describe("POST /api/stream/companion/sync/events", () => {
    it("requires a companion token", async () => {
        const res = await request(app)
            .post("/api/stream/companion/sync/events")
            .send({ eventId: randomUUID(), eventType: "session_started", payload: {} });
        expect(res.status).toBe(401);
    });

    it("rejects an invalid payload with 422 (dead-letter signal, not a retryable 5xx)", async () => {
        const { companionToken } = await createTestUser();
        const res = await request(app)
            .post("/api/stream/companion/sync/events")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({ eventId: "not-a-uuid", eventType: "session_started", payload: {} });
        expect(res.status).toBe(422);
    });

    it("accepts a session_started event over HTTP and returns the backend session id", async () => {
        const { companionToken } = await createTestUser();
        const res = await request(app)
            .post("/api/stream/companion/sync/events")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({
                eventId: randomUUID(),
                eventType: "session_started",
                payload: { localSessionId: randomUUID(), startedAt: new Date().toISOString(), ratingStart: null },
            });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.result.backendSessionId).toBeTruthy();
    });
});

describe("GET /api/stream/companion/account-settings", () => {
    it("requires a companion token", async () => {
        expect((await request(app).get("/api/stream/companion/account-settings")).status).toBe(401);
    });

    it("returns the account's current ranked/unranked toggle", async () => {
        const { streamUserId, companionToken } = await createTestUser();
        await setGameMode(streamUserId, "unranked");
        const res = await request(app)
            .get("/api/stream/companion/account-settings")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(res.status).toBe(200);
        expect(res.body.gameMode).toBe("unranked");
        expect(res.body.steam).toEqual({ connected: false, profile: null });
        expect(res.body.twitch.connected).toBe(false);
    });
});
