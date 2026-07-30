import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { getOrCreateActiveSession } from "./stream-session-service.js";
import { getSteamLink, type StreamGameMode } from "./stream-user-service.js";

export type MatchResult = "win" | "loss" | "abandon";
export type ResultSource = "gsi" | "manual";
export type RatingSource = "default" | "manual";
export type { StreamGameMode };

// Явный жизненный цикл матча (см. задачу "укрепить пайплайн обработки
// матчей"). "pre_game" из целевой модели намеренно не материализуется как
// отдельное состояние в БД: строка создаётся, только когда уже известны
// hero_id и команда игрока (см. createMatch/observeGsi ниже) - раньше этого
// момента нет ничего, что стоило бы персистить, а "матч ещё не начался"
// и так выражается отсутствием активной строки.
export type MatchState =
    | "in_progress"
    | "post_game_pending"
    | "finalized"
    | "needs_review"
    | "interrupted";

export type ModeSource = "account_setting" | "manual_correction" | null;
export type OutcomeSource = "win_team" | null;
export type MatchConfidence = "confirmed" | "probable" | "uncertain";

const ACTIVE_STATES: MatchState[] = ["in_progress", "post_game_pending", "interrupted"];

export interface StreamMatch {
    id: string;
    matchId: string | null;
    matchRunId: string;
    streamSessionId: string | null;
    heroId: number;
    kills: number;
    deaths: number;
    assists: number;
    inventory: Array<string | null>;
    result: MatchResult | null;
    ratingBefore: number | null;
    ratingDelta: number | null;
    ratingAfter: number | null;
    resultSource: ResultSource;
    ratingSource: RatingSource | null;
    gameMode: StreamGameMode;
    state: MatchState;
    isRanked: boolean | null;
    isParty: boolean | null;
    modeSource: ModeSource;
    outcomeSource: OutcomeSource;
    confidence: MatchConfidence;
    postGameDetectedAt: string | null;
    startedAt: string;
    endedAt: string | null;
    finalizedAt: string | null;
    finalizeReason: string | null;
    correctedAt: string | null;
}

