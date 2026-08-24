import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";
import { processGsiPayloadForMatch } from "../services/stream-match-service.js";
import { heroSelectionTick, postGameTick } from "./fixtures/gsi-payloads.js";

// Post-audit regression (2026-08-24 real-stream report, "Between Matches -
// новая session без матчей" / "one ranked match shows no MMR delta"): root
// cause was resetActiveSession only carrying `rating` forward from a
// currently-ACTIVE session row, so starting a new stream after an explicit
// End always reset the account's known MMR to null - hiding the medal/MMR
// display until the first ranked match, and (worse) permanently suppressing
// that stream's rating delta because the first match's ratingBefore was
// itself null. See stream-session-service.ts's resetActiveSession comment.

let userCounter = 0;
const suffix = `${Date.now()}-rating-carryover`;
const createdUserIds: string[] = [];

interface TestUser {
    streamUserId: string;
    jwtToken: string;
    companionToken: string;
}

const createTestUser = async (): Promise<TestUser> => {
    userCounter += 1;
    const email = `stream_rating_carryover_${suffix}_${userCounter}@example.com`;
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
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

    return { streamUserId, jwtToken, companionToken };
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

describe("rating carries forward across an explicit End -> Start New cycle", () => {
    it("a brand-new stream started after End keeps the account's last-known rating (not null)", async () => {
        const user = await createTestUser();

        // Session A: streamer sets their current MMR once (real-world entry
        // point for `rating` - see patchSessionSchema), plays a ranked win.
        await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        await request(app)
            .patch("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`)
            .send({ rating: 4000 });
        await finalizeWin(user.streamUserId, 10, "940000001");

        const beforeEnd = await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(beforeEnd.body.session.rating).toBe(4025);

        // End session A.
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        // Start session B ("Начать новый стрим" after an explicit End).
        const resetRes = await request(app)
            .post("/api/stream/account/session/reset")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(resetRes.status).toBe(200);
        expect(resetRes.body.wins).toBe(0);
        expect(resetRes.body.losses).toBe(0);
        // The fix under test: B inherits A's rating, not null.
        expect(resetRes.body.rating).toBe(4025);

        const activeSession = await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(activeSession.body.state).toBe("active");
        expect(activeSession.body.session.rating).toBe(4025);

        // Companion's own session endpoint reuses the same resetActiveSession
        // primitive, so it must see the same non-null carried-over rating
        // reflected through its sessionRatingDelta (0 for a fresh session
        // with no ranked match yet, not null - honest "no change so far").
        const companionSession = await request(app)
            .get("/api/stream/companion/session")
            .set("Authorization", `Bearer ${user.companionToken}`);
        expect(companionSession.body.state).toBe("active");
        expect(companionSession.body.sessionRatingDelta).toBe(0);
    });

    it("a single ranked match in that freshly-reset session produces an honest, non-null MMR delta", async () => {
        const user = await createTestUser();
        await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        await request(app)
            .patch("/api/stream/account/session")
            .set("Authorization", `Bearer ${user.jwtToken}`)
            .send({ rating: 3200 });
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        await request(app)
            .post("/api/stream/account/session/reset")
            .set("Authorization", `Bearer ${user.jwtToken}`);

        // Exactly one ranked match this stream - the confirmed WK-100 bug.
        await finalizeWin(user.streamUserId, 11, "940000002");

        const endRes = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(endRes.status).toBe(200);
        expect(endRes.body.summary.matchCount).toBe(1);
        expect(endRes.body.summary.ratingStart).toBe(3200);
        expect(endRes.body.summary.ratingEnd).toBe(3225);
        // The bug: this used to be null for a one-match stream whose session
        // started fresh after an explicit End.
        expect(endRes.body.summary.ratingDelta).toBe(25);
    });

    it("a true first-ever session (no history at all) still honestly starts at null - no fabricated fallback", async () => {
        const user = await createTestUser();
        const resetRes = await request(app)
            .post("/api/stream/account/session/reset")
            .set("Authorization", `Bearer ${user.jwtToken}`);
        expect(resetRes.status).toBe(200);
        expect(resetRes.body.rating).toBeNull();
    });
});
