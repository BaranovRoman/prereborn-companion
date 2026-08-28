import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import type { MatchResult } from "./stream-match-service.js";

// WK-113 - local-first cutover. Companion's local SQLite runtime (WK-111/112)
// is now authoritative for session/match/MMR state during a stream; this
// service is the ONLY place the backend accepts that state from - a set of
// semantic events (session_started/session_ended/match_finalized), never raw
// GSI ticks (see controllers/stream/companion.ts's putCompanionGsiStateController,
// which stopped calling processGsiPayloadForMatch as part of this same cutover).
//
// Every apply* function here is idempotent via `withIdempotency` below, keyed
// on a client-generated event_id (Companion's sync worker retries the exact
// same event_id on failure) PLUS a data-level check against the stable
// local_session_id/local_match_id correlation key (defense in depth - see
// each function's own comment for why both layers matter).

// Runs `fn` at most once per `eventId`, inside one transaction that also
// records the ledger row - a retried eventId (lost response, forced retry
// after a Companion restart mid-delivery) short-circuits to the FIRST run's
// recorded result without re-executing fn at all. This is what makes "apply
// this event twice" (double W/L, duplicate session, double-applied MMR
// delta) impossible at the database level, not just "unlikely" client-side.
const withIdempotency = async <T>(
    eventId: string,
    streamUserId: string,
    eventType: string,
    fn: (client: PoolClient) => Promise<T>
): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const existing = await client.query<{ result: T | null }>(
            `SELECT result FROM stream_sync_events WHERE event_id = $1 FOR UPDATE`,
            [eventId]
        );
        if (existing.rows.length > 0) {
            await client.query("COMMIT");
            logger.info("Sync event replay - returning previously recorded result", {
                eventId,
                eventType,
                streamUserId,
            });
            return existing.rows[0].result as T;
        }

        const result = await fn(client);

        await client.query(
            `INSERT INTO stream_sync_events (event_id, stream_user_id, event_type, result)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [eventId, streamUserId, eventType, JSON.stringify(result)]
        );
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export interface SessionStartedPayload {
    localSessionId: string;
    startedAt: string;
    ratingStart: number | null;
}

export interface SessionStartedResult {
    backendSessionId: string;
}

// "OBS Start Streaming" locally (see local_runtime::lifecycle::apply's
// StartNewSession branch) -> one backend stream_sessions row.
export const applySessionStarted = (
    streamUserId: string,
    eventId: string,
    payload: SessionStartedPayload
): Promise<SessionStartedResult> =>
    withIdempotency(eventId, streamUserId, "session_started", async (client) => {
        // Data-level idempotency: if this local_session_id was already
        // synced (e.g. the INSERT below succeeded once but the HTTP
        // response never reached Companion, and the retry arrived under a
        // *different* eventId because the sync worker restarted mid-delivery),
        // don't create a second backend row for the same local session.
        const existing = await client.query<{ id: number }>(
            `SELECT id FROM stream_sessions WHERE stream_user_id = $1 AND local_session_id = $2`,
            [streamUserId, payload.localSessionId]
        );
        if (existing.rows[0]) {
            return { backendSessionId: existing.rows[0].id.toString() };
        }

        // Companion's local lifecycle already guarantees at most one open
        // LocalSession at a time, but out-of-order/duplicate delivery (WK-113
        // failure matrix #11) could in principle let a session_started event
        // for a NEWER local session arrive before the previous one's
        // session_ended - closing any still-open backend session first keeps
        // idx_stream_sessions_one_active_per_user from rejecting the insert,
        // the same defense-in-depth stance idx_stream_matches_local_id takes
        // below for matches.
        await client.query(
            `UPDATE stream_sessions SET ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE stream_user_id = $1 AND ended_at IS NULL`,
            [streamUserId]
        );

        const inserted = await client.query<{ id: number }>(
            `INSERT INTO stream_sessions (stream_user_id, rating, local_session_id, started_at)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [streamUserId, payload.ratingStart, payload.localSessionId, payload.startedAt]
        );
        logger.info("Sync: session started", { streamUserId, localSessionId: payload.localSessionId });
        return { backendSessionId: inserted.rows[0].id.toString() };
    });

export interface SessionEndedPayload {
    localSessionId: string;
    endedAt: string;
}

export interface SessionEndedResult {
    backendSessionId: string | null;
}

