import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import {
    MATCH_COLUMNS,
    toStreamMatch,
    type MatchConfidence,
    type MatchResult,
    type MatchState,
    type ModeSource,
    type OutcomeSource,
    type RatingSource,
    type ResultSource,
    type StreamGameMode,
    type StreamMatch,
} from "./stream-match-service.js";
import {
    SESSION_COLUMNS,
    toStreamSession,
    type StreamSession,
} from "./stream-session-service.js";

export interface MatchCorrectionCommand {
    result?: MatchResult;
    ratingDelta?: number;
    ratingAfter?: number;
    isRanked?: boolean;
    // "Не учитывать" (needs_review) - см. задачу: разрешить needs_review
    // через существующую мобильную панель без результата/рейтинга. Только
    // для матчей в state 'needs_review' (или повторный вызов на уже
    // отклонённом - идемпотентно), см. EDITABLE_STATES/discard-ветку ниже.
    discard?: boolean;
}

export interface MatchCorrectionResult {
    match: StreamMatch;
    session: StreamSession | null;
}

export class MatchNotFoundError extends Error {
    constructor() {
        super("Match not found");
    }
}

// Матч ещё не разрешён (in_progress/post_game_pending/interrupted) - у него
// нет зафиксированного исхода, который имело бы смысл "корректировать":
// править его напрямую в обход lifecycle (observeGsi/finalizeMatch) сломало
// бы гарантии идемпотентности финализации. На практике недостижимо через UI
// (listMatchesForAccount не отдаёт такие строки), это защита на уровне API.
export class MatchNotEditableError extends Error {
    constructor() {
        super("Match is not in an editable state");
    }
}

interface MatchRow {
    id: number;
    match_id: string | null;
    match_key: string;
    stream_session_id: number | null;
    hero_id: number;
    kills: number;
    deaths: number;
    assists: number;
    result: MatchResult | null;
    rating_before: number | null;
    rating_delta: number | null;
    rating_after: number | null;
    result_source: ResultSource;
    rating_source: RatingSource | null;
    game_mode: StreamGameMode;
    state: MatchState;
    is_ranked: boolean | null;
    is_party: boolean | null;
    mode_source: ModeSource;
    outcome_source: OutcomeSource;
    confidence: MatchConfidence;
    post_game_detected_at: Date | null;
    started_at: Date;
    ended_at: Date | null;
    finalized_at: Date | null;
    finalize_reason: string | null;
    corrected_at: Date | null;
}

export class UnrankedRatingEditError extends Error {
    constructor() {
        super("Rating cannot be edited on an unranked or unknown-mode match");
    }
}

export class AbandonRatingEditError extends Error {
    constructor() {
        super("Rating delta cannot be edited manually on an abandoned match");
    }
}

export class RankedRatingRequiredError extends Error {
    constructor() {
        super("A rating delta or final rating is required when changing a match to ranked");
    }
}

interface SessionRow {
    id: number;
    wins: number;
    losses: number;
    rating: number | null;
}

const DEFAULT_RATING_STEP = 25;

const EDITABLE_STATES: MatchState[] = ["finalized", "needs_review"];

