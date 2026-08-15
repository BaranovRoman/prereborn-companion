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
        expect(res.body.recentMatches).toEqual([]);
    });
});