// "OBS Stop Streaming + grace elapsed" locally.
export const applySessionEnded = (
    streamUserId: string,
    eventId: string,
    payload: SessionEndedPayload
): Promise<SessionEndedResult> =>
    withIdempotency(eventId, streamUserId, "session_ended", async (client) => {
        const result = await client.query<{ id: number }>(
            `UPDATE stream_sessions SET ended_at = COALESCE(ended_at, $3), updated_at = CURRENT_TIMESTAMP
             WHERE stream_user_id = $1 AND local_session_id = $2
             RETURNING id`,
            [streamUserId, payload.localSessionId, payload.endedAt]
        );
        if (!result.rows[0]) {
            // The session_started event for this local_session_id hasn't
            // been applied yet (out-of-order delivery, WK-113 failure
            // matrix #11) - nothing to end. The sync worker delivers in
            // order and only advances past a failed event once it
            // succeeds (see local_runtime::sync), so this is not expected
            // in normal operation, but must not be a hard error: the
            // eventId is still recorded (via withIdempotency) so a retry
            // doesn't loop forever if this really does happen.
            logger.warn("Sync: session_ended for an unknown local_session_id", {
                streamUserId,
                localSessionId: payload.localSessionId,
            });
            return { backendSessionId: null };
        }
        logger.info("Sync: session ended", { streamUserId, localSessionId: payload.localSessionId });
        return { backendSessionId: result.rows[0].id.toString() };
    });

export interface MatchFinalizedPayload {
    localSessionId: string;
    localMatchId: string;
    matchId: string | null;
    heroId: number;
    result: MatchResult;
    isRanked: boolean | null;
    ratingBefore: number | null;
    detectedRatingDelta: number | null;
    ratingAfter: number | null;
    confidence: "confirmed" | "probable";
    startedAt: string;
    finalizedAt: string;
}

export interface MatchFinalizedResult {
    backendMatchId: string | null;
}

// Companion's local match-detection state machine (local_runtime::detector)
// already resolved this match completely before this event is ever sent -
// unlike the legacy GSI-driven path (processGsiPayloadForMatch), this is a
// single INSERT of an already-decided outcome, not an incremental state
// machine re-deriving it from raw ticks.
export const applyMatchFinalized = (
    streamUserId: string,
    eventId: string,
    payload: MatchFinalizedPayload
): Promise<MatchFinalizedResult> =>
    withIdempotency(eventId, streamUserId, "match_finalized", async (client) => {
        const existingMatch = await client.query<{ id: number }>(
            `SELECT id FROM stream_matches WHERE stream_user_id = $1 AND local_match_id = $2`,
            [streamUserId, payload.localMatchId]
        );
        if (existingMatch.rows[0]) {
            return { backendMatchId: existingMatch.rows[0].id.toString() };
        }

        const session = await client.query<{ id: number }>(
            `SELECT id FROM stream_sessions WHERE stream_user_id = $1 AND local_session_id = $2 FOR UPDATE`,
            [streamUserId, payload.localSessionId]
        );
        const sessionId = session.rows[0]?.id ?? null;
        if (sessionId === null) {
            // The session this match belongs to hasn't been synced yet -
            // per the sync worker's strictly-ordered delivery this should
            // never happen (session_started always precedes its matches'
            // match_finalized events), but refusing outright would strand
            // this event and everything after it forever. Recording the
            // match without a session attachment (matches this table's
            // existing `stream_session_id` nullability - see
            // stream-match-service.ts) preserves the match/MMR history at
            // the cost of it not contributing to any session's W/L/rating -
            // logged loudly so it's visible, not silently lost.
            logger.error("Sync: match_finalized arrived before its session was synced", {
                streamUserId,
                localSessionId: payload.localSessionId,
                localMatchId: payload.localMatchId,
            });
        }

        const gameMode = payload.isRanked === true ? "ranked" : "unranked";
        const matchKey = `local:${payload.localMatchId}`;
        const inserted = await client.query<{ id: number }>(
            `INSERT INTO stream_matches
               (stream_user_id, match_id, match_key, stream_session_id, hero_id, kills, deaths, assists,
                result, result_source, rating_before, rating_delta, rating_after,
                detected_rating_delta, rating_delta_correction, rating_source, game_mode,
                state, is_ranked, mode_source, outcome_source, confidence,
                started_at, ended_at, finalized_at, finalize_reason, local_match_id)
             VALUES ($1, $2, $3, $4, $5, 0, 0, 0,
                     $6, 'gsi', $7, $8, $9,
                     $8, 0, $10, $11,
                     'finalized', $12, 'account_setting', 'win_team', $13,
                     $14, $15, $15, 'companion_sync', $16)
             RETURNING id`,
            [
                streamUserId,
                payload.matchId,
                matchKey,
                sessionId,
                payload.heroId,
                payload.result,
                payload.ratingBefore,
                payload.detectedRatingDelta,
                payload.ratingAfter,
                payload.isRanked === true ? "default" : null,
                gameMode,
                payload.isRanked,
                payload.confidence,
                payload.startedAt,
                payload.finalizedAt,
                payload.localMatchId,
            ]
        );
        const matchRowId = inserted.rows[0].id;

        if (sessionId !== null) {
            const winInc = payload.result === "win" ? 1 : 0;
            const lossInc = payload.result === "win" ? 0 : 1;
            await client.query(
                `UPDATE stream_sessions
                 SET wins = wins + $1, losses = losses + $2, rating = COALESCE($3, rating),
                     last_hero_id = $4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $5`,
                [winInc, lossInc, payload.ratingAfter, payload.heroId, sessionId]
            );
        }

        logger.info("Sync: match finalized", {
            streamUserId,
            localMatchId: payload.localMatchId,
            result: payload.result,
        });
        return { backendMatchId: matchRowId.toString() };
    });

