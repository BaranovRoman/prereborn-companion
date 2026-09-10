import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { seedQuizQuestions } from "../db/seed-quiz-questions.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";
import { resetActiveSession } from "../services/stream-session-service.js";
import {
    enterBetweenMatches,
    leaveBetweenMatches,
    getQuizState,
    submitAnswer,
    getLeaderboard,
    publishInteractiveRegions,
    QUESTION_DURATION_MS,
    REVEAL_DURATION_MS,
} from "../services/quiz-round-service.js";

// WK-116 - round lifecycle is driven entirely by BroadcastState transitions
// (fresh round on every Between Matches entry, never a resumed one) and
// every phase transition is resolved lazily, comparing each row against
// Postgres's own clock (CURRENT_TIMESTAMP), not the Node process's - see
// quiz-round-service.ts's resolveActiveRound doc comment. These tests
// simulate elapsed time by backdating question_started_at/reveal_started_at
// directly via SQL rather than mocking the JS clock - mocking Date.now()
// would drift from Postgres's real clock the moment a test inserts a NEW
// row (fresh CURRENT_TIMESTAMP) after having already advanced the fake
// clock, which would make the round appear falsely expired the instant it's
// created.
//
// Scoring correction (2026-09-10): score/streak are applied exactly once, at
// the question->reveal transition - never at submission time. See the
// "deferred scoring" describe block below.

const suffix = `${Date.now()}-quiz`;
let userCounter = 0;
const createdUserIds: string[] = [];

const createTestUser = async (): Promise<{ streamUserId: string; companionToken: string }> => {
    userCounter += 1;
    const email = `stream_quiz_${suffix}_${userCounter}@example.com`;
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

// Pushes the given round's phase-start timestamp back in time, so the next
// resolveActiveRound call (inside getQuizState/submitAnswer) sees that
// phase's window as already elapsed - deterministic, no wall-clock waiting.
const backdateRound = async (
    roundId: string,
    field: "question_started_at" | "reveal_started_at",
    ms: number
): Promise<void> => {
    await pool.query(
        `UPDATE quiz_rounds SET ${field} = ${field} - ($2 * INTERVAL '1 millisecond') WHERE id = $1`,
        [roundId, ms]
    );
};

const correctOptionIdFor = async (roundId: string): Promise<string> => {
    const row = await pool.query<{ id: number }>(
        `SELECT o.id FROM quiz_question_options o
         JOIN quiz_rounds r ON r.question_id = o.question_id
         WHERE r.id = $1 AND o.is_correct = true`,
        [roundId]
    );
    return row.rows[0].id.toString();
};

// Advances a round all the way through reveal into the NEXT fresh question,
// via two separate backdate+resolve steps (matches resolveActiveRound's
// real one-transition-per-call behavior - see its doc comment).
const advanceToNextQuestion = async (roundId: string): Promise<void> => {
    await backdateRound(roundId, "question_started_at", QUESTION_DURATION_MS + 500);
    const revealState = await getQuizState(await streamUserIdForRound(roundId));
    await backdateRound(revealState!.roundId, "reveal_started_at", REVEAL_DURATION_MS + 500);
};

const streamUserIdForRound = async (roundId: string): Promise<string> => {
    const row = await pool.query<{ stream_user_id: number }>("SELECT stream_user_id FROM quiz_rounds WHERE id = $1", [roundId]);
    return row.rows[0].stream_user_id.toString();
};

const currentSessionIdFor = async (streamUserId: string): Promise<string> => {
    const row = await pool.query<{ id: number }>(
        "SELECT id FROM stream_sessions WHERE stream_user_id = $1 AND ended_at IS NULL",
        [streamUserId]
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

describe("enterBetweenMatches / leaveBetweenMatches - fresh round semantics", () => {
    it("entering starts a fresh QUESTION round with the full 30s window", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);

        const state = await getQuizState(streamUserId);
        expect(state).not.toBeNull();
        expect(state!.phase).toBe("question");
        const remainingMs = new Date(state!.phaseEndsAt).getTime() - Date.now();
        expect(remainingMs).toBeGreaterThan(QUESTION_DURATION_MS - 2000);
        expect(remainingMs).toBeLessThanOrEqual(QUESTION_DURATION_MS);
    });

    it("leaving cancels the active round - no active round remains", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        await leaveBetweenMatches(streamUserId);

        expect(await getQuizState(streamUserId)).toBeNull();
        const row = await pool.query("SELECT state FROM quiz_rounds WHERE stream_user_id = $1", [streamUserId]);
        expect(row.rows[0].state).toBe("cancelled");
    });

    it("does NOT resume an old round after leaving and re-entering - a fresh round starts with a full window, even mid-question", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const firstState = await getQuizState(streamUserId);

        // Only 5s into a 30s question when the match starts (leaving doesn't
        // care how much time was left - it cancels unconditionally).
        await backdateRound(firstState!.roundId, "question_started_at", 5000);
        await leaveBetweenMatches(streamUserId);

        await enterBetweenMatches(streamUserId);
        const secondState = await getQuizState(streamUserId);

        expect(secondState).not.toBeNull();
        expect(secondState!.roundId).not.toBe(firstState!.roundId);
        expect(secondState!.phase).toBe("question");
        const remainingMs = new Date(secondState!.phaseEndsAt).getTime() - Date.now();
        // Fresh 30s window, not "25s left over from before".
        expect(remainingMs).toBeGreaterThan(QUESTION_DURATION_MS - 2000);
    });

    it("re-entering while a round is still marked active (defensive/duplicate event) cancels it and starts fresh, never resumes it", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const first = await getQuizState(streamUserId);

        await enterBetweenMatches(streamUserId);
        const second = await getQuizState(streamUserId);

        expect(second!.roundId).not.toBe(first!.roundId);
        const cancelled = await pool.query("SELECT state FROM quiz_rounds WHERE id = $1", [first!.roundId]);
        expect(cancelled.rows[0].state).toBe("cancelled");
    });
});

