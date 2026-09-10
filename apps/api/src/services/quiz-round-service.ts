import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { getOrCreateActiveSession } from "./stream-session-service.js";

// WK-116 - Between Matches quiz, backend-authoritative round/answer/score
// domain. Round lifecycle is driven entirely by BroadcastState transitions
// Companion reports (enterBetweenMatches/leaveBetweenMatches below), not by
// a free-running timer or a manual toggle - see the correction: the quiz is
// active exactly while BroadcastState = Between Matches.
//
// Deliberately NOT a background scheduler/cron. There is no process that
// "ticks" a round forward on its own - phase transitions (question->reveal,
// reveal->next question) are resolved LAZILY, inside `resolveActiveRound`,
// whenever something actually reads the round (the Companion/web poll, or
// an answer submission). This is what "no hidden timer progression outside
// Between Matches" means concretely: nothing ever advances a round that
// nobody is polling, and once leaveBetweenMatches cancels the active round,
// there is nothing left with state='active' for a stray poll to advance -
// the guarantee is structural, not "we remembered to gate it".
//
// Explicit "fresh round" semantics: entering Between Matches NEVER resumes a
// suspended round. It either finds no active round (normal case - leaving
// already cancelled the last one) or, defensively, cancels whatever's still
// marked active before starting a brand new one with a full 30s window.
//
// Scoring is deferred to the question->reveal transition, not applied at
// submission time. During QUESTION, submitAnswer only persists the viewer's
// selection (and, internally, whether it's correct - never returned to the
// caller before reveal). quiz_viewer_scores is mutated exactly once, inside
// resolveActiveRound's question->reveal branch, which is itself guarded by
// `WHERE phase = 'question'` - a second/concurrent resolve of the same round
// finds phase already 'reveal' and matches zero rows, so scoring is
// idempotent by construction, not by a separate "already scored" flag. A
// round that gets cancelled (leaveBetweenMatches) never reaches that branch
// at all, so a cancelled round's answers are preserved but never scored.

export const QUESTION_DURATION_MS = 30_000;
export const REVEAL_DURATION_MS = 10_000;
const LEADERBOARD_LIMIT = 5;

export type QuizPhase = "question" | "reveal";
export type QuizRoundLifecycleState = "active" | "completed" | "cancelled";

export interface QuizOption {
    id: string;
    label: string;
    assetUrl: string | null;
}

export interface InteractiveRegion {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    // The option id this region activates - generic `value`, not `optionId`,
    // so a future interaction type (e.g. a region that isn't 1:1 with a
    // single answer option) isn't structurally precluded.
    value: string;
}

export interface QuizRoundState {
    roundId: string;
    phase: QuizPhase;
    phaseEndsAt: string;
    category: string;
    interactionType: "single_choice_text";
    prompt: string;
    options: QuizOption[];
    // Only present during "reveal" - never sent to any client before then.
    correctOptionId: string | null;
    distribution: Record<string, number> | null;
    interactiveRegions: InteractiveRegion[] | null;
    leaderboard: QuizLeaderboardEntry[];
}

export interface QuizLeaderboardEntry {
    rank: number;
    twitchViewerId: string;
    displayName: string;
    score: number;
    streak: number;
}

interface ActiveRoundRow {
    id: number;
    stream_user_id: number;
    stream_session_id: number;
    question_id: number;
    phase: QuizPhase;
    state: QuizRoundLifecycleState;
    question_started_at: Date;
    reveal_started_at: Date | null;
    interactive_regions: InteractiveRegion[] | null;
}

interface QuestionRow {
    id: number;
    category: string;
    interaction_type: "single_choice_text";
    prompt: string;
}

interface OptionRow {
    id: number;
    label: string;
    asset_url: string | null;
    is_correct: boolean;
}

const ROUND_COLUMNS =
    "id, stream_user_id, stream_session_id, question_id, phase, state, question_started_at, reveal_started_at, interactive_regions";