export interface SyncedCorrection {
    localMatchId: string;
    ratingDelta: number;
    ratingAfter: number | null;
    correctedAt: string;
    sessionRating: number | null;
    sessionRatingAdjustment: number;
}

// WK-113 - the pull direction of reconciliation: a match corrected on the
// web dashboard (stream-match-correction-service.ts) after it was already
// synced needs to reach back to Companion's local copy, since Companion no
// longer re-derives its own history from anything backend-side. Scoped to
// matches Companion actually knows about (local_match_id IS NOT NULL) and
// corrected strictly after the caller's last-seen cursor. Deliberately a
// pull (Companion asks "what changed"), not a push, and deliberately NOT a
// full local correction workflow - see local_runtime::sync's pull loop for
// how the result is applied (updates only rating_delta_correction/
// rating_after on the matching local row, never detected_rating_delta -
// the original local detection is never overwritten, per WK-105's
// detected-vs-correction split).
export const getCorrectionsSince = async (
    streamUserId: string,
    since: string
): Promise<SyncedCorrection[]> => {
    const result = await pool.query<{
        local_match_id: string;
        rating_delta: number;
        rating_after: number | null;
        corrected_at: Date;
        session_rating: number | null;
        session_rating_adjustment: number;
    }>(
        // WK-113 correctness note: corrected_at is `timestamp without time
        // zone` (pre-existing, WK-105) - CURRENT_TIMESTAMP writes it as the
        // session timezone's local wall-clock reading, not UTC (confirmed:
        // a session with TimeZone != UTC stores a value that is NOT
        // directly comparable to a UTC ISO string from a caller in a
        // different timezone). `AT TIME ZONE current_setting('TIMEZONE')`
        // reinterprets the naive value back into the true absolute instant
        // (a real `timestamptz`) before comparing/returning it, so this is
        // correct regardless of what timezone this Postgres instance (or
        // the Companion caller) happens to run in.
        `SELECT m.local_match_id, m.rating_delta, m.rating_after,
                (m.corrected_at AT TIME ZONE current_setting('TIMEZONE')) AS corrected_at,
                s.rating AS session_rating, s.rating_adjustment AS session_rating_adjustment
         FROM stream_matches m
         LEFT JOIN stream_sessions s ON s.id = m.stream_session_id
         WHERE m.stream_user_id = $1
           AND m.local_match_id IS NOT NULL
           AND m.corrected_at IS NOT NULL
           AND (m.corrected_at AT TIME ZONE current_setting('TIMEZONE')) > $2::timestamptz
         ORDER BY m.corrected_at ASC`,
        [streamUserId, since]
    );
    return result.rows.map((row) => ({
        localMatchId: row.local_match_id,
        ratingDelta: row.rating_delta,
        ratingAfter: row.rating_after,
        correctedAt: row.corrected_at.toISOString(),
        sessionRating: row.session_rating,
        sessionRatingAdjustment: row.session_rating_adjustment,
    }));
};
