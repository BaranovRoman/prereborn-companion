import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { finalizeMatch, processGsiPayloadForMatch } from "../services/stream-match-service.js";
import { correctStreamMatch } from "../services/stream-match-correction-service.js";
import {
    applyAbsoluteRatingCorrection,
    getOrCreateActiveSession,
    resetActiveSession,
} from "../services/stream-session-service.js";
import { getSessionSummary } from "../services/stream-session-summary-service.js";
import { heroSelectionTick, postGameTick } from "./fixtures/gsi-payloads.js";

// WK-105 - разделение "коррекция delta конкретного матча" и "абсолютная
// коррекция Текущего MMR" (см. задачу/audit в PR): раньше глобальный ручной
// input рейтинга писал stream_sessions.rating напрямую, минуя цепочку
// ratingBefore/ratingDelta/ratingAfter, из-за чего session/Post Stream delta
// (session.rating - ratingStart) начинали включать абсолютную коррекцию как
// будто это результат матчей. Этот файл проверяет обе операции по
// отдельности и их взаимную изоляцию - см. описание сценариев по секциям
// ниже.

const suffix = `${Date.now()}-wk105`;
let userCounter = 0;
const createdUserIds: string[] = [];

interface TestUser {
    streamUserId: string;
    jwtToken: string;
}

const createTestUser = async (): Promise<TestUser> => {
    userCounter += 1;
    const email = `stream_wk105_${suffix}_${userCounter}@example.com`;
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
    return { streamUserId, jwtToken };
};

interface RawMatchRow {
    id: number;
    stream_session_id: number | null;
    hero_id: number;
    result: "win" | "loss" | "abandon" | null;
    is_ranked: boolean | null;
    rating_before: number | null;
    rating_delta: number | null;
    rating_after: number | null;
    detected_rating_delta: number | null;
    rating_delta_correction: number;
}

const getMatchRows = async (streamUserId: string): Promise<RawMatchRow[]> => {
    const result = await pool.query<RawMatchRow>(
        `SELECT id, stream_session_id, hero_id, result, is_ranked,
                rating_before, rating_delta, rating_after,
                detected_rating_delta, rating_delta_correction
         FROM stream_matches WHERE stream_user_id = $1 ORDER BY id ASC`,
        [streamUserId]
    );
    return result.rows;
};

interface RawSessionRow {
    id: number;
    rating: number | null;
    rating_adjustment: number;
    wins: number;
    losses: number;
}

const getActiveSessionRow = async (streamUserId: string): Promise<RawSessionRow> => {
    const result = await pool.query<RawSessionRow>(
        `SELECT id, rating, rating_adjustment, wins, losses FROM stream_sessions
         WHERE stream_user_id = $1 AND ended_at IS NULL`,
        [streamUserId]
    );
    return result.rows[0];
};

const setSessionRating = async (streamUserId: string, rating: number) => {
    await pool.query(
        `UPDATE stream_sessions SET rating = $2 WHERE stream_user_id = $1 AND ended_at IS NULL`,
        [streamUserId, rating]
    );
};