describe("lazy phase progression", () => {
    it("QUESTION advances to REVEAL once the 30s window elapses, on the next read", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const first = await getQuizState(streamUserId);
        expect(first!.phase).toBe("question");

        await backdateRound(first!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        const state = await getQuizState(streamUserId);
        expect(state!.phase).toBe("reveal");
        expect(state!.correctOptionId).not.toBeNull();
        expect(state!.distribution).not.toBeNull();
    });

    it("REVEAL automatically starts the next fresh QUESTION once its 10s window elapses, while still active", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const first = await getQuizState(streamUserId);

        await advanceToNextQuestion(first!.roundId);
        const nextState = await getQuizState(streamUserId);
        expect(nextState!.phase).toBe("question");
        expect(nextState!.roundId).not.toBe(first!.roundId);

        const previousRound = await pool.query("SELECT state FROM quiz_rounds WHERE id = $1", [first!.roundId]);
        expect(previousRound.rows[0].state).toBe("completed");
    });

    it("a cancelled round never resumes/advances, no matter how stale its timestamps are", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        await backdateRound(state!.roundId, "question_started_at", QUESTION_DURATION_MS * 10);
        await leaveBetweenMatches(streamUserId);

        expect(await getQuizState(streamUserId)).toBeNull();
    });
});

