import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { DEFAULT_OVERLAY_LAYOUT, saveOverlayLayout } from "../services/stream-overlay-layout-service.js";
import { getOrCreateActiveSession, endActiveSession, resetActiveSession } from "../services/stream-session-service.js";

// WK-98 - StreamEndedScene's match strip needs its own bounded session-
// history source on the public overlay, independent of the gameplay/draft
// HUD widget config that drives the ACTIVE-session `matches` field (see
// currentStreamLimit in controllers/stream/overlay.ts). Before this task,
// the ended branch reused that same HUD-driven limit - meaning a streamer
// with no "current-stream" HUD widget configured (or a low
// recentGamesLimit) would see the post-stream match strip come back empty
// or truncated for reasons that had nothing to do with the post-stream
// scene itself. This suite pins the new contract: a fixed cap of 20,
// completely decoupled from HUD/queue settings, with sessionSummary.
// matchCount remaining the honest uncapped total.

const suffix = `${Date.now()}-ended-match-cap`;
const createdUserIds: string[] = [];

interface TestUser {
    streamUserId: string;
    publicToken: string;
}

const createTestUser = async (label: string): Promise<TestUser> => {
    const email = `stream_ended_cap_${suffix}_${label}@example.com`;
    const publicToken = randomUUID();
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, publicToken]
    );
    const streamUserId = result.rows[0].id.toString();
    createdUserIds.push(streamUserId);
    return { streamUserId, publicToken };
};

const insertFinalizedMatch = async (streamUserId: string, sessionId: string, heroId: number) => {
    await pool.query(
        `INSERT INTO stream_matches
            (stream_user_id, match_key, stream_session_id, hero_id, kills, deaths, assists, result, started_at, ended_at)
         VALUES ($1, $2, $3, $4, 1, 2, 3, 'win', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [streamUserId, `test:${sessionId}:${heroId}:${Date.now()}:${Math.random()}`, sessionId, heroId]
    );
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

describe("public overlay ended-state match cap (WK-98)", () => {
    it("is independent of HUD widget config: still populated even when no widget is configured with source 'current-stream'", async () => {
        const user = await createTestUser("no-hud-widget");

        // No gameplay/draft HUD widget uses source: "current-stream" here -
        // before this task this made currentStreamLimit === 0, and the
        // (old) ended branch reused that same limit, returning `matches: []`
        // regardless of how many matches the session actually had.
        const layout = structuredClone(DEFAULT_OVERLAY_LAYOUT);
        for (const scene of Object.values(layout.scenes)) {
            scene.widgets.recentMatches.recentMatches = {
                ...scene.widgets.recentMatches.recentMatches,
                limit: 5,
                source: "recent-matches",
            };
        }
        await saveOverlayLayout(user.streamUserId, layout);

        const session = (await getOrCreateActiveSession(user.streamUserId))!;
        await insertFinalizedMatch(user.streamUserId, session.id, 10);
        await insertFinalizedMatch(user.streamUserId, session.id, 11);
        await endActiveSession(user.streamUserId);

        const res = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(res.status).toBe(200);
        expect(res.body.sessionState).toBe("ended");
        expect(res.body.matches).toHaveLength(2);
        expect(res.body.sessionSummary.matchCount).toBe(2);
    });

    it("caps the session match strip at 20 regardless of a larger true matchCount, which stays honest and uncapped", async () => {
        const user = await createTestUser("over-cap");
        const session = (await getOrCreateActiveSession(user.streamUserId))!;

        const totalMatches = 23;
        for (let heroId = 1; heroId <= totalMatches; heroId += 1) {
            await insertFinalizedMatch(user.streamUserId, session.id, heroId);
        }
        await endActiveSession(user.streamUserId);

        const res = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(res.status).toBe(200);
        expect(res.body.sessionState).toBe("ended");
        // Bounded strip - the frontend (StreamEndedScene) renders an honest
        // "+N" indicator using this gap, see stream-ended-scene.test.tsx.
        expect(res.body.matches).toHaveLength(20);
        expect(res.body.sessionSummary.matchCount).toBe(totalMatches);
        // Newest-first, most recent 20 of the 23 (heroId 4..23).
        expect(res.body.matches[0].heroId).toBe(totalMatches);
        expect(res.body.matches.map((m: { heroId: number }) => m.heroId)).not.toContain(1);
        expect(res.body.matches.map((m: { heroId: number }) => m.heroId)).not.toContain(2);
        expect(res.body.matches.map((m: { heroId: number }) => m.heroId)).not.toContain(3);
    });

    it("does not mix in a previous ended session's matches when a new session is later ended", async () => {
        const user = await createTestUser("no-cross-session-mix");

        const sessionA = (await getOrCreateActiveSession(user.streamUserId))!;
        await insertFinalizedMatch(user.streamUserId, sessionA.id, 40);
        await endActiveSession(user.streamUserId);

        const afterA = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(afterA.body.matches).toHaveLength(1);
        expect(afterA.body.matches[0].heroId).toBe(40);

        const sessionB = await resetActiveSession(user.streamUserId);
        await insertFinalizedMatch(user.streamUserId, sessionB.id, 41);
        await insertFinalizedMatch(user.streamUserId, sessionB.id, 42);
        await endActiveSession(user.streamUserId);

        const afterB = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(afterB.body.sessionSummary.sessionId).toBe(sessionB.id);
        expect(afterB.body.matches).toHaveLength(2);
        expect(afterB.body.matches.map((m: { heroId: number }) => m.heroId).sort()).toEqual([41, 42]);
    });

    it("leaves the active-session `matches` field's HUD-driven cap untouched (regression guard)", async () => {
        const user = await createTestUser("active-branch-unchanged");

        const layout = structuredClone(DEFAULT_OVERLAY_LAYOUT);
        for (const scene of Object.values(layout.scenes)) {
            scene.widgets.recentMatches.recentMatches = {
                ...scene.widgets.recentMatches.recentMatches,
                limit: 5,
                source: "recent-matches",
            };
        }
        await saveOverlayLayout(user.streamUserId, layout);

        const session = (await getOrCreateActiveSession(user.streamUserId))!;
        await insertFinalizedMatch(user.streamUserId, session.id, 50);

        const res = await request(app).get(`/api/stream/overlay/${user.publicToken}`);
        expect(res.status).toBe(200);
        expect(res.body.sessionState).toBe("active");
        // Unlike the ended branch above, the active branch's `matches` stays
        // gated by currentStreamLimit (0 here, since no widget uses
        // source: "current-stream") - this task must not change that.
        expect(res.body.matches).toEqual([]);
    });
});