const getActiveRoundForUpdate = async (
    client: PoolClient,
    streamUserId: string
): Promise<ActiveRoundRow | null> => {
    const result = await client.query<ActiveRoundRow>(
        `SELECT ${ROUND_COLUMNS} FROM quiz_rounds WHERE stream_user_id = $1 AND state = 'active' FOR UPDATE`,
        [streamUserId]
    );
    return result.rows[0] ?? null;
};

const pickNextQuestionId = async (
    client: PoolClient,
    excludeQuestionId: number | null
): Promise<number | null> => {
    const result = await client.query<{ id: number }>(
        `SELECT id FROM quiz_questions
         WHERE is_active = true AND ($1::int IS NULL OR id != $1)
         ORDER BY RANDOM() LIMIT 1`,
        [excludeQuestionId]
    );
    if (result.rows[0]) return result.rows[0].id;
    // Only one active question exists (or the bank is otherwise exhausted
    // once the exclusion is applied) - fall back to allowing a repeat
    // rather than returning no question at all.
    const fallback = await client.query<{ id: number }>(
        `SELECT id FROM quiz_questions WHERE is_active = true ORDER BY RANDOM() LIMIT 1`
    );
    return fallback.rows[0]?.id ?? null;
};

const startFreshRound = async (
    client: PoolClient,
    streamUserId: string,
    streamSessionId: number,
    excludeQuestionId: number | null
): Promise<ActiveRoundRow | null> => {
    const questionId = await pickNextQuestionId(client, excludeQuestionId);
    if (questionId === null) {
        logger.warn("Quiz round not started - question bank is empty", { streamUserId });
        return null;
    }
    const inserted = await client.query<ActiveRoundRow>(
        `INSERT INTO quiz_rounds (stream_user_id, stream_session_id, question_id, phase, state, question_started_at)
         VALUES ($1, $2, $3, 'question', 'active', CURRENT_TIMESTAMP)
         RETURNING ${ROUND_COLUMNS}`,
        [streamUserId, streamSessionId, questionId]
    );
    return inserted.rows[0];
};