describe("deferred scoring - score/streak apply exactly once, at question->reveal", () => {
    it("answer submission alone does not change score", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);

        const outcome = await submitAnswer(streamUserId, "viewer-1", "viewer_one", [correctOptionId]);
        expect(outcome).toEqual({ accepted: true });

        const sessionId = await currentSessionIdFor(streamUserId);
        const leaderboard = await getLeaderboard(sessionId);
        expect(leaderboard.find((e) => e.twitchViewerId === "viewer-1")).toBeUndefined();
    });

    it("leaderboard does not change before reveal, even with multiple answers recorded", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);
        const wrongOptionId = state!.options.find((o) => o.id !== correctOptionId)!.id;

        await submitAnswer(streamUserId, "viewer-a", "a", [correctOptionId]);
        await submitAnswer(streamUserId, "viewer-b", "b", [wrongOptionId]);

        const sessionId = await currentSessionIdFor(streamUserId);
        expect(await getLeaderboard(sessionId)).toHaveLength(0);
        // getQuizState's own embedded leaderboard must agree - this is what
        // a real poll during QUESTION would actually see.
        expect((await getQuizState(streamUserId))!.leaderboard).toHaveLength(0);
    });

    it("QUESTION -> REVEAL applies score exactly once", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);
        await submitAnswer(streamUserId, "viewer-c", "c", [correctOptionId]);

        await backdateRound(state!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        const revealed = await getQuizState(streamUserId);
        expect(revealed!.phase).toBe("reveal");

        const sessionId = await currentSessionIdFor(streamUserId);
        const leaderboard = await getLeaderboard(sessionId);
        expect(leaderboard.find((e) => e.twitchViewerId === "viewer-c")).toMatchObject({ score: 100, streak: 1 });
    });

    it("repeated resolution (repeated getQuizState reads) does not double-score", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);
        await submitAnswer(streamUserId, "viewer-d", "d", [correctOptionId]);
        await backdateRound(state!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);

        await getQuizState(streamUserId);
        await getQuizState(streamUserId);
        await getQuizState(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        const leaderboard = await getLeaderboard(sessionId);
        expect(leaderboard.find((e) => e.twitchViewerId === "viewer-d")).toMatchObject({ score: 100, streak: 1 });
    });

    it("a cancelled round that had an answer awards zero - Between Matches left mid-question", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);
        await submitAnswer(streamUserId, "viewer-e", "e", [correctOptionId]);

        await leaveBetweenMatches(streamUserId);

        // The answer row itself is preserved (diagnostics/history)...
        const answer = await pool.query("SELECT is_correct FROM quiz_answers WHERE round_id = $1 AND twitch_viewer_id = $2", [
            state!.roundId,
            "viewer-e",
        ]);
        expect(answer.rows).toHaveLength(1);
        expect(answer.rows[0].is_correct).toBe(true);

        // ...but no score/streak was ever applied for it.
        const sessionId = await currentSessionIdFor(streamUserId);
        const leaderboard = await getLeaderboard(sessionId);
        expect(leaderboard.find((e) => e.twitchViewerId === "viewer-e")).toBeUndefined();
    });

    it("reveal exposes the updated leaderboard only after the scoring resolution that produced it", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);
        await submitAnswer(streamUserId, "viewer-f", "f", [correctOptionId]);

        // Still QUESTION - leaderboard field must not show viewer-f yet.
        expect((await getQuizState(streamUserId))!.leaderboard.find((e) => e.twitchViewerId === "viewer-f")).toBeUndefined();

        await backdateRound(state!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        const revealed = await getQuizState(streamUserId);
        expect(revealed!.phase).toBe("reveal");
        expect(revealed!.leaderboard.find((e) => e.twitchViewerId === "viewer-f")).toMatchObject({ score: 100 });
    });
});