interface StreamMatchRow {
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

export const MATCH_COLUMNS =
    "id, match_id, match_key, stream_session_id, hero_id, kills, deaths, assists, inventory, result, " +
    "rating_before, rating_delta, rating_after, result_source, rating_source, game_mode, " +
    "state, is_ranked, is_party, mode_source, outcome_source, confidence, post_game_detected_at, " +
    "started_at, ended_at, finalized_at, finalize_reason, corrected_at";

export const toStreamMatch = (row: StreamMatchRow): StreamMatch => ({
    id: row.id.toString(),
    matchId: row.match_id,
    matchRunId: row.match_key,
    streamSessionId:
        row.stream_session_id !== null ? row.stream_session_id.toString() : null,
    heroId: row.hero_id,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    inventory: Array.isArray(row.inventory)
        ? row.inventory
              .slice(0, 9)
              .map((item) => (typeof item === "string" ? item : null))
        : [],
    result: row.result,
    ratingBefore: row.rating_before,
    ratingDelta: row.rating_delta,
    ratingAfter: row.rating_after,
    resultSource: row.result_source,
    ratingSource: row.rating_source,
    gameMode: row.game_mode,
    state: row.state,
    isRanked: row.is_ranked,
    isParty: row.is_party,
    modeSource: row.mode_source,
    outcomeSource: row.outcome_source,
    confidence: row.confidence,
    postGameDetectedAt: row.post_game_detected_at ? row.post_game_detected_at.toISOString() : null,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    finalizedAt: row.finalized_at ? row.finalized_at.toISOString() : null,
    finalizeReason: row.finalize_reason,
    correctedAt: row.corrected_at ? row.corrected_at.toISOString() : null,
});

// Только уже разрешённые матчи - "finalized" (нормально завершённые) и
// "needs_review" (спорные, но видимые в истории для ручного разбора через
// QuickMatchPanel/MatchHistoryPanel). in_progress/post_game_pending/
// interrupted сознательно не попадают сюда - структурно нельзя
// отредактировать или увидеть в overlay ещё не разрешённый матч.
const ACCOUNT_VISIBLE_STATES = "('finalized', 'needs_review')";

export const getRecentMatches = async (
    streamUserId: string,
    limit = 10
): Promise<StreamMatch[]> => {
    const result = await pool.query<StreamMatchRow>(
        `SELECT ${MATCH_COLUMNS}
         FROM stream_matches
         WHERE stream_user_id = $1 AND state IN ${ACCOUNT_VISIBLE_STATES}
         ORDER BY id DESC
         LIMIT $2`,
        [streamUserId, limit]
    );
    return result.rows.map(toStreamMatch);
};

// Как getRecentMatches, но только матчи ТЕКУЩЕЙ сессии, и только уже
// "finalized" - публичный overlay не должен показывать спорные needs_review
// строки (см. задачу: "публичный overlay должен получать только матчи
// текущей активной сессии", ambiguous-данные там неуместны). Использует
// stream_session_id, назначенный ОДИН РАЗ при создании матча (см.
// createMatch) и больше никогда не меняющийся - поэтому смена активной
// сессии посреди матча ("начать новый стрим") не переносит матч в новую
// сессию и не заставляет старую сессию потерять его.
export const getRecentMatchesForSession = async (
    sessionId: string,
    limit = 10
): Promise<StreamMatch[]> => {
    const result = await pool.query<StreamMatchRow>(
        `SELECT ${MATCH_COLUMNS}
         FROM stream_matches
         WHERE stream_session_id = $1 AND state = 'finalized'
         ORDER BY id DESC
         LIMIT $2`,
        [sessionId, limit]
    );
    return result.rows.map(toStreamMatch);
};

// Рейтинг сессии до самого первого её матча - см. исходный комментарий (не
// заводить отдельную колонку под "стартовый рейтинг сессии").
export const getSessionStartRating = async (
    sessionId: string
): Promise<number | null> => {
    const result = await pool.query<{ rating_before: number | null }>(
        `SELECT rating_before
         FROM stream_matches
         WHERE stream_session_id = $1 AND state = 'finalized' AND rating_before IS NOT NULL
         ORDER BY id ASC
         LIMIT 1`,
        [sessionId]
    );
    return result.rows[0]?.rating_before ?? null;
};

export const listMatchesForAccount = async (
    streamUserId: string,
    limit = 50
): Promise<StreamMatch[]> => getRecentMatches(streamUserId, limit);

// GSI game_state значения, в которых игрок реально находится в матче (от
// пика героя до послематчевого экрана).
const IN_MATCH_STATES = new Set([
    "DOTA_GAMERULES_STATE_HERO_SELECTION",
    "DOTA_GAMERULES_STATE_STRATEGY_TIME",
    "DOTA_GAMERULES_STATE_PRE_GAME",
    "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
    "DOTA_GAMERULES_STATE_POST_GAME",
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const asString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

const asNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

const extractInventory = (value: unknown): Array<string | null> => {
    const items = asRecord(value);
    return Array.from({ length: 9 }, (_, index) => {
        const slot = items ? asRecord(items[`slot${index}`]) : null;
        const name = slot ? asString(slot.name) : null;
        return name && name.startsWith("item_") ? name : null;
    });
};

const RATING_DEFAULT_STEP = 25;

const isUniqueViolation = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505";

interface ActiveMatchRow {
    id: number;
    match_id: string | null;
    hero_id: number;
    player_team: string | null;
    state: MatchState;
    result: MatchResult | null;
    interrupted_at: Date | null;
}

const findActiveMatch = async (streamUserId: string): Promise<ActiveMatchRow | null> => {
    const result = await pool.query<ActiveMatchRow>(
        `SELECT id, match_id, hero_id, player_team, state, result, interrupted_at
         FROM stream_matches
         WHERE stream_user_id = $1 AND state = ANY($2::varchar[])
         ORDER BY id DESC
         LIMIT 1`,
        [streamUserId, ACTIVE_STATES]
    );
    return result.rows[0] ?? null;
};

// GSI game_state значения, которые встречаются ТОЛЬКО на старте нового
// матча (пик героя, стратегия, ожидание пре-гейма) - реконнект к уже
// идущему матчу возобновляется сразу в GAME_IN_PROGRESS/POST_GAME, эти
// состояния при реконнекте больше не повторяются. Надёжный, документированный
// сообществом сигнал "это новый матч", а не признак угадывания.
const NEW_MATCH_SIGNAL_STATES = new Set([
    "DOTA_GAMERULES_STATE_HERO_SELECTION",
    "DOTA_GAMERULES_STATE_STRATEGY_TIME",
    "DOTA_GAMERULES_STATE_PRE_GAME",
]);

// Окно, в течение которого разрыв соединения ещё считается реконнектом к
// тому же матчу, а не новой игрой - 5 минут совпадает с реальным таймером
// Dota 2, после которого клиент сам засчитывает уход как abandon, а не с
// произвольно выбранным числом.
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;

const isWithinReconnectWindow = (interruptedAt: Date | null): boolean =>
    interruptedAt === null || Date.now() - interruptedAt.getTime() <= RECONNECT_WINDOW_MS;

// Матч, который нельзя уверенно завершить (спорный результат, вытеснен
// новым матчем и т.п.) - сохраняется в истории, W/L и rating не трогаются
// (см. finalizeMatch: needs_review никогда туда не попадает как источник
// изменений). Гард "state != 'finalized'" делает вызов безопасным даже если
// строка либо уже финализирована, либо это повторный тик - идемпотентно.
const markNeedsReview = async (matchRowId: number, reason: string): Promise<void> => {
    // result сбрасывается в NULL безусловно: needs_review по определению
    // означает "нет доверенного результата" - finalizeMatch (единственное
    // место, где result становится доверенным/учтённым в W-L) сюда никогда
    // не переходит из needs_review. Любое ранее записанное сюда значение
    // (например, единственное неподтверждённое наблюдение из
    // post_game_pending) было ТОЛЬКО черновым - если его оставить, ручное
    // разрешение (correctStreamMatch) ошибочно решило бы, что матч уже был
    // учтён в wins/losses, и не досчитало бы его при первом подтверждении.
    await pool.query(
        `UPDATE stream_matches
         SET state = 'needs_review', finalize_reason = $2, confidence = 'uncertain', result = NULL
         WHERE id = $1 AND state != 'finalized'`,
        [matchRowId, reason]
    );
    logger.info("Stream match sent to review", { matchRowId, reason });
};

const markInterrupted = async (matchRowId: number): Promise<void> => {
    // interrupted_at фиксирует момент разрыва - именно от него отсчитывается
    // RECONNECT_WINDOW_MS в sameMatch (processGsiPayloadForMatch).
    await pool.query(
        `UPDATE stream_matches
         SET state = 'interrupted', interrupted_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state = 'in_progress'`,
        [matchRowId]
    );
};

// Реконнект/companion-рестарт к тому же матчу: возвращает interrupted обратно
// в in_progress (сбрасывая interrupted_at - следующий возможный разрыв
// отсчитывает окно заново), (если известен) дописывает match_id на строку,
// где он раньше был не известен (GSI не всегда даёт matchid сразу), и
// обновляет hero_id текущим валидным наблюдением. hero_id у ещё не
// финализированного матча - изменяемое наблюдаемое значение, а не
// immutable-идентификатор (см. задачу "герой матча"): пик может быть
// сброшен/забанен и переигран (Snapfire -> Techies -> Treant), а уже во
// время игры игроки могут обменяться героями - в обоих случаях строка
// должна отражать ПОСЛЕДНЕЕ валидное наблюдение, а не то, что было на
// момент createMatch. false - если только что узнанный match_id
// конфликтует с ДРУГОЙ, уже существующей строкой этого пользователя
// (idx_stream_matches_user_external_match) - вызывающий код в этом случае
// считает текущую строку потерянной для сопоставления, а не пытается
// угадать дальше.
const resumeMatch = async (
    matchRowId: number,
    matchId: string | null,
    heroId: number,
    inventory: Array<string | null>
): Promise<boolean> => {
    try {
        await pool.query(
            `UPDATE stream_matches
             SET state = CASE WHEN state = 'interrupted' THEN 'in_progress' ELSE state END,
                 interrupted_at = NULL,
                 match_id = COALESCE(match_id, $2),
                 hero_id = $3,
                 inventory = $4::jsonb
             WHERE id = $1`,
            [matchRowId, matchId, heroId, JSON.stringify(inventory)]
        );
        return true;
    } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
    }
};

const createMatch = async (params: {
    streamUserId: string;
    matchId: string | null;
    heroId: number;
    teamName: string;
    kills: number;
    deaths: number;
    assists: number;
    inventory: Array<string | null>;
    startedAt: Date;
}): Promise<void> => {
    const session = await getOrCreateActiveSession(params.streamUserId);
    const matchKey = params.matchId
        ? `gsi:${params.matchId}`
        : `session:${params.streamUserId}:${params.startedAt.getTime()}:${params.heroId}`;

    // Режим фиксируется ОДИН РАЗ здесь, в момент создания строки матча (см.
    // задачу, п.2) - finalizeMatch больше не читает stream_users.game_mode
    // заново, поэтому переключение тумблера во время уже идущего матча не
    // может задним числом изменить его исход. is_ranked/mode_source могут
    // быть null (режим неизвестен) - это валидное, а не "ещё не резолвленное"
    // значение, и оно так и останется null у этого матча навсегда.
    const { isRanked, modeSource } = await resolveIsRanked(params.streamUserId);
    const gameMode: StreamGameMode = isRanked === true ? "ranked" : "unranked";

    try {
        await pool.query(
            `INSERT INTO stream_matches
               (stream_user_id, match_id, match_key, stream_session_id, hero_id, player_team,
                kills, deaths, assists, inventory, state, confidence, is_ranked, mode_source, game_mode, started_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'in_progress', 'uncertain', $11, $12, $13, $14)
             ON CONFLICT (stream_user_id, match_key) DO NOTHING`,
            [
                params.streamUserId,
                params.matchId,
                matchKey,
                session.id,
                params.heroId,
                params.teamName,
                params.kills,
                params.deaths,
                params.assists,
                JSON.stringify(params.inventory),
                isRanked,
                modeSource,
                gameMode,
                params.startedAt,
            ]
        );
        logger.info("Stream match started", { streamUserId: params.streamUserId, heroId: params.heroId });
    } catch (error) {
        // idx_stream_matches_one_active_per_user / idx_stream_matches_user_external_match -
        // гонка между двумя тиками (или конкурирующий процесс) уже создала
        // активную строку раньше нас - следующий тик подхватит её как
        // активную через findActiveMatch, здесь достаточно не упасть.
        if (!isUniqueViolation(error)) throw error;
        logger.info("Stream match creation race - existing active row wins", {
            streamUserId: params.streamUserId,
        });
    }
};

// Единственная точка, где реально узнаём ranked/unranked конкретного матча.
// Источник - только текущая настройка аккаунта (stream_users.game_mode) -
// GSI Dota 2 не сообщает тип лобби без доступа к Steam Game Coordinator
// (сознательно не подключаем, см. задачу), поэтому это ЕДИНСТВЕННЫЙ
// доступный сигнал. Критично: при любой невозможности его прочитать
// (ошибка запроса, неожиданное значение) возвращаем null, а НЕ "ranked" по
// умолчанию - молчаливое "неизвестно = ranked" именно то, что задача
// прямо запрещает.
export const resolveIsRanked = async (
    streamUserId: string
): Promise<{ isRanked: boolean | null; modeSource: ModeSource }> => {
    try {
        const result = await pool.query<{ game_mode: string | null }>(
            "SELECT game_mode FROM stream_users WHERE id = $1",
            [streamUserId]
        );
        const gameMode = result.rows[0]?.game_mode ?? null;
        if (gameMode === "ranked") return { isRanked: true, modeSource: "account_setting" };
        if (gameMode === "unranked") return { isRanked: false, modeSource: "account_setting" };
        return { isRanked: null, modeSource: null };
    } catch (error) {
        logger.error("Stream match mode resolution failed", {
            streamUserId,
            message: error instanceof Error ? error.message : String(error),
        });
        return { isRanked: null, modeSource: null };
    }
};

// Атомарная, идемпотентная финализация - единственное место, которое имеет
// право изменить wins/losses/rating сессии. "WHERE finalized_at IS NULL"
// плюс "SELECT ... FOR UPDATE" на саму строку матча гарантируют, что при
// двух конкурентных вызовах (например, повторный POST_GAME-тик и его же
// повторная обработка после рестарта) агрегаты меняются ровно один раз -
// вторая попытка видит already-finalized и не делает ничего.
export const finalizeMatch = async (
    matchRowId: number,
    reason: string,
    confidence: "confirmed" | "probable" = "confirmed"
): Promise<boolean> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const matchLock = await client.query<{
            id: number;
            stream_user_id: number;
            stream_session_id: number | null;
            hero_id: number;
            result: MatchResult | null;
            state: MatchState;
            is_ranked: boolean | null;
            mode_source: ModeSource;
        }>(
            `SELECT id, stream_user_id, stream_session_id, hero_id, result, state, is_ranked, mode_source
             FROM stream_matches WHERE id = $1 FOR UPDATE`,
            [matchRowId]
        );
        const match = matchLock.rows[0];
        // Уже финализирован (повторный тик/повторный вызов) или результат
        // ещё не подтверждён - идемпотентный no-op без побочных эффектов.
        if (!match || match.state === "finalized" || match.result === null) {
            await client.query("ROLLBACK");
            return false;
        }

        let session: { id: number; rating: number | null } | null = null;
        if (match.stream_session_id !== null) {
            const sessionResult = await client.query<{ id: number; rating: number | null }>(
                `SELECT id, rating FROM stream_sessions WHERE id = $1 FOR UPDATE`,
                [match.stream_session_id]
            );
            session = sessionResult.rows[0] ?? null;
        }

        // is_ranked/mode_source НЕ пересчитываются здесь - они зафиксированы
        // ОДИН РАЗ при createMatch (в момент старта матча) и уже лежат на
        // строке. Повторное чтение stream_users.game_mode на финализации
        // позволило бы переключению тумблера ВО ВРЕМЯ уже идущего матча
        // задним числом поменять его исход (см. задачу, п.2) - поэтому
        // здесь просто переносим уже сохранённое значение как есть.
        const isRanked = match.is_ranked;
        const modeSource = match.mode_source;

        // Unranked ИЛИ неизвестный режим: rating_* остаются null, wins/losses
        // всё равно считаются ниже (см. задачу: "Unranked сохраняет W/L").
        const ratingBefore = isRanked === true ? session?.rating ?? null : null;
        const ratingDelta =
            isRanked === true
                ? match.result === "win"
                    ? RATING_DEFAULT_STEP
                    : -RATING_DEFAULT_STEP
                : null;
        const ratingAfter =
            isRanked === true && ratingBefore !== null ? ratingBefore + (ratingDelta as number) : null;

        const updated = await client.query<{ id: number }>(
            `UPDATE stream_matches
             SET state = 'finalized', ended_at = CURRENT_TIMESTAMP, finalized_at = CURRENT_TIMESTAMP,
                 finalize_reason = $2, confidence = $3, is_ranked = $4, mode_source = $5,
                 rating_before = $6, rating_delta = $7, rating_after = $8,
                 rating_source = $9, game_mode = $10
             WHERE id = $1 AND finalized_at IS NULL
             RETURNING id`,
            [
                matchRowId,
                reason,
                confidence,
                isRanked,
                modeSource,
                ratingBefore,
                ratingDelta,
                ratingAfter,
                isRanked === true ? "default" : null,
                isRanked === true ? "ranked" : "unranked",
            ]
        );

        if (updated.rows.length === 0) {
            await client.query("ROLLBACK");
            return false;
        }

        if (session) {
            const winInc = match.result === "win" ? 1 : 0;
            const lossInc = match.result === "win" ? 0 : 1;
            // last_hero_id фиксируется здесь, В МОМЕНТ финализации - никогда
            // из промежуточных draft-наблюдений (см. задачу: "не обновляй
            // last_hero_id из provisional draft-пика"). match.hero_id на
            // этой строке уже содержит последнее валидное наблюдение (см.
            // resumeMatch) - при обмене героями посреди игры это герой,
            // которым матч реально доигран, а не тот, что был выбран
            // изначально.
            await client.query(
                `UPDATE stream_sessions
                 SET wins = wins + $1, losses = losses + $2, rating = COALESCE($3, rating),
                     last_hero_id = $4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $5`,
                [winInc, lossInc, ratingAfter, match.hero_id, session.id]
            );
        }

        await client.query("COMMIT");
        logger.info("Stream match completed", {
            streamUserId: match.stream_user_id,
            matchRowId,
            result: match.result,
            isRanked,
            reason,
        });
        return true;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

interface PostGameObservation {
    result: MatchResult;
    kills: number;
    deaths: number;
    assists: number;
}

// Не финализирует по первому попавшемуся POST_GAME-тику - см. задачу:
// "GSI иногда не даёт достаточно данных". Первый тик с решённым win_team
// только переводит матч в post_game_pending (confidence: probable).
// Финализация происходит либо когда следующий тик ПОДТВЕРЖДАЕТ тот же
// результат (confidence: confirmed), либо когда игрок уходит с
// послематчевого экрана, так и не увидев противоречия (см. handleLeftMatch -
// confidence остаётся probable). Противоречащее наблюдение (другой win_team
// на следующем тике) уводит матч в needs_review, а не выбирает "любой из
// двух" результатов молча.
const markPostGame = async (
    match: ActiveMatchRow,
    observation: PostGameObservation | null
): Promise<void> => {
    if (match.state === "in_progress") {
        await pool.query(
            `UPDATE stream_matches
             SET state = 'post_game_pending', post_game_detected_at = CURRENT_TIMESTAMP,
                 result = $2, kills = COALESCE($3, kills), deaths = COALESCE($4, deaths),
                 assists = COALESCE($5, assists), outcome_source = $6,
                 confidence = $7
             WHERE id = $1 AND state = 'in_progress'`,
            [
                match.id,
                observation?.result ?? null,
                observation?.kills ?? null,
                observation?.deaths ?? null,
                observation?.assists ?? null,
                observation ? "win_team" : null,
                observation ? "probable" : "uncertain",
            ]
        );
        return;
    }

    // state === "post_game_pending"
    if (!observation) return; // win_team всё ещё не решён этим тиком - ждём

    if (match.result === null) {
        await pool.query(
            `UPDATE stream_matches
             SET result = $2, kills = $3, deaths = $4, assists = $5, outcome_source = 'win_team',
                 confidence = 'probable'
             WHERE id = $1 AND state = 'post_game_pending'`,
            [match.id, observation.result, observation.kills, observation.deaths, observation.assists]
        );
        return;
    }

    if (match.result === observation.result) {
        await finalizeMatch(match.id, "gsi_confirmed_post_game", "confirmed");
        return;
    }

    // Противоречие: два разных win_team для одного и того же матча -
    // GSI явно не даёт достаточно данных для уверенного результата.
    await markNeedsReview(match.id, "conflicting_result_observations");
};

const handleLeftMatch = async (active: ActiveMatchRow, reason: string): Promise<void> => {
    if (active.state === "post_game_pending") {
        if (active.result !== null) {
            // Единственное наблюдение (не подтверждённое вторым тиком), но
            // игрок ушёл с экрана, не дав ему противоречий - принимаем как
            // probable, а не теряем матч молча.
            await finalizeMatch(active.id, `${reason}_single_observation`, "probable");
        } else {
            await markNeedsReview(active.id, reason);
        }
        return;
    }
    if (active.state === "in_progress") {
        await markInterrupted(active.id);
    }
    // "interrupted", оставленный повторно - состояние уже отражает реальность.
};

// Разбирает один (уже санитизированный) GSI-payload от companion и ведёт
// персистентный жизненный цикл матча (см. типы MatchState выше). В отличие
// от прежней версии, здесь нет процесса-локального in-memory трекера -
// активный матч каждый раз ищется в БД (findActiveMatch), поэтому рестарт
// backend между двумя payload не теряет прогресс (см. задачу: "решение
// должно основываться на сохранённом состоянии").
export const processGsiPayloadForMatch = async (
    streamUserId: string,
    rawPayload: unknown
): Promise<void> => {
    const payload = asRecord(rawPayload);
    const map = payload ? asRecord(payload.map) : null;
    const player = payload ? asRecord(payload.player) : null;
    const hero = payload ? asRecord(payload.hero) : null;

    const gameState = map ? asString(map.game_state) : null;
    const activity = player ? asString(player.activity) : null;
    const notInMatch =
        !gameState ||
        !player ||
        !hero ||
        !IN_MATCH_STATES.has(gameState) ||
        activity !== "playing";

    try {
        if (notInMatch) {
            const active = await findActiveMatch(streamUserId);
            if (active) await handleLeftMatch(active, "left_before_completion");
            return;
        }

        const customGameName = asString(map!.customgamename);
        if (customGameName) {
            const active = await findActiveMatch(streamUserId);
            if (active) await handleLeftMatch(active, "custom_game_detected");
            logger.info("Stream match ignored: custom game", { streamUserId, customGameName });
            return;
        }

        const heroId = asNumber(hero!.id);
        const teamName = asString(player!.team_name);
        if (!heroId || heroId <= 0 || !teamName) {
            // Недостаточно данных на этом тике (герой ещё не выбран
            // окончательно) - штатное промежуточное состояние, ждём следующий.
            return;
        }

        const steamLink = await getSteamLink(streamUserId);
        const gsiSteamId = asString(player!.steamid);
        if (steamLink && gsiSteamId && gsiSteamId !== steamLink.steamId64) {
            const active = await findActiveMatch(streamUserId);
            if (active) await handleLeftMatch(active, "spectating_suspected");
            logger.info("Stream match ignored: steamid mismatch (likely spectating)", { streamUserId });
            return;
        }

        const matchIdRaw = asString(map!.matchid);
        const matchId = matchIdRaw && matchIdRaw !== "0" ? matchIdRaw : null;
        const kills = asNumber(player!.kills) ?? 0;
        const deaths = asNumber(player!.deaths) ?? 0;
        const assists = asNumber(player!.assists) ?? 0;
        const inventory = extractInventory(payload!.items);

        let active = await findActiveMatch(streamUserId);

        if (active) {
            // Идентичность матча (см. задачу "герой матча меняется, а не
            // только идентичность"):
            // - если match_id известен на ОБЕИХ сторонах - сверяем только
            //   его, однозначно (совпал -> тот же матч, разный -> новый).
            //   hero_id НЕ участвует в этом сравнении вообще - герой может
            //   поменяться (обмен, ре-пик) без смены матча;
            // - иначе (match_id известен только с одной стороны или
            //   отсутствует вовсе) - hero_id тоже НЕ используется как
            //   идентичность (он изменяемое наблюдение, а не устойчивый
            //   идентификатор - см. resumeMatch). Дозапись/склейка
            //   допустима при совпадении команды и отсутствии надёжного
            //   сигнала "это новый матч":
            //   - если строка НИКОГДА не прерывалась (interrupted_at
            //     null - непрерывно наблюдаемый матч, включая обмен
            //     героями посреди драфта) - сигналы game_state вида
            //     hero-selection/strategy/pre-game не показательны сами по
            //     себе, продолжающийся драфт того же матча их естественно
            //     проходит;
            //   - если строка БЫЛА прервана - реконнект к уже идущему
            //     матчу возобновляется сразу в GAME_IN_PROGRESS/POST_GAME,
            //     эти состояния при таком реконнекте больше не повторяются,
            //     поэтому появление hero-selection/strategy/pre-game ПОСЛЕ
            //     разрыва - надёжный сигнал именно НОВОГО матча (защита от
            //     склейки не ослабляется).
            //   Разрыв не старше RECONNECT_WINDOW_MS в обоих случаях. Любое
            //   из условий не выполнено - считаем это другим матчем.
            const sameMatch =
                matchId && active.match_id
                    ? matchId === active.match_id
                    : teamName === active.player_team &&
                      isWithinReconnectWindow(active.interrupted_at) &&
                      (active.interrupted_at === null ||
                          !NEW_MATCH_SIGNAL_STATES.has(gameState));

            if (!sameMatch) {
                // Новый матч до завершения предыдущего - предыдущий нельзя
                // молча дописать или отбросить, отправляем на ручной разбор.
                await markNeedsReview(active.id, "superseded_by_new_match");
                active = null;
            } else {
                const resumed = await resumeMatch(active.id, matchId, heroId, inventory);
                if (!resumed) {
                    await markNeedsReview(active.id, "match_id_conflict");
                    active = null;
                } else {
                    active = {
                        ...active,
                        state: active.state === "interrupted" ? "in_progress" : active.state,
                        match_id: matchId ?? active.match_id,
                        hero_id: heroId,
                        interrupted_at: null,
                    };
                }
            }
        }

        if (!active) {
            if (gameState === "DOTA_GAMERULES_STATE_POST_GAME") {
                // Уже на послематчевом экране, а активной строки нет - либо
                // этот матч уже финализирован и GSI просто продолжает слать
                // тики того же экрана (иначе с каждым тиком плодились бы
                // дубли синтетического match_key, который зависит от
                // текущего времени - см. задачу "duplicate-post-game"),
                // либо старт матча был пропущен вовсе (companion запустился
                // прямо на этом экране) - в обоих случаях начинать трекать
                // здесь нечего: надёжных данных о старте матча нет.
                return;
            }
            await createMatch({
                streamUserId,
                matchId,
                heroId,
                teamName,
                kills,
                deaths,
                assists,
                inventory,
                startedAt: new Date(),
            });
            active = await findActiveMatch(streamUserId);
            if (!active) return; // гонка при создании - следующий тик подхватит
        }

        if (gameState !== "DOTA_GAMERULES_STATE_POST_GAME") return;

        const winTeam = asString(map!.win_team);
        const observation: PostGameObservation | null =
            winTeam === "radiant" || winTeam === "dire"
                ? { result: teamName === winTeam ? "win" : "loss", kills, deaths, assists }
                : null;

        await markPostGame(active, observation);
    } catch (error) {
        logger.error("Stream match detection error", {
            streamUserId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
};
