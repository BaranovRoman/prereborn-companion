import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";

// WK-83 - companion (Tauri app) never has the stream JWT the web cabinet
// uses (/api/stream/account/*), only a separate companion_token. These two
// new routes reuse the exact same session-service functions
// (getOrCreateActiveSession/resetActiveSession) the web cabinet's
// /account/session* routes already call, just behind companion-token auth.
const suffix = `${Date.now()}-companion-session`;
const email = `stream_companion_session_${suffix}@example.com`;
const publicToken = randomUUID();

let streamUserId: number;
let companionToken: string;
let jwtToken: string;

beforeAll(async () => {
    await createTables();

    const hashed = await bcrypt.hash("test-password-123", 10);
    const userResult = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, publicToken]
    );
    streamUserId = userResult.rows[0].id;

    const regenerated = await regenerateCompanionToken(streamUserId.toString());
    companionToken = regenerated!.token;

    jwtToken = jwt.sign(
        { streamUserId: streamUserId.toString() },
        process.env.STREAM_JWT_SECRET!,
        { expiresIn: "5m" }
    );
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = $1", [streamUserId]);
    await pool.end();
});

describe("GET/POST /api/stream/companion/session", () => {
    it("requires a companion token", async () => {
        expect((await request(app).get("/api/stream/companion/session")).status).toBe(401);
        expect((await request(app).get("/api/stream/companion/session").set("Authorization", "Bearer not-a-real-token")).status).toBe(401);
        expect((await request(app).post("/api/stream/companion/session/reset")).status).toBe(401);
    });

    it("returns a fresh session summary with zero stats and no rating delta yet", async () => {
        const res = await request(app)
            .get("/api/stream/companion/session")
            .set("Authorization", `Bearer ${companionToken}`);

        expect(res.status).toBe(200);
        expect(res.body.wins).toBe(0);
        expect(res.body.losses).toBe(0);
        expect(res.body.sessionRatingDelta).toBeNull();
        expect(typeof res.body.id).toBe("string");
        expect(typeof res.body.startedAt).toBe("string");
        expect(typeof res.body.updatedAt).toBe("string");
    });

    it("reflects real wins/losses/updatedAt on the active session", async () => {
        await pool.query(
            `UPDATE stream_sessions SET wins = 4, losses = 3, updated_at = CURRENT_TIMESTAMP
             WHERE stream_user_id = $1 AND ended_at IS NULL`,
            [streamUserId]
        );

        const res = await request(app)
            .get("/api/stream/companion/session")
            .set("Authorization", `Bearer ${companionToken}`);

        expect(res.status).toBe(200);
        expect(res.body.wins).toBe(4);
        expect(res.body.losses).toBe(3);
    });

    it("resetting closes the old session and returns a fresh one, without deleting matches", async () => {
        const before = await request(app)
            .get("/api/stream/companion/session")
            .set("Authorization", `Bearer ${companionToken}`);
        const oldSessionId = before.body.id;

        await pool.query(
            `INSERT INTO stream_matches
                (stream_user_id, match_key, stream_session_id, hero_id, kills, deaths, assists, result, started_at, ended_at)
             VALUES ($1, $2, $3, 1, 1, 2, 3, 'win', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [streamUserId, `test:${oldSessionId}:${Date.now()}`, oldSessionId]
        );

        const res = await request(app)
            .post("/api/stream/companion/session/reset")
            .set("Authorization", `Bearer ${companionToken}`);

        expect(res.status).toBe(200);
        expect(res.body.id).not.toBe(oldSessionId);
        expect(res.body.wins).toBe(0);
        expect(res.body.losses).toBe(0);

        const oldSessionRow = await pool.query(
            "SELECT ended_at FROM stream_sessions WHERE id = $1",
            [oldSessionId]
        );
        expect(oldSessionRow.rows[0].ended_at).not.toBeNull();

        const oldMatches = await pool.query(
            "SELECT id FROM stream_matches WHERE stream_session_id = $1",
            [oldSessionId]
        );
        expect(oldMatches.rows).toHaveLength(1);

        // WK-83 acceptance: "Начать новый стрим" must not empty out
        // Recent Games (GET /account/me/matches has never been session-
        // scoped - see stream-match-service.ts's getRecentMatches - this
        // proves that already-correct behavior survives a reset).
        const accountMatches = await request(app)
            .get("/api/stream/account/me/matches")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(accountMatches.status).toBe(200);
        expect(
            accountMatches.body.some(
                (match: { streamSessionId: string }) => match.streamSessionId === oldSessionId
            )
        ).toBe(true);
    });
});