describe("streak semantics (v1) - no answer does NOT reset streak", () => {
    it("a wrong answer resets streak to 0 (and scores +0)", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const correctOptionId = await correctOptionIdFor(state!.roundId);
        const wrongOptionId = state!.options.find((o) => o.id !== correctOptionId)!.id;
        await submitAnswer(streamUserId, "viewer-g", "g", [wrongOptionId]);
        await backdateRound(state!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        await getQuizState(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        const entry = (await getLeaderboard(sessionId)).find((e) => e.twitchViewerId === "viewer-g");
        expect(entry).toMatchObject({ score: 0, streak: 0 });
    });

    it("streak accumulates across correct answers in consecutive rounds", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const round1 = await getQuizState(streamUserId);
        await submitAnswer(streamUserId, "viewer-h", "h", [await correctOptionIdFor(round1!.roundId)]);

        await advanceToNextQuestion(round1!.roundId);
        const round2 = await getQuizState(streamUserId);
        await submitAnswer(streamUserId, "viewer-h", "h", [await correctOptionIdFor(round2!.roundId)]);
        await advanceToNextQuestion(round2!.roundId);
        await getQuizState(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        expect((await getLeaderboard(sessionId)).find((e) => e.twitchViewerId === "viewer-h")).toMatchObject({
            score: 200,
            streak: 2,
        });
    });

    it("skipping a round (no answer) does not reset an existing streak - it stays unchanged, not broken", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const round1 = await getQuizState(streamUserId);
        await submitAnswer(streamUserId, "viewer-i", "i", [await correctOptionIdFor(round1!.roundId)]);
        await advanceToNextQuestion(round1!.roundId);
        await getQuizState(streamUserId); // resolves round1 -> reveal -> round2, scoring viewer-i's streak to 1

        // round2: viewer-i does NOT answer at all.
        const round2 = await getQuizState(streamUserId);
        await advanceToNextQuestion(round2!.roundId);
        await getQuizState(streamUserId); // resolves round2 -> reveal -> round3 (nobody answered round2)

        // round3: viewer-i answers correctly again.
        const round3 = await getQuizState(streamUserId);
        await submitAnswer(streamUserId, "viewer-i", "i", [await correctOptionIdFor(round3!.roundId)]);
        await advanceToNextQuestion(round3!.roundId);
        await getQuizState(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        // Unbroken streak of 2 (round1, round3) despite skipping round2 -
        // NOT reset to 0 or 1 by the silent round.
        expect((await getLeaderboard(sessionId)).find((e) => e.twitchViewerId === "viewer-i")).toMatchObject({
            score: 200,
            streak: 2,
        });
    });
});

describe("leaderboard scope - current stream session, not lifetime", () => {
    it("persists across Between Matches -> Gameplay -> Between Matches within the same stream (leave + re-enter, same session)", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const round1 = await getQuizState(streamUserId);
        await submitAnswer(streamUserId, "viewer-j", "j", [await correctOptionIdFor(round1!.roundId)]);
        await backdateRound(round1!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        await getQuizState(streamUserId); // scores viewer-j

        // "Match starts" - Between Matches ends, quiz round is cancelled.
        await leaveBetweenMatches(streamUserId);

        // "Match ends" - Between Matches resumes. Same stream, same session.
        await enterBetweenMatches(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        expect((await getLeaderboard(sessionId)).find((e) => e.twitchViewerId === "viewer-j")).toMatchObject({ score: 100 });
        // The new round's own embedded leaderboard shows the same history.
        expect((await getQuizState(streamUserId))!.leaderboard.find((e) => e.twitchViewerId === "viewer-j")).toMatchObject({
            score: 100,
        });
    });

    it("resets for a new stream/session", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const round1 = await getQuizState(streamUserId);
        await submitAnswer(streamUserId, "viewer-k", "k", [await correctOptionIdFor(round1!.roundId)]);
        await backdateRound(round1!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        await getQuizState(streamUserId); // scores viewer-k in session 1
        const firstSessionId = await currentSessionIdFor(streamUserId);
        expect((await getLeaderboard(firstSessionId)).find((e) => e.twitchViewerId === "viewer-k")).toMatchObject({ score: 100 });

        await leaveBetweenMatches(streamUserId);
        // "Начать новый стрим" - a genuinely new stream_sessions row.
        await resetActiveSession(streamUserId);

        await enterBetweenMatches(streamUserId);
        const secondSessionId = await currentSessionIdFor(streamUserId);
        expect(secondSessionId).not.toBe(firstSessionId);

        // Fresh leaderboard for the new session - viewer-k's old score does
        // not carry over (this is NOT an all-time leaderboard).
        expect((await getLeaderboard(secondSessionId)).find((e) => e.twitchViewerId === "viewer-k")).toBeUndefined();
        // The old session's own row is untouched, for history's sake.
        expect((await getLeaderboard(firstSessionId)).find((e) => e.twitchViewerId === "viewer-k")).toMatchObject({ score: 100 });
    });

    it("does not start a round at all when there is no active stream session", async () => {
        const { streamUserId } = await createTestUser();
        // Never started a session for this user - getOrCreateActiveSession
        // auto-creates on true first-ever use, so explicitly end it first to
        // exercise the "no active session" path.
        await pool.query(
            `INSERT INTO stream_sessions (stream_user_id) VALUES ($1)
             ON CONFLICT DO NOTHING`,
            [streamUserId]
        );
        await pool.query(`UPDATE stream_sessions SET ended_at = CURRENT_TIMESTAMP WHERE stream_user_id = $1`, [streamUserId]);

        await enterBetweenMatches(streamUserId);
        expect(await getQuizState(streamUserId)).toBeNull();
    });
});

describe("submitAnswer - acceptance rules", () => {
    it("rejects a second answer from the same viewer in the same round", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        const optionId = state!.options[0].id;

        await submitAnswer(streamUserId, "viewer-4", "viewer_four", [optionId]);
        const second = await submitAnswer(streamUserId, "viewer-4", "viewer_four", [state!.options[1].id]);
        expect(second).toEqual({ accepted: false, reason: "already_answered" });

        const count = await pool.query("SELECT COUNT(*) FROM quiz_answers WHERE round_id = $1 AND twitch_viewer_id = $2", [
            state!.roundId,
            "viewer-4",
        ]);
        expect(Number(count.rows[0].count)).toBe(1);
    });

    it("rejects a submission once the round has moved to reveal", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        await backdateRound(state!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);

        const outcome = await submitAnswer(streamUserId, "viewer-5", "viewer_five", [state!.options[0].id]);
        expect(outcome).toEqual({ accepted: false, reason: "no_active_question" });
    });

    it("rejects a multi-select submission in v1 (unsupported_selection) without erroring", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);

        const outcome = await submitAnswer(streamUserId, "viewer-6", "viewer_six", [
            state!.options[0].id,
            state!.options[1].id,
        ]);
        expect(outcome).toEqual({ accepted: false, reason: "unsupported_selection" });
    });
});

