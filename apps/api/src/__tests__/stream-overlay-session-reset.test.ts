import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { getRecentMatchesForSession } from "../services/stream-match-service.js";
import { DEFAULT_OVERLAY_LAYOUT, saveOverlayLayout } from "../services/stream-overlay-layout-service.js";

// Регрессия: "начать новый стрим" не должен оставлять в публичном overlay
// список матчей от предыдущей (уже закрытой) сессии - см. задачу. Матчи в
// БД не удаляются (нужны для authenticated-истории), но overlay-payload
// обязан показывать только матчи ТЕКУЩЕЙ активной сессии.
const suffix = `${Date.now()}-session-reset`;
const email = `stream_session_reset_${suffix}@example.com`;
const publicToken = randomUUID();

let streamUserId: number;
let closedSessionId: number;
let activeSessionId: number;

const insertMatch = async (sessionId: number, heroId: number) => {
    await pool.query(
        `INSERT INTO stream_matches
            (stream_user_id, match_key, stream_session_id, hero_id, kills, deaths, assists, result, started_at, ended_at)
         VALUES ($1, $2, $3, $4, 1, 2, 3, 'win', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [streamUserId, `test:${sessionId}:${heroId}:${Date.now()}:${Math.random()}`, sessionId, heroId]
    );
};

beforeAll(async () => {
    await createTables();

    const hashed = await bcrypt.hash("test-password-123", 10);
    const userResult = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, publicToken]
    );
    streamUserId = userResult.rows[0].id;

    // Старая, уже закрытая сессия (как после "начать новый стрим") с матчем -
    // должна оставаться в БД, но не показываться в overlay.
    const closedResult = await pool.query(
        `INSERT INTO stream_sessions (stream_user_id, ended_at) VALUES ($1, CURRENT_TIMESTAMP) RETURNING id`,
        [streamUserId]
    );
    closedSessionId = closedResult.rows[0].id;
    await insertMatch(closedSessionId, 1);

    // Новая активная сессия (ended_at IS NULL) - только её матчи должны
    // попасть в overlay-payload.
    const activeResult = await pool.query(
        `INSERT INTO stream_sessions (stream_user_id) VALUES ($1) RETURNING id`,
        [streamUserId]
    );
    activeSessionId = activeResult.rows[0].id;
    await insertMatch(activeSessionId, 2);
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = $1", [streamUserId]);
    await pool.end();
});

describe("overlay recent matches after session reset", () => {
    it("getRecentMatchesForSession only returns matches of the given session", async () => {
        const closedMatches = await getRecentMatchesForSession(closedSessionId.toString());
        expect(closedMatches).toHaveLength(1);
        expect(closedMatches[0].heroId).toBe(1);

        const activeMatches = await getRecentMatchesForSession(activeSessionId.toString());
        expect(activeMatches).toHaveLength(1);
        expect(activeMatches[0].heroId).toBe(2);
    });

    it("public overlay payload only shows the active session's matches", async () => {
        const res = await request(app).get(`/api/stream/overlay/${publicToken}`);

        expect(res.status).toBe(200);
        expect(res.body.matches).toHaveLength(1);
        expect(res.body.matches[0].heroId).toBe(2);
    });

    it("Recent matches ignores the session boundary without filling current stream", async () => {
        const layout = structuredClone(DEFAULT_OVERLAY_LAYOUT);
        for (const scene of Object.values(layout.scenes)) {
            scene.widgets.recentMatches.recentMatches = { ...scene.widgets.recentMatches.recentMatches, limit: 10, source: "recent-matches" };
        }
        await saveOverlayLayout(streamUserId.toString(), layout);
        const res = await request(app).get(`/api/stream/overlay/${publicToken}`);
        expect(res.status).toBe(200);
        expect(res.body.matches).toEqual([]);
        expect(res.body.recentMatches.map((match: { heroId: number }) => match.heroId)).toEqual([2, 1]);
    });

    it("returns more than five current-stream matches without previous-session rows", async () => {
        for (let heroId = 3; heroId <= 9; heroId += 1) await insertMatch(activeSessionId, heroId);
        const layout = structuredClone(DEFAULT_OVERLAY_LAYOUT);
        for (const scene of Object.values(layout.scenes)) {
            scene.widgets.recentMatches.recentMatches = { ...scene.widgets.recentMatches.recentMatches, limit: 8, source: "current-stream" };
        }
        await saveOverlayLayout(streamUserId.toString(), layout);
        const res = await request(app).get(`/api/stream/overlay/${publicToken}`);
        expect(res.status).toBe(200);
        expect(res.body.matches).toHaveLength(8);
        expect(res.body.matches.map((match: { heroId: number }) => match.heroId)).not.toContain(1);
        // WK-89 - recentMatches (Between Matches' account-wide history) must
        // stay populated from queueSettings.widgets.recentGamesLimit even
        // when no HUD widget is configured with source: "recent-matches" -
        // it must NOT go empty just because gameplay HUD config didn't ask
        // for it. Unlike `matches` above, this DOES include heroId 1 (the
        // previous, closed session's match).
        expect(res.body.recentMatches.length).toBeGreaterThan(0);
        expect(
            res.body.recentMatches.map((match: { heroId: number }) => match.heroId)
        ).toContain(1);
        expect(res.body.recentMatches[0]).toHaveProperty("streamSessionId");
    });
});

// WK-89 - regression for the actual reported bug: Between Matches (Last
// Match/Recent Games, account-wide) must survive a REAL "start new stream"
// (resetActiveSession), while the gameplay HUD's session-scoped `matches`
// correctly does reset. Uses its own user (isolated from the describe block
// above) to exercise the full lifecycle without depending on state built up
// by other tests.
describe("account-wide history survives a real session reset", () => {
    const lifecycleSuffix = `${Date.now()}-session-reset-lifecycle`;
    const lifecycleEmail = `stream_session_reset_lifecycle_${lifecycleSuffix}@example.com`;
    const lifecyclePublicToken = randomUUID();
    let lifecycleStreamUserId: number;

    const insertFinalizedMatch = async (sessionId: string, heroId: number) => {
        await pool.query(
            `INSERT INTO stream_matches
                (stream_user_id, match_key, stream_session_id, hero_id, kills, deaths, assists, result, started_at, ended_at)
             VALUES ($1, $2, $3, $4, 1, 2, 3, 'win', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                lifecycleStreamUserId,
                `test:${sessionId}:${heroId}:${Date.now()}:${Math.random()}`,
                sessionId,
                heroId,
            ]
        );
    };

    beforeAll(async () => {
        const hashed = await bcrypt.hash("test-password-123", 10);
        const userResult = await pool.query(
            `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
            [lifecycleEmail, hashed, lifecyclePublicToken]
        );
        lifecycleStreamUserId = userResult.rows[0].id;
    });

    afterAll(async () => {
        await pool.query("DELETE FROM stream_users WHERE id = $1", [lifecycleStreamUserId]);
    });

    it("keeps Last Match/Recent Games account-wide across reset, dims the old session, and un-dims a new one", async () => {
        const { getOrCreateActiveSession, resetActiveSession } = await import(
            "../services/stream-session-service.js"
        );

        const sessionA = await getOrCreateActiveSession(lifecycleStreamUserId.toString());
        await insertFinalizedMatch(sessionA.id, 10);
        await insertFinalizedMatch(sessionA.id, 11);

        const beforeReset = await request(app).get(
            `/api/stream/overlay/${lifecyclePublicToken}`
        );
        expect(beforeReset.body.matches.map((m: { heroId: number }) => m.heroId)).toEqual([11, 10]);
        expect(
            beforeReset.body.recentMatches.map((m: { heroId: number }) => m.heroId)
        ).toEqual([11, 10]);

        // "Начать новый стрим"
        const sessionB = await resetActiveSession(lifecycleStreamUserId.toString());
        expect(sessionB.id).not.toBe(sessionA.id);

        const afterReset = await request(app).get(
            `/api/stream/overlay/${lifecyclePublicToken}`
        );
        // Gameplay HUD (session-scoped) correctly resets to empty.
        expect(afterReset.body.matches).toEqual([]);
        // Between Matches (account-wide) keeps the old matches - this is the
        // actual bug being fixed here.
        expect(
            afterReset.body.recentMatches.map((m: { heroId: number }) => m.heroId)
        ).toEqual([11, 10]);
        expect(
            afterReset.body.recentMatches.every(
                (m: { streamSessionId: string }) => m.streamSessionId === sessionA.id
            )
        ).toBe(true);

        // A new match lands under the new session B.
        await insertFinalizedMatch(sessionB.id, 12);
        const afterNewMatch = await request(app).get(
            `/api/stream/overlay/${lifecyclePublicToken}`
        );
        expect(
            afterNewMatch.body.matches.map((m: { heroId: number }) => m.heroId)
        ).toEqual([12]);
        expect(
            afterNewMatch.body.recentMatches.map((m: { heroId: number }) => m.heroId)
        ).toEqual([12, 11, 10]);
        const sessionIdByHero = new Map<number, string>(
            afterNewMatch.body.recentMatches.map(
                (m: { heroId: number; streamSessionId: string }) => [m.heroId, m.streamSessionId]
            )
        );
        // The frontend (isMatchFromCurrentSession) dims a match whenever its
        // streamSessionId differs from the active session id - so 12 renders
        // full-opacity ("current") and 11/10 render dimmed ("previous").
        expect(sessionIdByHero.get(12)).toBe(sessionB.id);
        expect(sessionIdByHero.get(11)).toBe(sessionA.id);
        expect(sessionIdByHero.get(10)).toBe(sessionA.id);
    });
});