// Заводит один ranked-финализированный матч (auto win = +25 или auto loss =
// -25 в зависимости от result) через реальный GSI-пайплайн - как в
// stream-match-lifecycle.test.ts, чтобы detected_rating_delta по нему был
// подлинным (не подставленным вручную).
const playRankedMatch = async (
    streamUserId: string,
    heroId: number,
    matchId: string,
    result: "win" | "loss"
) => {
    await processGsiPayloadForMatch(streamUserId, heroSelectionTick(heroId, matchId));
    await processGsiPayloadForMatch(streamUserId, postGameTick(heroId, result, { matchId }));
    await processGsiPayloadForMatch(streamUserId, postGameTick(heroId, result, { matchId }));
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

describe("WK-105: per-match ratingDelta correction (detected vs correction)", () => {
    it("+25 -> +26 shifts effective delta and session total by exactly +1", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000001", "win");

        let rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({
            rating_before: 6000,
            rating_delta: 25,
            rating_after: 6025,
            detected_rating_delta: 25,
            rating_delta_correction: 0,
        });

        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 26 });
        rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({
            result: "win",
            rating_before: 6000,
            rating_delta: 26,
            rating_after: 6026,
            detected_rating_delta: 25,
            rating_delta_correction: 1,
        });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6026);
    });

    it("+25 -> +50 shifts by +25", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 5000);
        await playRankedMatch(streamUserId, 10, "700000002", "win");

        const rows = await getMatchRows(streamUserId);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 50 });
        const updated = (await getMatchRows(streamUserId))[0];
        expect(updated).toMatchObject({
            rating_before: 5000,
            rating_delta: 50,
            rating_after: 5050,
            detected_rating_delta: 25,
            rating_delta_correction: 25,
        });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(5050);
    });

    it("0 -> +25 and 0 -> +26 both work - zero is a valid starting AND target correction value", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 4000);
        await playRankedMatch(streamUserId, 11, "700000003", "win");
        await playRankedMatch(streamUserId, 11, "700000004", "win");

        let rows = await getMatchRows(streamUserId);
        // Симулируем реальный кейс задачи: "система записала +0 за победу" -
        // сначала корректируем обе auto +25 строки в 0, явно проверяя, что 0
        // сохраняется и не отбрасывается как falsy ни на одном уровне
        // (Zod/сервис/каскад).
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 0 });
        await correctStreamMatch(streamUserId, rows[1].id.toString(), { ratingDelta: 0 });
        rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({ rating_delta: 0, rating_after: 4000, rating_delta_correction: -25 });
        expect(rows[1]).toMatchObject({ rating_delta: 0, rating_after: 4000, rating_delta_correction: -25 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(4000);

        // Теперь "исправить" эти honest-zero записи на реальные +25/+26.
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 25 });
        const afterFirst = await getMatchRows(streamUserId);
        expect(afterFirst[0]).toMatchObject({ rating_delta: 25, rating_after: 4025 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(4025);

        await correctStreamMatch(streamUserId, afterFirst[1].id.toString(), { ratingDelta: 26 });
        const afterSecond = await getMatchRows(streamUserId);
        expect(afterSecond[1]).toMatchObject({ rating_before: 4025, rating_delta: 26, rating_after: 4051 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(4051);
    });

    it("-25 -> -27 shifts by -2", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 3000);
        await playRankedMatch(streamUserId, 12, "700000005", "loss");

        const rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({ rating_delta: -25, rating_after: 2975 });

        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: -27 });
        const updated = (await getMatchRows(streamUserId))[0];
        expect(updated).toMatchObject({
            result: "loss",
            rating_before: 3000,
            rating_delta: -27,
            rating_after: 2973,
            detected_rating_delta: -25,
            rating_delta_correction: -2,
        });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(2973);
    });

    it("correction of one match does not change its own W/L, result, or hero", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 5000);
        await playRankedMatch(streamUserId, 13, "700000006", "win");

        const before = await getActiveSessionRow(streamUserId);
        expect(before).toMatchObject({ wins: 1, losses: 0 });

        const rows = await getMatchRows(streamUserId);
        const corrected = await correctStreamMatch(streamUserId, rows[0].id.toString(), {
            ratingDelta: 100,
        });

        expect(corrected.match.result).toBe("win");
        expect(corrected.match.heroId).toBe(13);
        const after = await getActiveSessionRow(streamUserId);
        expect(after).toMatchObject({ wins: 1, losses: 0 });
    });

    it("correcting one match does not change a neighboring match's own rating_delta - only its before/after shift", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000007", "win"); // +25 -> 6025
        await playRankedMatch(streamUserId, 10, "700000008", "loss"); // -25 -> 6000
        await playRankedMatch(streamUserId, 10, "700000009", "win"); // +25 -> 6025

        let rows = await getMatchRows(streamUserId);
        expect(rows.map((r) => r.rating_delta)).toEqual([25, -25, 25]);

        // Correct the MIDDLE match: 0 -> +26, difference = +26.
        await correctStreamMatch(streamUserId, rows[1].id.toString(), { ratingDelta: 26 });
        rows = await getMatchRows(streamUserId);

        // Middle match: own delta becomes 26 (what we asked for).
        expect(rows[1]).toMatchObject({ rating_before: 6025, rating_delta: 26, rating_after: 6051 });
        // First match (before the edited one): completely untouched.
        expect(rows[0]).toMatchObject({ rating_before: 6000, rating_delta: 25, rating_after: 6025 });
        // Third match (after the edited one): own delta (25) unchanged, only
        // before/after shifted by the same difference (+26 - (-25) = +51).
        expect(rows[2].rating_delta).toBe(25);
        expect(rows[2].rating_before).toBe(6051);
        expect(rows[2].rating_after).toBe(6076);

        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6076);
    });

    it("repeated identical corrections are idempotent - no drift", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000010", "win");

        const rows = await getMatchRows(streamUserId);
        for (let i = 0; i < 3; i += 1) {
            await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 26 });
        }
        const updated = (await getMatchRows(streamUserId))[0];
        expect(updated).toMatchObject({
            rating_delta: 26,
            rating_after: 6026,
            detected_rating_delta: 25,
            rating_delta_correction: 1,
        });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6026);
    });

    it("changing only result on an already manually-corrected match preserves its rating_delta/detected/correction untouched", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000014", "win");

        const rows = await getMatchRows(streamUserId);
        // Manual correction: +25 -> +100 (rating_source becomes "manual").
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 100 });
        const corrected = (await getMatchRows(streamUserId))[0];
        expect(corrected).toMatchObject({
            rating_delta: 100,
            detected_rating_delta: 25,
            rating_delta_correction: 75,
        });

        // Now flip result only (no rating fields in the command) - this hits
        // the "resultChanged" default-rebuild branch, which must preserve
        // the already-manual delta verbatim rather than reverting to ±25.
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { result: "loss" });
        const afterResultFlip = (await getMatchRows(streamUserId))[0];
        expect(afterResultFlip).toMatchObject({
            result: "loss",
            rating_delta: 100,
            rating_after: 6100,
            detected_rating_delta: 25,
            rating_delta_correction: 75,
        });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6100);
    });

    it("+25 -> +26 -> +25 returns to the exact original state", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000011", "win");

        const rows = await getMatchRows(streamUserId);
        const original = rows[0];

        await correctStreamMatch(streamUserId, original.id.toString(), { ratingDelta: 26 });
        await correctStreamMatch(streamUserId, original.id.toString(), { ratingDelta: 25 });

        const restored = (await getMatchRows(streamUserId))[0];
        expect(restored).toEqual(original);
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6025);
    });

    it("late finalizeMatch call after a manual correction does not clobber it (idempotent finalize)", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000012", "win");

        const rows = await getMatchRows(streamUserId);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 26 });

        // Simulate a duplicate/late finalize call reaching the same row
        // (e.g. a retried GSI-driven finalize race) - finalizeMatch's own
        // `WHERE finalized_at IS NULL` guard must make this a no-op against
        // an already-finalized, already-corrected row.
        const finalizedAgain = await finalizeMatch(rows[0].id, "late_retry_test");
        expect(finalizedAgain).toBe(false);

        const afterLateFinalize = (await getMatchRows(streamUserId))[0];
        expect(afterLateFinalize).toMatchObject({
            rating_delta: 26,
            rating_after: 6026,
            rating_delta_correction: 1,
        });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6026);
    });

    it("unranked match never gets a fabricated rating from correction bookkeeping", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000013", "win");

        const rows = await getMatchRows(streamUserId);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { isRanked: false });
        const updated = (await getMatchRows(streamUserId))[0];
        expect(updated).toMatchObject({
            is_ranked: false,
            rating_before: null,
            rating_delta: null,
            rating_after: null,
            detected_rating_delta: null,
            rating_delta_correction: 0,
        });
    });
});

