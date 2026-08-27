import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { finalizeMatch, processGsiPayloadForMatch } from "../services/stream-match-service.js";
import { setGameMode } from "../services/stream-user-service.js";
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

    // WK-105 audit (post-review fix #2) - found alongside the
    // contributionDifference fix: when the edited match has no rating_before
    // anchor of its own (first match of the session, played while
    // session.rating was still null) AND the whole tail stays anchor-less
    // too, `tailRatingAfter` never leaves null - the old
    // `if (tailRatingAfter !== null)` guard then skipped the
    // `UPDATE stream_sessions SET rating = ...` entirely, even though the
    // match's own contribution to session.rating (backed in later via an
    // absolute correction landing on top of it) must still be backed out.
    it("backs out the match's own contribution from session.rating even with no rating_before anchor of its own", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        // session.rating stays null through this match - finalizeMatch's
        // `rating = COALESCE($3, rating)` never touches it since
        // ratingAfter is null with no anchor.
        await playRankedMatch(streamUserId, 10, "700000014", "win"); // rating_delta +25, rating_after null

        expect((await getActiveSessionRow(streamUserId)).rating).toBeNull();

        await applyAbsoluteRatingCorrection(streamUserId, 6000);
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6000);

        const rows = await getMatchRows(streamUserId);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { isRanked: false });

        const updated = (await getMatchRows(streamUserId))[0];
        expect(updated).toMatchObject({
            is_ranked: false,
            rating_before: null,
            rating_delta: null,
            rating_after: null,
        });
        // The match's old +25 contribution must be backed out of
        // session.rating, not left stale at 6000.
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(5975);
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

describe("WK-105 audit (post-review): absolute adjustment must survive a later match correction", () => {
    // Found during review: correctStreamMatch used to write
    // `session.rating = tailRatingAfter` outright, which silently erased
    // any rating_adjustment that wasn't reachable from the match chain
    // itself (applyAbsoluteRatingCorrection never touches stream_matches).
    // Fixed to shift the session's CURRENT rating by exactly the edited
    // match's own delta change instead of overwriting it wholesale - see
    // stream-match-correction-service.ts's contributionDifference comment.
    it("adjustment applied BEFORE a match correction is preserved, not swallowed", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000501", "win"); // -> 6025

        const adjustment = await applyAbsoluteRatingCorrection(streamUserId, 6030); // +5
        expect(adjustment!.adjustmentDelta).toBe(5);
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6030);

        const rows = await getMatchRows(streamUserId);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 26 }); // +1

        const session = await getActiveSessionRow(streamUserId);
        expect(session.rating).toBe(6031); // 6030 + 1, not 6026
        expect(session.rating_adjustment).toBe(5); // ledger itself is untouched by match corrections

        const match = (await getMatchRows(streamUserId))[0];
        expect(match).toMatchObject({ rating_before: 6000, rating_delta: 26, rating_after: 6026 });
    });

    it("adjustment applied AFTER a match correction, then a second correction, still preserves it", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000502", "win"); // -> 6025

        const rows = await getMatchRows(streamUserId);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 26 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6026);

        const adjustment = await applyAbsoluteRatingCorrection(streamUserId, 6030); // +4
        expect(adjustment!.adjustmentDelta).toBe(4);

        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 27 }); // +1 more
        const session = await getActiveSessionRow(streamUserId);
        expect(session.rating).toBe(6031); // 6030 + 1
        expect(session.rating_adjustment).toBe(4); // still exactly the +4, not consumed
    });

    it("Set Current MMR correctly reflects the match's ratingBefore for the NEXT real match", async () => {
        // Audit concern #5's second half: if Current MMR is corrected
        // between M1 and M2, M2 must anchor to the corrected value, not a
        // stale derived one.
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000503", "win"); // M1 -> 6025

        await applyAbsoluteRatingCorrection(streamUserId, 6040); // streamer syncs with Dota mid-stream

        await playRankedMatch(streamUserId, 10, "700000504", "win"); // M2, should anchor at 6040
        const rows = await getMatchRows(streamUserId);
        expect(rows[1]).toMatchObject({ rating_before: 6040, rating_delta: 25, rating_after: 6065 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6065);
    });
});

