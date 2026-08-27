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
    inventory: unknown;
    result: MatchResult | null;
    rating_before: number | null;
    rating_delta: number | null;
    rating_after: number | null;
    detected_rating_delta: number | null;
    rating_delta_correction: number;
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

// WK-105 audit (post-review) - a match's rating correction must never
// silently diverge the account's CURRENT MMR from what its own session
// shows. Once a session has ended, correcting one of its matches would
// only ever update THAT (orphaned) session's `rating` column - nothing
// propagates the shift forward into the account's actual current session,
// nor into any later session's ratingStart. Properly supporting that would
// mean walking forward through every later session and re-anchoring each
// one, while preserving whatever independent absolute corrections those
// later sessions already accumulated - a materially bigger, riskier
// feature than this ticket's scope. Rather than leave the behavior
// undefined/silently inconsistent, rating corrections are rejected outright
// for matches whose session has already ended - explicit and testable
// instead of "случайное" behavior.
export class MatchSessionEndedError extends Error {
    constructor() {
        super(
            "Match belongs to a session that has already ended - rating corrections are only accepted for the account's current active session"
        );
    }
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

        // WK-105 - see MatchSessionEndedError above. Locks the session row
        // here (held for the rest of the transaction) and captures its
        // CURRENT ended_at/rating for later - avoids a second read below and
        // closes the race where a concurrent absolute correction
        // (applyAbsoluteRatingCorrection) could land between "read
        // session.rating" and "write session.rating". Session-less matches
        // (stream_session_id === null) skip this entirely - they never had a
        // session total to keep consistent. Whether an ended session
        // actually BLOCKS this command is decided below, once we know
        // whether the command touches rating at all (see commandTouchesRating) -
        // a pure result/W-L fix on an unranked (or already-unranked-bound)
        // match never moves session.rating, so there's nothing to protect.
        let sessionRatingBeforeCorrection: number | null = null;
        let sessionEnded = false;
        if (match.stream_session_id !== null) {
            const sessionLock = await client.query<{ ended_at: Date | null; rating: number | null }>(
                `SELECT ended_at, rating FROM stream_sessions WHERE id = $1 FOR UPDATE`,
                [match.stream_session_id]
            );
            const sessionRow = sessionLock.rows[0];
            sessionEnded = !sessionRow || sessionRow.ended_at !== null;
            sessionRatingBeforeCorrection = sessionRow?.rating ?? null;
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

        // WK-105 (post-review fix) - the ended-session guard must only
        // reject commands that would actually move session.rating - a pure
        // result fix on an unranked match, or resolving a needs_review
        // match that stays unranked, never touches the rating chain at all
        // and must remain correctable regardless of session state (blocking
        // it too would be a real capability regression, not a fix for the
        // rating-divergence bug this guard exists for). ratingDelta/
        // ratingAfter/isRanked always touch rating when present; a bare
        // `result` change only does when the match IS (or already was)
        // ranked, via the default-rebuild branch further down.
        const commandTouchesRating =
            command.ratingDelta !== undefined ||
            command.ratingAfter !== undefined ||
            command.isRanked !== undefined ||
            (command.result !== undefined && matchIsRanked === true);

        if (sessionEnded && commandTouchesRating) {
            await client.query("ROLLBACK");
            throw new MatchSessionEndedError();
        }

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
            // WK-105 (post-review cleanup) - the session row is already
            // locked FOR UPDATE above (sessionRatingBeforeCorrection) inside
            // this same transaction with no writes to stream_sessions.rating
            // in between - re-reading it here would only ever return the
            // same value, so reuse it instead of a redundant round trip.
            ratingBefore = sessionRatingBeforeCorrection;
        }

        const ratingChainAnchor = ratingBefore;
        let ratingDelta: number | null;
        let ratingAfter: number | null;
        let ratingSource: RatingSource | null = match.rating_source;
        // WK-105 - detectedRatingDelta - то, что определил auto-detect,
        // НИКОГДА не переписывается ручной коррекцией (только сбрасывается в
        // null, если режим матча уходит в unranked/unknown - см. блок ниже, и
        // заново фиксируется, если auto-правило впервые срабатывает для этого
        // матча). ratingDeltaCorrection - разница поверх него: effective
        // ratingDelta = detected + correction (инвариант, проверяемый ниже).
        // Диффуется от match.detected_rating_delta, а не от 0, чтобы
        // повторная правка (например, +25 -> +26 -> +25) не накапливала
        // ошибку - см. задачу.
        let detectedRatingDelta: number | null = match.detected_rating_delta;
        let ratingDeltaCorrection: number = match.rating_delta_correction;