describe("leaderboard determinism", () => {
    it("ranks by score desc, then updated_at asc as the tie-break", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const round1 = await getQuizState(streamUserId);
        const correctId = await correctOptionIdFor(round1!.roundId);

        // Both viewers answer correctly in the same round (tied at 100) -
        // viewer-early submits first, so it must rank first once scored.
        await submitAnswer(streamUserId, "viewer-early", "early", [correctId]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await submitAnswer(streamUserId, "viewer-late", "late", [correctId]);

        await backdateRound(round1!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        await getQuizState(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        const leaderboard = await getLeaderboard(sessionId, 5);
        const early = leaderboard.findIndex((e) => e.twitchViewerId === "viewer-early");
        const late = leaderboard.findIndex((e) => e.twitchViewerId === "viewer-late");
        expect(early).toBeGreaterThanOrEqual(0);
        expect(late).toBeGreaterThan(early);
    });

    it("is capped at the requested limit (TOP 5 default)", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const round = await getQuizState(streamUserId);
        const correctId = await correctOptionIdFor(round!.roundId);
        for (let i = 0; i < 7; i += 1) {
            await submitAnswer(streamUserId, `viewer-cap-${i}`, `cap_${i}`, [correctId]);
        }
        await backdateRound(round!.roundId, "question_started_at", QUESTION_DURATION_MS + 500);
        await getQuizState(streamUserId);

        const sessionId = await currentSessionIdFor(streamUserId);
        expect(await getLeaderboard(sessionId)).toHaveLength(5);
    });
});

describe("publishInteractiveRegions", () => {
    const sampleRegions = [
        { id: "0", x: 0.1, y: 0.1, width: 0.1, height: 0.05, value: "a" },
        { id: "1", x: 0.3, y: 0.1, width: 0.1, height: 0.05, value: "b" },
    ];

    it("stores geometry for the current active round and returns it via getQuizState", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);

        const applied = await publishInteractiveRegions(streamUserId, state!.roundId, sampleRegions);
        expect(applied).toBe(true);

        const updated = await getQuizState(streamUserId);
        expect(updated!.interactiveRegions).toEqual(sampleRegions);
    });

    it("silently ignores geometry for a roundId that is no longer active", async () => {
        const { streamUserId } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);
        await leaveBetweenMatches(streamUserId);

        const applied = await publishInteractiveRegions(streamUserId, state!.roundId, sampleRegions);
        expect(applied).toBe(false);
    });
});