describe("WK-105 audit (post-review): rating_adjustment is a cumulative offset, not a running diff", () => {
    it("matches the audit's exact worked numbers: 6025 -> set 6030 (+5) -> set 6028 (+3 total) -> set 6032 (+7 total)", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000505", "win"); // -> 6025

        const first = await applyAbsoluteRatingCorrection(streamUserId, 6030);
        expect(first).toMatchObject({ adjustmentDelta: 5 });
        expect(first!.session.ratingAdjustment).toBe(5);

        const second = await applyAbsoluteRatingCorrection(streamUserId, 6028);
        expect(second).toMatchObject({ adjustmentDelta: -2 });
        expect(second!.session.ratingAdjustment).toBe(3); // NOT -2, and not a fresh/reset value

        const third = await applyAbsoluteRatingCorrection(streamUserId, 6032);
        expect(third).toMatchObject({ adjustmentDelta: 4 });
        expect(third!.session.ratingAdjustment).toBe(7);
        expect(third!.session.rating).toBe(6032);
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

describe("WK-105: correction of a match from an already-ended session is rejected outright", () => {
    // Audit finding (post-implementation review): correcting a match whose
    // session has already ended would only ever update THAT (orphaned)
    // session's own `rating` column - it can never propagate forward into
    // the account's actual current session (nor shift any later session's
    // ratingStart), because resetActiveSession copies `rating` as a one-shot
    // snapshot at transition time, not a live reference. Properly supporting
    // "fix an old match and have it ripple forward through every later
    // session, preserving each one's own independent absolute corrections"
    // is a materially bigger feature than this ticket's scope - so instead
    // of leaving the behavior silently inconsistent (an undefined "gap"
    // between what an ended session shows and what the current one shows),
    // correctStreamMatch rejects the command outright (MatchSessionEndedError)
    // for any match belonging to a non-active session. This test proves that
    // explicitly, using exactly the scenario from the audit: Session A
    // (start 6000, +25 -> ends at 6025), Session B (start 6025, +25 -> 6050).
    it("rejects a rating correction on Session A's match once Session B is active, and leaves everything untouched", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 15, "700000301", "win"); // session A: 6000 -> 6025

        const sessionAId = (await getActiveSessionRow(streamUserId)).id;
        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${jwtToken}`);

        const sessionB = await resetActiveSession(streamUserId); // starts at 6025
        await playRankedMatch(streamUserId, 16, "700000302", "win"); // session B: 6025 -> 6050

        const rows = await getMatchRows(streamUserId);
        const sessionAMatch = rows.find((r) => r.stream_session_id === sessionAId)!;

        const sessionARowBefore = await pool.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions WHERE id = $1`,
            [sessionAId]
        );
        const sessionBRowBefore = await pool.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions WHERE id = $1`,
            [sessionB.id]
        );
        expect(sessionARowBefore.rows[0].rating).toBe(6025);
        expect(sessionBRowBefore.rows[0].rating).toBe(6050);

        await expect(
            correctStreamMatch(streamUserId, sessionAMatch.id.toString(), { ratingDelta: 26 })
        ).rejects.toThrow("already ended");

        // Nothing moved: not Session A's own (now orphaned) rating, not
        // Session B's (the account's actual current MMR), and not the
        // match row itself. No "Session A end = 6026 / Session B start =
        // 6025" gap can appear, because the command never took effect.
        const sessionARowAfter = await pool.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions WHERE id = $1`,
            [sessionAId]
        );
        const sessionBRowAfter = await pool.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions WHERE id = $1`,
            [sessionB.id]
        );
        expect(sessionARowAfter.rows[0].rating).toBe(6025);
        expect(sessionBRowAfter.rows[0].rating).toBe(6050);

        const untouchedMatch = (await getMatchRows(streamUserId)).find(
            (r) => r.id === sessionAMatch.id
        )!;
        expect(untouchedMatch.rating_delta).toBe(25);

        // The API surface (used by the "Полная история" UI) rejects with a
        // 409, not a silent 200 - the correction is unreachable end-to-end.
        const res = await request(app)
            .patch(`/api/stream/account/me/matches/${sessionAMatch.id}`)
            .set("Authorization", `Bearer ${jwtToken}`)
            .send({ ratingDelta: 26 });
        expect(res.status).toBe(409);
    });

    it("still allows discard (needs_review resolution) regardless of session state - it never touches rating", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 17, "700000303", "win");

        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${jwtToken}`);

        // A match still in an ended session can be discarded (if it were
        // needs_review) without hitting the new guard - discard returns
        // early before the session-active check and never touches rating.
        const rows = await getMatchRows(streamUserId);
        await pool.query(`UPDATE stream_matches SET state = 'needs_review' WHERE id = $1`, [
            rows[0].id,
        ]);
        const result = await correctStreamMatch(streamUserId, rows[0].id.toString(), {
            discard: true,
        });
        expect(result.match.finalizeReason).toBe("manual_discard");
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

describe("WK-105 audit: legacy (migrated) rows with detected_rating_delta = NULL", () => {
    // Simulates exactly what db/migrate.ts's backfill produces for a match
    // that was manually corrected BEFORE WK-105 shipped: the pre-migration
    // code overwrote rating_delta in place with no history, so the true
    // original auto-detected value is genuinely unrecoverable - the backfill
    // honestly leaves detected_rating_delta NULL and attributes the entire
    // current rating_delta to rating_delta_correction (see migrate.ts).
    // Mutates a normally-finalized row directly via SQL to reach that exact
    // state without needing to fabricate a full legacy INSERT.
    // Also keeps stream_sessions.rating in sync with the mutated match row -
    // the real pre-migration correctStreamMatch always did (its own bug
    // aside, it never left rating_after and session.rating pointing at
    // different numbers) - these tests use a single-match session, so the
    // match's new rating_after IS the session's rating.
    const markAsLegacyManualCorrection = async (matchId: number, ratingDelta: number) => {
        const row = await pool.query<{ rating_before: number | null; stream_session_id: number | null }>(
            `SELECT rating_before, stream_session_id FROM stream_matches WHERE id = $1`,
            [matchId]
        );
        const ratingBefore = row.rows[0].rating_before!;
        const ratingAfter = ratingBefore + ratingDelta;
        await pool.query(
            `UPDATE stream_matches
             SET rating_delta = $2, rating_after = $3, rating_source = 'manual',
                 detected_rating_delta = NULL, rating_delta_correction = $2
             WHERE id = $1`,
            [matchId, ratingDelta, ratingAfter]
        );
        await pool.query(`UPDATE stream_sessions SET rating = $2 WHERE id = $1`, [
            row.rows[0].stream_session_id,
            ratingAfter,
        ]);
    };

    it("effectiveRatingDelta for a legacy row is exactly its rating_delta (detected treated as 0), not NULL", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000601", "win"); // rating_delta=25 initially

        const rows = await getMatchRows(streamUserId);
        await markAsLegacyManualCorrection(rows[0].id, 40); // "legacy" pre-migration correction to +40

        const legacy = (await getMatchRows(streamUserId))[0];
        expect(legacy.detected_rating_delta).toBeNull();
        expect(legacy.rating_delta_correction).toBe(40);
        expect(legacy.rating_delta).toBe(40); // (detected ?? 0) + correction = 0 + 40 = 40
    });

    it("repeated edits on a legacy null-detected row do not accumulate error: +40 -> +25 -> +40 -> +25", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000602", "win");

        const rows = await getMatchRows(streamUserId);
        await markAsLegacyManualCorrection(rows[0].id, 40);
        const matchId = rows[0].id.toString();

        await correctStreamMatch(streamUserId, matchId, { ratingDelta: 25 });
        let row = (await getMatchRows(streamUserId))[0];
        expect(row).toMatchObject({ detected_rating_delta: null, rating_delta_correction: 25, rating_delta: 25 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6025);

        await correctStreamMatch(streamUserId, matchId, { ratingDelta: 40 });
        row = (await getMatchRows(streamUserId))[0];
        expect(row).toMatchObject({ detected_rating_delta: null, rating_delta_correction: 40, rating_delta: 40 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6040);

        await correctStreamMatch(streamUserId, matchId, { ratingDelta: 25 });
        row = (await getMatchRows(streamUserId))[0];
        // Exactly back to the first correction's state - no drift from the
        // repeated null-baseline diffing.
        expect(row).toMatchObject({ detected_rating_delta: null, rating_delta_correction: 25, rating_delta: 25 });
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6025);
    });

    it("a repeated/late finalizeMatch call on a legacy corrected row is a no-op - detected/correction/effective stay exactly as corrected", async () => {
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000603", "win");

        const rows = await getMatchRows(streamUserId);
        await markAsLegacyManualCorrection(rows[0].id, 40);
        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingDelta: 33 });

        const beforeRetry = (await getMatchRows(streamUserId))[0];
        expect(beforeRetry).toMatchObject({
            detected_rating_delta: null,
            rating_delta_correction: 33,
            rating_delta: 33,
        });

        // Simulate a duplicate GSI delivery reaching finalizeMatch again for
        // this same (already finalized, since migrated) row.
        const finalizedAgain = await finalizeMatch(rows[0].id, "late_duplicate_delivery");
        expect(finalizedAgain).toBe(false);

        const afterRetry = (await getMatchRows(streamUserId))[0];
        expect(afterRetry).toEqual(beforeRetry);
        expect((await getActiveSessionRow(streamUserId)).rating).toBe(6033);
    });
});