        if (newResult === "abandon") {
            ratingDelta = -DEFAULT_RATING_STEP;
            ratingAfter = ratingBefore !== null ? ratingBefore + ratingDelta : null;
            ratingSource = "default";
            // ABANDON - фиксированное системное правило (см. AbandonRatingEditError
            // выше: ручная дельта для него вообще запрещена), а не коррекция
            // поверх чего-то - трактуем как свежий auto-detect.
            detectedRatingDelta = ratingDelta;
            ratingDeltaCorrection = 0;
        } else if (command.ratingAfter !== undefined) {
            ratingDelta = ratingBefore !== null ? command.ratingAfter - ratingBefore : null;
            ratingAfter = command.ratingAfter;
            ratingSource = "manual";
            // WK-105 (post-review fix) - when ratingBefore is still unknown
            // (no anchor - see the UI hint "рейтинг до матча восстановит
            // сервер"), ratingDelta above is null, not a real number. Naively
            // computing (ratingDelta ?? 0) - detected would fabricate a
            // nonzero "correction" next to a null effective delta, breaking
            // the detected+correction=effective invariant and permanently
            // hiding this match from getSessionMatchRatingDelta's sum. Honest
            // choice: with no anchor, there is nothing meaningful to say
            // about "how much was corrected" yet - null out both, exactly
            // like the unranked case below.
            if (ratingDelta === null) {
                detectedRatingDelta = null;
                ratingDeltaCorrection = 0;
            } else {
                ratingDeltaCorrection = ratingDelta - (detectedRatingDelta ?? 0);
            }
        } else if (command.ratingDelta !== undefined) {
            ratingDelta = command.ratingDelta;
            ratingAfter = ratingBefore !== null ? ratingBefore + command.ratingDelta : null;
            ratingSource = "manual";
            ratingDeltaCorrection = ratingDelta - (detectedRatingDelta ?? 0);
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
            // Ветка не трогает уже проставленную вручную дельту
            // (match.rating_source === "manual") - detected/correction тоже
            // остаются как есть. Иначе (свежее auto-правило впервые
            // отработало для этого матча) - фиксируем его как detected.
            if (match.rating_source !== "manual") {
                detectedRatingDelta = ratingDelta;
                ratingDeltaCorrection = 0;
            }
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
            // Матч больше не ranked - как и остальные rating_*, detected/
            // correction перестают что-либо означать (см. задачу, п.10: не
            // придумывать значение для unranked). Если позже снова станет
            // ranked с явной дельтой, detected останется null (auto-detect по
            // нему ни разу не отработал), а вся дельта уйдёт в correction -
            // см. ветки выше.
            detectedRatingDelta = null;
            ratingDeltaCorrection = 0;
        }

        // WK-105 audit (post-review) - how much session.rating needs to
        // shift by, independent of session.rating_adjustment. Every match
        // strictly after the edited one shifts its own before/after by this
        // exact same constant (see the cascade loop below), so it also
        // equals exactly how much the tail's final value moves - but unlike
        // recomputing "the new tail value" from scratch (see the write
        // further down), this is computed purely from what changed on THIS
        // match, so adding it to the session's CURRENT rating (captured in
        // sessionRatingBeforeCorrection above) can never lose an absolute
        // Current-MMR correction that happened after this match's
        // rating_before was last anchored - that correction lives only in
        // session.rating/rating_adjustment, never in any stream_matches row,
        // so it would otherwise be silently erased by an unconditional
        // "session.rating = freshly recomputed chain value" overwrite.
        const oldContribution = match.rating_delta ?? 0;
        const newContribution = ratingDelta ?? 0;
        const contributionDifference = newContribution - oldContribution;

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
                 detected_rating_delta = $15, rating_delta_correction = $16,
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
                detectedRatingDelta,
                ratingDeltaCorrection,
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

        // Сессия уже залочена FOR UPDATE выше (см. sessionRatingBeforeCorrection) -
        // конкурентный GSI POST_GAME не может вставить новый матч в середину
        // пересчитываемой цепочки, лочить второй раз незачем.

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

        // WK-105 audit (post-review) - diff-based, NOT "rating =
        // tailRatingAfter" outright: session.rating may already include an
        // absolute Current-MMR correction (rating_adjustment) that isn't
        // reachable from the match chain at all (applyAbsoluteRatingCorrection
        // never touches stream_matches) - overwriting it with a freshly
        // recomputed chain value would silently erase that adjustment. Every
        // match at/after the edited one shifts by exactly
        // contributionDifference (see the cascade loop above), so adding
        // that same constant to the session's CURRENT rating preserves
        // whatever adjustment is already baked into it, regardless of when
        // it was applied. Falls back to the freshly computed tailRatingAfter
        // only when the session had no valid rating to begin with (self-
        // healing a null session.rating from the chain - same fallback the
        // pre-WK-105 code already relied on).
        // WK-105 audit (post-review fix #2) - the diff-based branch below
        // needs no fresh chain value at all (contributionDifference is
        // computed purely from THIS match's own old/new rating_delta,
        // independent of tailRatingAfter) - gating the whole write on
        // `tailRatingAfter !== null` (a leftover from the old
        // "session.rating = tailRatingAfter" overwrite) silently dropped a
        // real, nonzero contributionDifference whenever the edited match
        // itself has no rating_before anchor of its own (e.g. it's the
        // session's first match and is being turned unranked) - session.rating
        // then kept the match's old contribution baked in forever, corrupting
        // every later resetActiveSession's carried-forward ratingStart. Only
        // the true self-heal fallback (session had no rating at all) still
        // needs tailRatingAfter, and only when there is one to fall back to.
        if (sessionRatingBeforeCorrection !== null || tailRatingAfter !== null) {
            const nextSessionRating =
                sessionRatingBeforeCorrection !== null
                    ? sessionRatingBeforeCorrection + contributionDifference
                    : tailRatingAfter;
            await client.query(
                `UPDATE stream_sessions SET rating = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [nextSessionRating, sessionId]
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