describe("POST /api/stream/companion/sync/events - between_matches_entered/left", () => {
    it("entering over HTTP starts a fresh round, idempotently on eventId retry", async () => {
        const { streamUserId, companionToken } = await createTestUser();
        const eventId = randomUUID();
        const send = () =>
            request(app)
                .post("/api/stream/companion/sync/events")
                .set("Authorization", `Bearer ${companionToken}`)
                .send({ eventId, eventType: "between_matches_entered", payload: {} });

        const first = await send();
        expect(first.status).toBe(200);
        const retried = await send();
        expect(retried.status).toBe(200);

        const count = await pool.query("SELECT COUNT(*) FROM quiz_rounds WHERE stream_user_id = $1", [streamUserId]);
        expect(Number(count.rows[0].count)).toBe(1);
    });

    it("leaving over HTTP cancels the active round", async () => {
        const { streamUserId, companionToken } = await createTestUser();
        await enterBetweenMatches(streamUserId);

        const res = await request(app)
            .post("/api/stream/companion/sync/events")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({ eventId: randomUUID(), eventType: "between_matches_left", payload: {} });
        expect(res.status).toBe(200);

        const row = await pool.query("SELECT state FROM quiz_rounds WHERE stream_user_id = $1", [streamUserId]);
        expect(row.rows[0].state).toBe("cancelled");
    });
});

describe("GET /api/stream/companion/quiz/state", () => {
    it("requires a companion token", async () => {
        expect((await request(app).get("/api/stream/companion/quiz/state")).status).toBe(401);
    });

    it("returns null when there is no active round", async () => {
        const { companionToken } = await createTestUser();
        const res = await request(app)
            .get("/api/stream/companion/quiz/state")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(res.status).toBe(200);
        expect(res.body.quiz).toBeNull();
    });

    it("returns the active round once entered", async () => {
        const { streamUserId, companionToken } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const res = await request(app)
            .get("/api/stream/companion/quiz/state")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(res.status).toBe(200);
        expect(res.body.quiz.phase).toBe("question");
        expect(res.body.quiz.correctOptionId).toBeNull();
    });
});

describe("PUT /api/stream/companion/quiz/geometry", () => {
    it("rejects a malformed region list", async () => {
        const { companionToken } = await createTestUser();
        const res = await request(app)
            .put("/api/stream/companion/quiz/geometry")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({ roundId: "1", interactiveRegions: [{ id: "0", x: 2, y: 0, width: 0.1, height: 0.1, value: "a" }] });
        expect(res.status).toBe(400);
    });

    it("accepts and stores a valid region list for the active round", async () => {
        const { streamUserId, companionToken } = await createTestUser();
        await enterBetweenMatches(streamUserId);
        const state = await getQuizState(streamUserId);

        const res = await request(app)
            .put("/api/stream/companion/quiz/geometry")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({
                roundId: state!.roundId,
                interactiveRegions: [{ id: "0", x: 0.1, y: 0.1, width: 0.1, height: 0.05, value: "a" }],
            });
        expect(res.status).toBe(200);
        expect(res.body.applied).toBe(true);
    });
});

describe("GET /api/stream/overlay/:publicToken - quiz field", () => {
    it("includes the active quiz round in the public overlay payload, reveal-gated", async () => {
        const { streamUserId } = await createTestUser();
        const publicToken = (
            await pool.query<{ public_token: string }>("SELECT public_token FROM stream_users WHERE id = $1", [streamUserId])
        ).rows[0].public_token;
        await enterBetweenMatches(streamUserId);

        const res = await request(app).get(`/api/stream/overlay/${publicToken}`);
        expect(res.status).toBe(200);
        expect(res.body.quiz.phase).toBe("question");
        expect(res.body.quiz.correctOptionId).toBeNull();
        expect(res.body.quiz.distribution).toBeNull();
    });
});