describe("WK-105 audit concern #9: Post Stream delta reflects matches only, never the absolute adjustment", () => {
    it("start 6000, matches give +25, Set Current MMR=6030 (+5 adjustment) -> Post Stream shows +25, current MMR is 6030", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000701", "win"); // +25 -> 6025

        await applyAbsoluteRatingCorrection(streamUserId, 6030); // +5, syncing with Dota client

        const session = await getOrCreateActiveSession(streamUserId);
        const summary = await getSessionSummary(streamUserId, session!);
        expect(summary.ratingDelta).toBe(25); // matches only, NOT +30
        expect(summary.ratingEnd).toBe(6030); // current MMR, includes the adjustment
        expect(summary.ratingAdjustment).toBe(5);

        // Same story via the actual "Завершить стрим" HTTP endpoint.
        const endRes = await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(endRes.body.summary.ratingDelta).toBe(25);
        expect(endRes.body.summary.ratingEnd).toBe(6030);
        expect(endRes.body.summary.ratingAdjustment).toBe(5);
    });
});

describe("WK-105 second-pass code review fixes", () => {
    it("finding: correcting via ratingAfter with an unknown ratingBefore no longer fabricates a nonzero correction", async () => {
        // A ranked match whose session.rating was null at finalize time -
        // rating_delta=25/detected=25 get set (finalizeMatch doesn't need an
        // anchor to compute the default step), but rating_before/after stay
        // null (no anchor). Correcting it via ratingAfter (not ratingDelta)
        // used to compute ratingDeltaCorrection = (null ?? 0) - 25 = -25
        // next to a null rating_delta, violating detected+correction=effective
        // and silently dropping the match from getSessionMatchRatingDelta's
        // sum while still moving session.rating.
        const { streamUserId } = await createTestUser();
        await getOrCreateActiveSession(streamUserId); // session.rating stays null - never set
        await playRankedMatch(streamUserId, 10, "700000801", "win");

        const rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({
            rating_before: null,
            rating_delta: 25,
            rating_after: null,
            detected_rating_delta: 25,
        });

        await correctStreamMatch(streamUserId, rows[0].id.toString(), { ratingAfter: 4025 });
        const corrected = (await getMatchRows(streamUserId))[0];
        expect(corrected.rating_delta).toBeNull(); // still no anchor, still honestly unknown
        expect(corrected.rating_after).toBe(4025);
        // Honest null/0, not a fabricated -25 "correction" sitting next to a
        // null effective delta.
        expect(corrected.detected_rating_delta).toBeNull();
        expect(corrected.rating_delta_correction).toBe(0);
    });

    it("finding: the ended-session guard only blocks rating-affecting commands, not plain result/W-L fixes", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 6000);
        await playRankedMatch(streamUserId, 10, "700000802", "win"); // ranked
        await setGameMode(streamUserId, "unranked");
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(11, "700000803"));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(11, "loss", { matchId: "700000803" })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(11, "loss", { matchId: "700000803" })
        );

        const rows = await getMatchRows(streamUserId);
        const rankedMatch = rows[0];
        const unrankedMatch = rows[1];

        await request(app)
            .post("/api/stream/account/session/end")
            .set("Authorization", `Bearer ${jwtToken}`);

        // Ranked match, session ended, result-only fix (no rating fields at
        // all) - still rejected, because the default-rebuild branch WOULD
        // move rating_delta for a ranked match's result change.
        await expect(
            correctStreamMatch(streamUserId, rankedMatch.id.toString(), { result: "loss" })
        ).rejects.toThrow("already ended");

        // Unranked match in the SAME ended session - a pure result fix never
        // touches rating and must remain correctable, matching pre-WK-105
        // behavior for exactly this kind of edit.
        const result = await correctStreamMatch(streamUserId, unrankedMatch.id.toString(), {
            result: "win",
        });
        expect(result.match.result).toBe("win");
        expect(result.match.ratingDelta).toBeNull();
        // Before: 1 win (the ranked match) + 1 loss (this unranked match).
        // After flipping this match's result loss -> win: 2 wins, 0 losses.
        expect(result.session?.wins).toBe(2);
        expect(result.session?.losses).toBe(0);
    });

    it("finding: PATCH /account/session rejects rating combined with wins/losses/lastHeroId at the schema level", async () => {
        const { streamUserId, jwtToken } = await createTestUser();
        await getOrCreateActiveSession(streamUserId);

        const res = await request(app)
            .patch("/api/stream/account/session")
            .set("Authorization", `Bearer ${jwtToken}`)
            .send({ rating: 6000, wins: 5 });

        expect(res.status).toBe(400);

        // Confirmed rejected outright, not silently applied-partially.
        const row = await getActiveSessionRow(streamUserId);
        expect(row.rating).toBeNull();
        expect(row.wins).toBe(0);
    });
});