// Entering Between Matches. Cancels any still-active round defensively
// (shouldn't normally exist - leaveBetweenMatches already cancels - but a
// duplicate/out-of-order event must not resume it) and always starts a
// brand new round with a full QUESTION_DURATION_MS window.
//
// Requires a real, currently-active stream_sessions row (see
// getOrCreateActiveSession) - the round and the leaderboard it scores into
// are both tied to that row, reusing its existing survive/reset lifecycle
// (see quiz_viewer_scores' migration comment) instead of a parallel "quiz
// session" concept. If there's no active session (stream not started in
// this app, or already ended - WK-53's "not auto-resurrected" case), the
// quiz simply doesn't run: same defensive-no-op stance as an empty question
// bank, logged rather than silently swallowed.
export const enterBetweenMatches = async (streamUserId: string): Promise<void> => {
    const session = await getOrCreateActiveSession(streamUserId);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const existing = await getActiveRoundForUpdate(client, streamUserId);
        if (existing) {
            await client.query(
                `UPDATE quiz_rounds SET state = 'cancelled', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [existing.id]
            );
        }
        if (!session) {
            logger.warn("Quiz round not started - no active stream session", { streamUserId });
        } else {
            await startFreshRound(client, streamUserId, Number(session.id), existing?.question_id ?? null);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Leaving Between Matches. Terminates the round itself (not just its
// rendering/hitboxes) - this is what stops a viewer from returning to a
// question that silently ran to completion during a match, since re-
// entering always starts fresh (see enterBetweenMatches) rather than
// resuming anything. Any answers already recorded for this round stay in
// quiz_answers for diagnostics/history, but since this round never reaches
// resolveActiveRound's question->reveal branch again, it is never scored.
export const leaveBetweenMatches = async (streamUserId: string): Promise<void> => {
    await pool.query(
        `UPDATE quiz_rounds SET state = 'cancelled', ended_at = CURRENT_TIMESTAMP
         WHERE stream_user_id = $1 AND state = 'active'`,
        [streamUserId]
    );
};

// Applies +100/streak+1 (correct) or +0/streak=0 (wrong) to every viewer who
// answered this round, exactly once - called only from the question->reveal
// transition below, never from submitAnswer. A viewer with no quiz_answers
// row for this round is untouched (v1 decision: streak means consecutive
// CORRECT answers among rounds the viewer actually answered - silent non-
// participation neither breaks nor advances it, and deliberately does not
// require a per-round viewer roster to enforce).
const applyScoringForRound = async (
    client: PoolClient,
    roundId: number,
    streamSessionId: number
): Promise<void> => {
    const answers = await client.query<{
        twitch_viewer_id: string;
        twitch_display_name: string;
        is_correct: boolean;
    }>(
        `SELECT twitch_viewer_id, twitch_display_name, is_correct FROM quiz_answers WHERE round_id = $1`,
        [roundId]
    );
    for (const answer of answers.rows) {
        const points = answer.is_correct ? 100 : 0;
        const streakDelta = answer.is_correct ? 1 : 0;
        await client.query(
            `INSERT INTO quiz_viewer_scores (stream_session_id, twitch_viewer_id, twitch_display_name, score, streak, updated_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (stream_session_id, twitch_viewer_id) DO UPDATE SET
               twitch_display_name = EXCLUDED.twitch_display_name,
               score = quiz_viewer_scores.score + EXCLUDED.score,
               streak = CASE WHEN $5 = 0 THEN 0 ELSE quiz_viewer_scores.streak + 1 END,
               updated_at = CURRENT_TIMESTAMP`,
            [streamSessionId, answer.twitch_viewer_id, answer.twitch_display_name, points, streakDelta]
        );
    }
};

// The lazy scheduler. Advances phase/round transitions based on elapsed
// time against the currently active round, if any - called by every read
// path (poll, answer submission) so the returned round is always current as
// of "now", without any background process ticking it.
//
// Expiry is decided entirely in SQL (`... <= CURRENT_TIMESTAMP`), comparing
// each row against the DATABASE's own clock rather than fetching a
// timestamp and comparing it against the Node process's `Date.now()`. Two
// reasons: it's the same "compare against one authoritative clock, not two
// processes' potentially-skewed ones" property a real deployment wants
// anyway, and it's what makes this deterministically testable - a test can
// backdate `question_started_at`/`reveal_started_at` directly and this
// function reacts correctly without needing to also fake the Node clock
// (which would just be a second clock to keep in sync with Postgres's).
const resolveActiveRound = async (
    client: PoolClient,
    streamUserId: string
): Promise<ActiveRoundRow | null> => {
    let round = await getActiveRoundForUpdate(client, streamUserId);
    if (!round) return null;

    if (round.phase === "question") {
        const updated = await client.query<ActiveRoundRow>(
            `UPDATE quiz_rounds SET phase = 'reveal', reveal_started_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND phase = 'question'
               AND question_started_at + ($2 * INTERVAL '1 millisecond') <= CURRENT_TIMESTAMP
             RETURNING ${ROUND_COLUMNS}`,
            [round.id, QUESTION_DURATION_MS]
        );
        if (updated.rows[0]) {
            round = updated.rows[0];
            // Exactly-once by construction: the UPDATE above is guarded by
            // `phase = 'question'`, so only the caller that actually flips
            // it (this branch) ever reaches this line for a given round: a
            // second/concurrent resolve of the same round sees phase already
            // 'reveal' and the UPDATE above matches zero rows.
            await applyScoringForRound(client, round.id, round.stream_session_id);
        }
    }

    if (round.phase === "reveal" && round.reveal_started_at) {
        const completed = await client.query<{ id: number }>(
            `UPDATE quiz_rounds SET state = 'completed', ended_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND phase = 'reveal' AND state = 'active'
               AND reveal_started_at + ($2 * INTERVAL '1 millisecond') <= CURRENT_TIMESTAMP
             RETURNING id`,
            [round.id, REVEAL_DURATION_MS]
        );
        if (completed.rows[0]) {
            // Still active as of the last signal we have (leaveBetweenMatches
            // would have already cancelled this row otherwise) - continue the
            // cycle with a fresh question, same stream session.
            round = await startFreshRound(client, streamUserId, round.stream_session_id, round.question_id);
        }
    }

    return round;
};

const loadQuestionAndOptions = async (
    client: PoolClient,
    questionId: number
): Promise<{ question: QuestionRow; options: OptionRow[] }> => {
    const question = await client.query<QuestionRow>(
        `SELECT id, category, interaction_type, prompt FROM quiz_questions WHERE id = $1`,
        [questionId]
    );
    const options = await client.query<OptionRow>(
        `SELECT id, label, asset_url, is_correct FROM quiz_question_options
         WHERE question_id = $1 ORDER BY position ASC`,
        [questionId]
    );
    return { question: question.rows[0], options: options.rows };
};

// Takes an explicit executor (a `PoolClient` mid-transaction, or `pool`
// itself for a standalone read) rather than always going through `pool` -
// the query MUST run on the SAME connection/transaction as any scoring that
// just happened, or a fresh `pool.query` opens a different connection that
// (under READ COMMITTED) cannot see the still-uncommitted score row yet.
// This is exactly the bug this comment is here to prevent regressing: the
// first version of getQuizState called the pool-based getLeaderboard below
// from inside its own still-open transaction and always got a stale/empty
// leaderboard back.
type Queryable = Pick<PoolClient, "query">;

const fetchLeaderboard = async (
    executor: Queryable,
    streamSessionId: string | number,
    limit: number
): Promise<QuizLeaderboardEntry[]> => {
    const result = await executor.query<{
        twitch_viewer_id: string;
        twitch_display_name: string;
        score: number;
        streak: number;
    }>(
        `SELECT twitch_viewer_id, twitch_display_name, score, streak FROM quiz_viewer_scores
         WHERE stream_session_id = $1 ORDER BY score DESC, updated_at ASC LIMIT $2`,
        [streamSessionId, limit]
    );
    return result.rows.map((row, index) => ({
        rank: index + 1,
        twitchViewerId: row.twitch_viewer_id,
        displayName: row.twitch_display_name,
        score: row.score,
        streak: row.streak,
    }));
};

// Scoped to a stream_session_id (the CURRENT stream), not a streamUserId -
// see quiz_viewer_scores' migration comment. Callers that only have an
// active round (getQuizState) already know its stream_session_id; there is
// deliberately no streamUserId-based overload for v1 since the leaderboard
// is never surfaced outside an active round's own state. Standalone/test
// use only - getQuizState uses fetchLeaderboard directly with its own
// transaction's client, not this.
export const getLeaderboard = (
    streamSessionId: string | number,
    limit: number = LEADERBOARD_LIMIT
): Promise<QuizLeaderboardEntry[]> => fetchLeaderboard(pool, streamSessionId, limit);

const buildDistribution = async (
    client: PoolClient,
    roundId: number
): Promise<Record<string, number>> => {
    const result = await client.query<{ option_id: string; count: string }>(
        `SELECT jsonb_array_elements_text(selected_option_ids) AS option_id, COUNT(*)::text AS count
         FROM quiz_answers WHERE round_id = $1 GROUP BY option_id`,
        [roundId]
    );
    const total = result.rows.reduce((sum, row) => sum + Number(row.count), 0);
    const distribution: Record<string, number> = {};
    for (const row of result.rows) {
        distribution[row.option_id] = total > 0 ? Math.round((Number(row.count) / total) * 100) : 0;
    }
    return distribution;
};

// Public/poll-facing state - never includes the correct option or the
// answer distribution outside "reveal" (see the correction: don't send the
// correct answer to the Extension client before reveal if avoidable, and
// the same restraint applies to Companion/web's own poll response, even
// though only the visible board renders it). The returned leaderboard
// reflects whatever scoring has actually been applied so far - unchanged
// during QUESTION, updated the instant resolveActiveRound's question->reveal
// transition (and its one-time scoring pass) has run.
export const getQuizState = async (streamUserId: string): Promise<QuizRoundState | null> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const round = await resolveActiveRound(client, streamUserId);
        if (!round) {
            await client.query("COMMIT");
            return null;
        }
        const { question, options } = await loadQuestionAndOptions(client, round.question_id);
        const isReveal = round.phase === "reveal";
        const distribution = isReveal ? await buildDistribution(client, round.id) : null;
        // Same transaction/client as the scoring pass that may have just run
        // inside resolveActiveRound - see fetchLeaderboard's doc comment.
        const leaderboard = await fetchLeaderboard(client, round.stream_session_id, LEADERBOARD_LIMIT);
        await client.query("COMMIT");

        const phaseEndsAt = round.phase === "question"
            ? round.question_started_at.getTime() + QUESTION_DURATION_MS
            : (round.reveal_started_at as Date).getTime() + REVEAL_DURATION_MS;

        return {
            roundId: round.id.toString(),
            phase: round.phase,
            phaseEndsAt: new Date(phaseEndsAt).toISOString(),
            category: question.category,
            interactionType: question.interaction_type,
            prompt: question.prompt,
            options: options.map((option) => ({
                id: option.id.toString(),
                label: option.label,
                assetUrl: option.asset_url,
            })),
            correctOptionId: isReveal ? (options.find((o) => o.is_correct)?.id.toString() ?? null) : null,
            distribution,
            interactiveRegions: round.interactive_regions,
            leaderboard,
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export type SubmitAnswerOutcome =
    | { accepted: true }
    | { accepted: false; reason: "no_active_question" | "already_answered" | "unsupported_selection" };

// v1 only ever accepts exactly one selected option id - `selectedOptionIds`
// is still an array (not a single scalar) so a future multi-select
// interaction type reuses this signature/column instead of needing a new
// one. ONLY persists the selection (and, internally, its correctness, for
// the later scoring pass to read) - never mutates quiz_viewer_scores and
// never returns whether the answer was correct, so there is no channel for
// correctness to leak before reveal. See applyScoringForRound for where
// scoring actually happens.
export const submitAnswer = async (
    streamUserId: string,
    twitchViewerId: string,
    twitchDisplayName: string,
    selectedOptionIds: string[]
): Promise<SubmitAnswerOutcome> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const round = await resolveActiveRound(client, streamUserId);
        if (!round || round.phase !== "question") {
            await client.query("COMMIT");
            return { accepted: false, reason: "no_active_question" };
        }
        if (selectedOptionIds.length !== 1) {
            await client.query("COMMIT");
            return { accepted: false, reason: "unsupported_selection" };
        }

        const { options } = await loadQuestionAndOptions(client, round.question_id);
        const selected = options.find((option) => option.id.toString() === selectedOptionIds[0]);
        if (!selected) {
            await client.query("COMMIT");
            return { accepted: false, reason: "unsupported_selection" };
        }

        const inserted = await client.query(
            `INSERT INTO quiz_answers (round_id, twitch_viewer_id, twitch_display_name, selected_option_ids, is_correct)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (round_id, twitch_viewer_id) DO NOTHING
             RETURNING id`,
            [round.id, twitchViewerId, twitchDisplayName, JSON.stringify(selectedOptionIds), selected.is_correct]
        );
        if (inserted.rows.length === 0) {
            await client.query("COMMIT");
            return { accepted: false, reason: "already_answered" };
        }

        await client.query("COMMIT");
        return { accepted: true };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Companion measures its own rendered answer-button geometry (real DOM
// rects normalized against the video canvas) and publishes it here - the
// Extension consumes published numbers rather than re-deriving Companion's
// layout (see the Phase 0 placement review). Scoped to the CURRENT active
// round only: a geometry report naming a round that already ended (reveal
// finished, or the round was cancelled) is stale and silently ignored
// rather than corrupting a since-started new round's data.
export const publishInteractiveRegions = async (
    streamUserId: string,
    roundId: string,
    regions: InteractiveRegion[]
): Promise<boolean> => {
    const result = await pool.query(
        `UPDATE quiz_rounds SET interactive_regions = $1::jsonb
         WHERE id = $2 AND stream_user_id = $3 AND state = 'active'`,
        [JSON.stringify(regions), roundId, streamUserId]
    );
    return (result.rowCount ?? 0) > 0;
};