describe("WK-105: absolute Current MMR correction (applyAbsoluteRatingCorrection)", () => {
    it("does not rewrite match history - ratingBefore/Delta/After of existing matches stay exactly the same", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000101", "win");

        const before = await getMatchRows(streamUserId);
        await applyAbsoluteRatingCorrection(streamUserId, 6100);
        const after = await getMatchRows(streamUserId);
        expect(after).toEqual(before);
    });

    it("applies the diff to session.rating and accumulates it in rating_adjustment", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 5980);

        const result = await applyAbsoluteRatingCorrection(streamUserId, 5992);
        expect(result).toMatchObject({ previousRating: 5980, adjustmentDelta: 12 });
        expect(result!.session.rating).toBe(5992);
        expect(result!.session.ratingAdjustment).toBe(12);

        const row = await getActiveSessionRow(streamUserId);
        expect(row).toMatchObject({ rating: 5992, rating_adjustment: 12 });
    });

    it("first-time rating entry (previous was null) does not fabricate an adjustment", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);

        const result = await applyAbsoluteRatingCorrection(streamUserId, 4000);
        expect(result).toMatchObject({ previousRating: null, adjustmentDelta: 0 });
        expect(result!.session.rating).toBe(4000);
        expect(result!.session.ratingAdjustment).toBe(0);
    });

    it("clearing rating to null does not fabricate an adjustment either", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 5000);

        const result = await applyAbsoluteRatingCorrection(streamUserId, null);
        expect(result).toMatchObject({ previousRating: 5000, adjustmentDelta: 0 });
        expect(result!.session.rating).toBeNull();
        expect(result!.session.ratingAdjustment).toBe(0);
    });

    it("multiple consecutive absolute corrections accumulate correctly in the ledger", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);

        await applyAbsoluteRatingCorrection(streamUserId, 6010); // +10
        await applyAbsoluteRatingCorrection(streamUserId, 6005); // -5
        const result = await applyAbsoluteRatingCorrection(streamUserId, 6008); // +3

        expect(result!.session.rating).toBe(6008);
        expect(result!.session.ratingAdjustment).toBe(8); // +10 -5 +3
    });

    it("returns null when there is no active session (stream explicitly ended)", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${jwtToken}`);

        const result = await applyAbsoluteRatingCorrection(streamUserId, 6000);
        expect(result).toBeNull();
    });

    it("PATCH /account/session with rating routes through the absolute correction, not a direct overwrite", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000102", "win"); // -> 6025

        const res = await request(app)
            .patch("/api/stream/account/session")
            .set("Authorization", `Bearer ${jwtToken}`)
            .send({ rating: 6029 });

        expect(res.status).toBe(200);
        expect(res.body.rating).toBe(6029);
        expect(res.body.ratingAdjustment).toBe(4);

        // History is untouched by the HTTP round-trip either.
        const rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({ rating_before: 6000, rating_delta: 25, rating_after: 6025 });
    });
});

describe("WK-105: the task's own worked example end-to-end", () => {
    it("6000 -> +25 / auto+0->manual+26 / -25 => 6026, then Set Current MMR=6029 => adjustment +3, session delta stays +26", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);

        await playRankedMatch(streamUserId, 14, "700000201", "win"); // auto +25 -> 6025
        await playRankedMatch(streamUserId, 14, "700000202", "win"); // auto +25, will be corrected to +0 then +26
        await playRankedMatch(streamUserId, 14, "700000203", "loss"); // auto -25

        let rows = await getMatchRows(streamUserId);
        expect(rows.map((r) => r.rating_delta)).toEqual([25, 25, -25]);
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6025);

        // "система записала +0" - simulate by first correcting match 2 down
        // to 0 (an honest, real recorded zero, not a null/missing delta).
        await correctStreamMatch(streamUserId, rows[1].id.toString(), { ratingDelta: 0 });
        rows = await getMatchRows(streamUserId);
        expect(rows[1]).toMatchObject({ rating_before: 6025, rating_delta: 0, rating_after: 6025 });
        expect(rows[2]).toMatchObject({ rating_before: 6025, rating_delta: -25, rating_after: 6000 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6000);

        // User corrects it to the real value: +26.
        await correctStreamMatch(streamUserId, rows[1].id.toString(), { ratingDelta: 26 });
        rows = await getMatchRows(streamUserId);
        expect(rows[1]).toMatchObject({ rating_before: 6025, rating_delta: 26, rating_after: 6051 });
        expect(rows[2]).toMatchObject({ rating_before: 6051, rating_delta: -25, rating_after: 6026 });

        const session = await getActiveSessionRow(streamUserId);
        expect(session.rating).toBe(6026);
        expect(session.rating_adjustment).toBe(0);

        const activeSession = await getOrCreateActiveSession(streamUserId);
        const summaryAfterCorrection = await getSessionSummary(streamUserId, activeSession!);
        expect(summaryAfterCorrection.ratingStart).toBe(6000);
        expect(summaryAfterCorrection.ratingEnd).toBe(6026);
        expect(summaryAfterCorrection.ratingDelta).toBe(26);
        expect(summaryAfterCorrection.ratingAdjustment).toBe(0);

        // Now the user checks Dota and sees 6029: Set Current MMR = 6029.
        const correction = await applyAbsoluteRatingCorrection(streamUserId, 6029);
        expect(correction!.adjustmentDelta).toBe(3);
        expect(correction!.session.rating).toBe(6029);
        expect(correction!.session.ratingAdjustment).toBe(3);

        // History remains exactly +25 / +26 / -25 - the +3 is attributed to
        // no match at all.
        rows = await getMatchRows(streamUserId);
        expect(rows.map((r) => r.rating_delta)).toEqual([25, 26, -25]);

        // Session match delta stays +26 (not +29) - the absolute correction
        // must not leak into "what the matches did this session".
        const sessionAfterAdjustment = await getOrCreateActiveSession(streamUserId);
        const summaryAfterAdjustment = await getSessionSummary(streamUserId, sessionAfterAdjustment!);
        expect(summaryAfterAdjustment.ratingStart).toBe(6000);
        expect(summaryAfterAdjustment.ratingEnd).toBe(6029);
        expect(summaryAfterAdjustment.ratingDelta).toBe(26);
        expect(summaryAfterAdjustment.ratingAdjustment).toBe(3);

        // A new stream started after this inherits 6029 as its starting
        // point, and the previous match's delta does not turn into +29 or
        // any other invented value.
        const newSession = await resetActiveSession(streamUserId);
        expect(newSession.rating).toBe(6029);
        expect(newSession.ratingAdjustment).toBe(0); // fresh session row, ledger resets for it specifically
        rows = await getMatchRows(streamUserId);
        expect(rows.map((r) => r.rating_delta)).toEqual([25, 26, -25]);
    });
});

describe("WK-105: cross-session isolation and historical summaries", () => {
    it("correcting a match from an ended session does not affect a different, later active session's totals", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 5000);
        await playRankedMatch(streamUserId, 15, "700000301", "win"); // session A -> 5025

        await request(app).post("/api/stream/account/session/end").set(
            "Authorization",
            `Bearer ${jwt.sign({ streamUserId }, process.env.STREAM_JWT_SECRET!, { expiresIn: "5m" })}`
        );
        const sessionB = await resetActiveSession(streamUserId);
        await playRankedMatch(streamUserId, 16, "700000302", "loss"); // session B -> 5025 - 25... anchored to whatever B's rating is

        const beforeCorrection = await pool.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions WHERE id = $1`,
            [sessionB.id]
        );

        const rows = await getMatchRows(streamUserId);
        const sessionAMatch = rows.find((r) => r.stream_session_id !== Number(sessionB.id))!;
        await correctStreamMatch(streamUserId, sessionAMatch.id.toString(), { ratingDelta: 100 });

        const afterCorrection = await pool.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions WHERE id = $1`,
            [sessionB.id]
        );
        expect(afterCorrection.rows[0].rating).toBe(beforeCorrection.rows[0].rating);
    });

    it("an ended session continues to show correct historical ratingDelta via getSessionSummary", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 4500);
        await playRankedMatch(streamUserId, 17, "700000401", "win");
        await playRankedMatch(streamUserId, 17, "700000402", "win");

        const endRes = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(endRes.body.summary.ratingStart).toBe(4500);
        expect(endRes.body.summary.ratingEnd).toBe(4550);
        expect(endRes.body.summary.ratingDelta).toBe(50);

        // Re-fetch later - still consistent (not cached/frozen incorrectly).
        const getRes = await request(app)
            .get("/api/stream/account/session")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(getRes.body.state).toBe("ended");
        expect(getRes.body.summary.ratingDelta).toBe(50);
    });
});