// Ручная корректировка одного матча + каскадный пересчёт цепочки рейтинга
// всех более поздних матчей той же сессии, плюс - новое - разрешение
// needs_review (первое подтверждение результата матча, у которого его не
// было вовсе, либо "не учитывать"). В отличие от finalizeMatch
// (stream-match-service.ts), здесь редактируется УЖЕ существующая строка,
// поэтому вся сессия и весь "хвост" матчей после редактируемого лочатся
// SELECT ... FOR UPDATE на время одной транзакции.
export const correctStreamMatch = async (
    streamUserId: string,
    matchId: string,
    command: MatchCorrectionCommand
): Promise<MatchCorrectionResult> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const matchResult = await client.query<MatchRow>(
            `SELECT ${MATCH_COLUMNS} FROM stream_matches
             WHERE id = $1 AND stream_user_id = $2
             FOR UPDATE`,
            [matchId, streamUserId]
        );
        const match = matchResult.rows[0];
        if (!match) {
            await client.query("ROLLBACK");
            throw new MatchNotFoundError();
        }

        if (!EDITABLE_STATES.includes(match.state)) {
            await client.query("ROLLBACK");
            throw new MatchNotEditableError();
        }

        if (command.discard) {
            if (match.state === "finalized" && match.finalize_reason === "manual_discard") {
                // Повторный "не учитывать" на уже отклонённом матче -
                // идемпотентный no-op.
                await client.query("COMMIT");
                return { match: toStreamMatch(match), session: null };
            }
            if (match.state !== "needs_review") {
                await client.query("ROLLBACK");
                throw new MatchNotEditableError();
            }

            const discarded = await client.query<MatchRow>(
                `UPDATE stream_matches
                 SET state = 'finalized', finalized_at = CURRENT_TIMESTAMP,
                     finalize_reason = 'manual_discard', confidence = 'uncertain',
                     corrected_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING ${MATCH_COLUMNS}`,
                [match.id]
            );
            await client.query("COMMIT");
            logger.info("Stream match discarded", { streamUserId, matchId: match.id });
            return { match: toStreamMatch(discarded.rows[0]), session: null };
        }

        // Разрешение needs_review (первое подтверждение результата) - режим
        // (is_ranked/mode_source) уже зафиксирован в момент СОЗДАНИЯ матча
        // (см. createMatch/resolveIsRanked в stream-match-service.ts) и
        // остаётся неизменным до этого момента - здесь НЕЛЬЗЯ повторно
        // читать текущий stream_users.game_mode: пользователь мог переключить
        // тумблер уже после того, как этот матч начался, и это не должно
        // ретроспективно менять его режим (см. задачу, п.2). Ручная
        // Текущий account game_mode здесь по-прежнему не читается. Если
        // команда содержит isRanked, это точечная ручная коррекция только
        // этой строки; undefined сохраняет зафиксированный при создании режим.
        const resolvingReview = match.state === "needs_review" && command.result !== undefined;
        const matchIsRanked = command.isRanked ?? match.is_ranked;
        const changingToRanked = command.isRanked === true && match.is_ranked !== true;

        if (
            changingToRanked &&
            command.ratingDelta === undefined &&
            command.ratingAfter === undefined &&
            (command.result ?? match.result) !== "abandon"
        ) {
            await client.query("ROLLBACK");
            throw new RankedRatingRequiredError();
        }

        // Unranked ИЛИ неизвестный режим (is_ranked !== true) - рейтинг
        // никогда не редактируется вручную (см. задачу, п.10: неизвестный
        // режим нельзя молча считать рейтинговым - в том числе при ручной
        // правке).
        if (
            matchIsRanked !== true &&
            (command.ratingDelta !== undefined || command.ratingAfter !== undefined)
        ) {
            await client.query("ROLLBACK");
            throw new UnrankedRatingEditError();
        }

        const resultChanged =
            command.result !== undefined && command.result !== match.result;
        const newResult: MatchResult | null = command.result ?? match.result;
        const newResultSource: ResultSource = resultChanged ? "manual" : match.result_source;

        if (
            newResult === "abandon" &&
            (command.ratingDelta !== undefined || command.ratingAfter !== undefined)
        ) {
            await client.query("ROLLBACK");
            throw new AbandonRatingEditError();
        }

        // ratingBefore: если в сессии есть более ранний матч - берём его
        // rating_after, самоисцеляясь от любого дрейфа. Порядок - строго по
        // id (SERIAL), а НЕ по ended_at (см. исходный комментарий про
        // расхождение точности JS Date/Postgres TIMESTAMP).
        let ratingBefore = match.rating_before;
        let hasEarlierMatch = false;
        if (match.stream_session_id !== null) {
            const prevResult = await client.query<{ rating_after: number | null }>(
                `SELECT rating_after FROM stream_matches
                 WHERE stream_session_id = $1 AND id < $2 AND rating_after IS NOT NULL
                 ORDER BY id DESC
                 LIMIT 1`,
                [match.stream_session_id, match.id]
            );
            if (prevResult.rows[0]) {
                hasEarlierMatch = true;
                ratingBefore = prevResult.rows[0].rating_after;
            }
        }

        if (!hasEarlierMatch && ratingBefore === null && match.stream_session_id !== null) {
            const nextAnchor = await client.query<{ rating_before: number | null }>(
                `SELECT rating_before FROM stream_matches
                 WHERE stream_session_id = $1 AND id > $2 AND rating_before IS NOT NULL
                 ORDER BY id ASC LIMIT 1`,
                [match.stream_session_id, match.id]
            );
            ratingBefore = nextAnchor.rows[0]?.rating_before ?? null;
        }

        // Разрешение needs_review, у которого до этого ни разу не
        // проходила finalizeMatch: rating_before на строке ещё не был
        // никем зафиксирован (null), и это первый матч сессии (нет более
        // раннего в цепочке) - без этого фолбэка ratingBefore так и
        // остался бы null, хотя у сессии уже есть текущий рейтинг. Ровно
        // то же самое финализация делает для обычного (не needs_review)
        // первого матча сессии (см. finalizeMatch: `session?.rating ?? null`).
        if (!hasEarlierMatch && ratingBefore === null && matchIsRanked === true) {
            const sessionRating = await client.query<{ rating: number | null }>(
                `SELECT rating FROM stream_sessions WHERE id = $1`,
                [match.stream_session_id]
            );
            ratingBefore = sessionRating.rows[0]?.rating ?? null;
        }

        const ratingChainAnchor = ratingBefore;
        let ratingDelta: number | null;
        let ratingAfter: number | null;
        let ratingSource: RatingSource | null = match.rating_source;

        if (newResult === "abandon") {
            ratingDelta = -DEFAULT_RATING_STEP;
            ratingAfter = ratingBefore !== null ? ratingBefore + ratingDelta : null;
            ratingSource = "default";
        } else if (command.ratingAfter !== undefined) {
            ratingDelta = ratingBefore !== null ? command.ratingAfter - ratingBefore : null;
            ratingAfter = command.ratingAfter;
            ratingSource = "manual";
        } else if (command.ratingDelta !== undefined) {
            ratingDelta = command.ratingDelta;
            ratingAfter = ratingBefore !== null ? ratingBefore + command.ratingDelta : null;
            ratingSource = "manual";
        } else if (matchIsRanked === true && (resultChanged || match.rating_delta === null)) {
            // Дефолтная +25/-25 - либо result впервые появился (needs_review
            // -> win/loss без ранее известной дельты), либо сменился
            // win<->loss и дельта раньше не была зафиксирована вручную.
            ratingDelta =
                match.rating_source === "manual"
                    ? match.rating_delta
                    : newResult === "win"
                      ? DEFAULT_RATING_STEP
                      : -DEFAULT_RATING_STEP;
            ratingAfter =
                ratingBefore !== null && ratingDelta !== null ? ratingBefore + ratingDelta : null;
        } else {
            ratingDelta = matchIsRanked === true ? match.rating_delta : null;
            ratingAfter =
                ratingBefore !== null && ratingDelta !== null ? ratingBefore + ratingDelta : null;
        }
        if (matchIsRanked !== true) {
            ratingBefore = null;
            ratingDelta = null;
            ratingAfter = null;
            ratingSource = null;
        }

        const newState: MatchState = resolvingReview ? "finalized" : match.state;
        // Без isRanked режим остаётся зафиксированным при создании. Явное
        // boolean-значение меняет только этот матч и получает audit source.
        const newIsRanked = matchIsRanked;
        const newModeSource: ModeSource =
            command.isRanked !== undefined ? "manual_correction" : match.mode_source;
        const newConfidence: MatchConfidence = resolvingReview ? "confirmed" : match.confidence;
        const newFinalizeReason = resolvingReview
            ? "manual_review_resolution"
            : match.finalize_reason;
        const newGameMode: StreamGameMode =
            newIsRanked === true ? "ranked" : "unranked";

        const updatedRow = await client.query<MatchRow>(
            `UPDATE stream_matches
             SET result = $1, rating_before = $2, rating_delta = $3, rating_after = $4,
                 result_source = $5, rating_source = $6, corrected_at = CURRENT_TIMESTAMP,
                 state = $7, is_ranked = $8, mode_source = $9, confidence = $10,
                 finalize_reason = $11, game_mode = $12,
                 finalized_at = CASE WHEN $14 THEN COALESCE(finalized_at, CURRENT_TIMESTAMP) ELSE finalized_at END
             WHERE id = $13
             RETURNING ${MATCH_COLUMNS}`,
            [
                newResult,
                ratingBefore,
                ratingDelta,
                ratingAfter,
                newResultSource,
                ratingSource,
                newState,
                newIsRanked,
                newModeSource,
                newConfidence,
                newFinalizeReason,
                newGameMode,
                match.id,
                resolvingReview,
            ]
        );
        const updatedMatch = updatedRow.rows[0];

        logger.info("Stream match corrected", {
            streamUserId,
            matchId: match.id,
            result: newResult,
            ratingDelta,
            ratingAfter,
            resolvingReview,
        });

        if (match.stream_session_id === null) {
            await client.query("COMMIT");
            return { match: toStreamMatch(updatedMatch), session: null };
        }

        const sessionId = match.stream_session_id;

        // Лочим строку сессии на время каскада, даже не читая её значения -
        // конкурентный GSI POST_GAME не должен вставить новый матч в
        // середину пересчитываемой цепочки.
        await client.query<SessionRow>(
            `SELECT id FROM stream_sessions WHERE id = $1 FOR UPDATE`,
            [sessionId]
        );

        const tailResult = await client.query<MatchRow>(
            `SELECT ${MATCH_COLUMNS} FROM stream_matches
             WHERE stream_session_id = $1 AND id > $2
             ORDER BY id ASC
             FOR UPDATE`,
            [sessionId, match.id]
        );

        let prevAfter =
            newIsRanked === true ? ratingAfter : ratingChainAnchor;
        let affectedMatches = 0;
        let tailRatingAfter = prevAfter;

        for (const row of tailResult.rows) {
            if (row.is_ranked === true && row.rating_delta !== null) {
                const nextBefore = prevAfter;
                const nextAfter = prevAfter !== null ? prevAfter + row.rating_delta : null;
                await client.query(
                    `UPDATE stream_matches SET rating_before = $1, rating_after = $2 WHERE id = $3`,
                    [nextBefore, nextAfter, row.id]
                );
                prevAfter = nextAfter;
                affectedMatches += 1;
            } else {
                if (row.rating_delta !== null || row.rating_before !== null || row.rating_after !== null) {
                    await client.query(
                        `UPDATE stream_matches
                         SET rating_before = NULL, rating_delta = NULL, rating_after = NULL
                         WHERE id = $1`,
                        [row.id]
                    );
                    affectedMatches += 1;
                }
            }
            tailRatingAfter = prevAfter;
        }

        if (affectedMatches > 0) {
            logger.info("Stream match rating chain recalculated", {
                streamUserId,
                sessionId,
                affectedMatches,
            });
        }

        // "Не было зафиксировано вообще" (needs_review, result был null) не
        // считается ни победой, ни поражением - переход null -> win/loss
        // засчитывает ровно ОДНУ категорию (не декрементирует то, чего
        // никогда не прибавляли), а не трактует null как "был loss" (что
        // дало бы неверный лишний -1 к losses при null -> win).
        const wasCounted = match.result !== null;
        if (resultChanged || (wasCounted === false && newResult !== null)) {
            const oldIsWin = wasCounted && match.result === "win";
            const newIsWin = newResult === "win";
            const winDelta = (newIsWin ? 1 : 0) - (oldIsWin ? 1 : 0);
            const lossDelta = (newIsWin ? 0 : 1) - (wasCounted ? (oldIsWin ? 0 : 1) : 0);
            // Ручное разрешение needs_review использует последнего
            // достоверно наблюдавшегося героя ЭТОГО матча (match.hero_id,
            // уже актуализированный GSI-пайплайном - см. resumeMatch в
            // stream-match-service.ts) - но только если это ещё и самый
            // свежий матч сессии (нет более позднего в tailResult), иначе
            // разрешение старого спорного матча задним числом перезаписало
            // бы last_hero_id уже сыгранными после него матчами.
            const isLatestInSession = tailResult.rows.length === 0;
            const shouldUpdateLastHero = resolvingReview && isLatestInSession;
            await client.query(
                `UPDATE stream_sessions
                 SET wins = GREATEST(wins + $1, 0), losses = GREATEST(losses + $2, 0),
                     last_hero_id = CASE WHEN $3 THEN $4::integer ELSE last_hero_id END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $5`,
                [winDelta, lossDelta, shouldUpdateLastHero, match.hero_id, sessionId]
            );
            logger.info("Stream session totals recalculated", {
                streamUserId,
                sessionId,
                winDelta,
                lossDelta,
            });
        }

        if (tailRatingAfter !== null) {
            await client.query(
                `UPDATE stream_sessions SET rating = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [tailRatingAfter, sessionId]
            );
        }

        const finalSession = await client.query(
            `SELECT ${SESSION_COLUMNS} FROM stream_sessions WHERE id = $1`,
            [sessionId]
        );

        await client.query("COMMIT");

        return {
            match: toStreamMatch(updatedMatch),
            session: toStreamSession(finalSession.rows[0]),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};
