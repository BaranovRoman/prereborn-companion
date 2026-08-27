import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";

export type SyncStatus = "ok" | "not_found" | "rate_limited" | "unavailable";

export interface StreamSession {
    id: string;
    streamUserId: string;
    rating: number | null;
    // WK-105 - кумулятивная сумма всех абсолютных коррекций "Текущего MMR"
    // (applyAbsoluteRatingCorrection) за время жизни ЭТОЙ строки сессии - 0,
    // если их не было. Чисто audit/transparency-поле: `rating` уже содержит
    // итоговое значение и не требует его читать, чтобы работать правильно -
    // см. комментарий у applyAbsoluteRatingCorrection.
    ratingAdjustment: number;
    wins: number;
    losses: number;
    lastHeroId: number | null;
    startedAt: string;
    endedAt: string | null;
    createdAt: string;
    updatedAt: string;
    // Заполняются services/dota-sync-service.ts - null, пока для этой
    // сессии не было ни одной попытки синка (в т.ч. если Steam не привязан).
    lastSyncedAt: string | null;
    lastSyncStatus: SyncStatus | null;
}

interface StreamSessionRow {
    id: number;
    stream_user_id: number;
    rating: number | null;
    rating_adjustment: number;
    wins: number;
    losses: number;
    last_hero_id: number | null;
    started_at: Date;
    ended_at: Date | null;
    created_at: Date;
    updated_at: Date;
    last_synced_at: Date | null;
    last_sync_status: SyncStatus | null;
}

export const SESSION_COLUMNS =
    "id, stream_user_id, rating, rating_adjustment, wins, losses, last_hero_id, started_at, ended_at, created_at, updated_at, last_synced_at, last_sync_status";

export const toStreamSession = (row: StreamSessionRow): StreamSession => ({
    id: row.id.toString(),
    streamUserId: row.stream_user_id.toString(),
    rating: row.rating,
    ratingAdjustment: row.rating_adjustment,
    wins: row.wins,
    losses: row.losses,
    lastHeroId: row.last_hero_id,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
    lastSyncStatus: row.last_sync_status,
});

// WK-53 - auto-creation is now scoped to true first-run only: a user who has
// NEVER had a stream_sessions row (WHERE NOT EXISTS below). If the user has
// history and their latest session was explicitly ended (endActiveSession),
// this returns null instead of resurrecting it - callers MUST treat null as
// "stream ended, do not create/attribute anything to a session" rather than
// falling back to some default session. A new session only ever appears via
// an explicit user action (resetActiveSession - see below).
// Race-safe without an explicit transaction: the partial unique index
// idx_stream_sessions_one_active_per_user (db/migrate.ts) still guarantees at
// most one ended_at IS NULL row per user even if two first-ever requests race
// past the WHERE NOT EXISTS check - on conflict ON CONFLICT DO NOTHING simply
// returns no row, and we fall through to reading the (now-existing) active row.
export const getOrCreateActiveSession = async (
    streamUserId: string
): Promise<StreamSession | null> => {
    const inserted = await pool.query<StreamSessionRow>(
        `INSERT INTO stream_sessions (stream_user_id)
         SELECT $1 WHERE NOT EXISTS (
             SELECT 1 FROM stream_sessions WHERE stream_user_id = $1
         )
         ON CONFLICT (stream_user_id) WHERE ended_at IS NULL DO NOTHING
         RETURNING ${SESSION_COLUMNS}`,
        [streamUserId]
    );
    if (inserted.rows[0]) return toStreamSession(inserted.rows[0]);

    const existing = await pool.query<StreamSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM stream_sessions
         WHERE stream_user_id = $1 AND ended_at IS NULL`,
        [streamUserId]
    );
    return existing.rows[0] ? toStreamSession(existing.rows[0]) : null;
};

// WK-105 - НЕ содержит `rating` больше: это отдельная операция
// (applyAbsoluteRatingCorrection ниже), а не поле среди прочих - см. задачу
// "ручное изменение текущего MMR и correction конкретного матча - ДВЕ
// РАЗНЫЕ операции". wins/losses/lastHeroId - по-прежнему простые счётчики
// без истории, которым каскадная логика не нужна.
export interface SessionPatch {
    wins?: number;
    losses?: number;
    lastHeroId?: number | null;
}

// Частичное обновление: различаем "поле не передано" (undefined, не
// трогаем) и "поле явно очищено" (null, например снять героя) через
// проверку "in patch", а не просто truthiness. Возвращает null, если
// getOrCreateActiveSession вернул null (стрим завершён) - PATCH не должен
// воскрешать завершённую сессию, вызывающий код должен трактовать это как
// "нечего менять", а не создавать новую строку неявно.
export const updateActiveSession = async (
    streamUserId: string,
    patch: SessionPatch
): Promise<StreamSession | null> => {
    const active = await getOrCreateActiveSession(streamUserId);
    if (!active) return null;

    const values: unknown[] = [streamUserId];
    const setFragments: string[] = [];

    const addField = (column: string, value: unknown) => {
        values.push(value);
        setFragments.push(`${column} = $${values.length}`);
    };

    if ("wins" in patch) addField("wins", patch.wins);
    if ("losses" in patch) addField("losses", patch.losses);
    if ("lastHeroId" in patch) addField("last_hero_id", patch.lastHeroId);

    if (setFragments.length === 0) {
        const current = await pool.query<StreamSessionRow>(
            `SELECT ${SESSION_COLUMNS} FROM stream_sessions
             WHERE stream_user_id = $1 AND ended_at IS NULL`,
            [streamUserId]
        );
        return toStreamSession(current.rows[0]);
    }

    setFragments.push("updated_at = CURRENT_TIMESTAMP");

    const result = await pool.query<StreamSessionRow>(
        `UPDATE stream_sessions SET ${setFragments.join(", ")}
         WHERE stream_user_id = $1 AND ended_at IS NULL
         RETURNING ${SESSION_COLUMNS}`,
        values
    );
    return toStreamSession(result.rows[0]);
};

export interface RatingCorrectionResult {
    session: StreamSession;
    previousRating: number | null;
    adjustmentDelta: number;
}

// WK-105 - "Установить текущий MMR": абсолютная коррекция ТОЧКИ ОТСЧЁТА, а не
// команда переписать историю матчей (см. задачу) - в отличие от старого
// поведения (patch.rating внутри updateActiveSession выше), это НЕ прямой
// перезаписывающий UPDATE. Разница `newRating - текущий rating` копится в
// rating_adjustment - кумулятивном ledger'е коррекций, не привязанных ни к
// одному матчу (см. StreamSession.ratingAdjustment). ratingBefore/ratingDelta/
// ratingAfter уже существующих строк stream_matches не трогаются вообще - эта
// функция не читает и не пишет stream_matches.
//
// diff считается только когда обе точки числовые: первичный ввод рейтинга
// (была null) или явная очистка поля (newRating === null) - не коррекция, а
// просто установка/сброс значения, поэтому adjustmentDelta = 0 в обоих
// случаях (см. задачу: "не добавляй искусственные fallback значения" - не
// выдумываем "коррекцию" там, где не было предыдущей точки для сравнения).
export const applyAbsoluteRatingCorrection = async (
    streamUserId: string,
    rating: number | null
): Promise<RatingCorrectionResult | null> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const current = await client.query<{ id: number; rating: number | null }>(
            `SELECT id, rating FROM stream_sessions
             WHERE stream_user_id = $1 AND ended_at IS NULL
             FOR UPDATE`,
            [streamUserId]
        );
        const row = current.rows[0];
        if (!row) {
            await client.query("ROLLBACK");
            return null;
        }

        const previousRating = row.rating;
        const adjustmentDelta =
            rating !== null && previousRating !== null ? rating - previousRating : 0;

        const result = await client.query<StreamSessionRow>(
            `UPDATE stream_sessions
             SET rating = $1, rating_adjustment = rating_adjustment + $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING ${SESSION_COLUMNS}`,
            [rating, adjustmentDelta, row.id]
        );

        await client.query("COMMIT");
        logger.info("Stream session rating manually set (absolute correction)", {
            streamUserId,
            previousRating,
            rating,
            adjustmentDelta,
        });
        return {
            session: toStreamSession(result.rows[0]),
            previousRating,
            adjustmentDelta,
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// "Начать новый стрим" - завершает текущую активную сессию (если она есть -
// no-op иначе, см. WK-53) и всегда открывает новую с тем же rating -
// статистика текущего стрима (wins/losses/lastHeroId) не переносится.
// Транзакция + FOR UPDATE: конкурентный PATCH не должен перекрыть только что
// закрытую сессию новыми значениями "в никуда". Работает из любого lifecycle
// state (active/ended/none) без какого-либо специального случая.
//
// Rating carry-over source (fixed post-audit, see задача "Between Matches -
// новая session без матчей"): an active row's rating wins when one exists
// (mid-stream reset - the account's rating hasn't moved since that row was
// last written, so it's already authoritative). When there is NO active row
// (starting a new stream after an explicit End - WK-53's "ended" state),
// this used to fall back to null even though the account's real last-known
// MMR is sitting in the most recently ENDED session - so every new stream
// opened this way silently lost its current MMR/medal until its first
// ranked match finalized (and, worse, if that match's `ratingBefore` came
// from a null `session.rating`, the whole stream's delta stayed null
// forever - the same root cause as the "one ranked match, no MMR delta"
// bug). Falling back to the latest session for this user (active OR ended)
// carries the account's honest last-known rating forward instead - not a
// fabricated default (задача: "не добавляй искусственные fallback
// значения"), just the same real number `getLatestSessionForUser` already
// exposes elsewhere. Still `null` for a true first-ever session, which is
// the only case where the account's rating is genuinely unknown.
export const resetActiveSession = async (
    streamUserId: string
): Promise<StreamSession> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const current = await client.query<{ rating: number | null }>(
            `SELECT rating FROM stream_sessions
             WHERE stream_user_id = $1 AND ended_at IS NULL
             FOR UPDATE`,
            [streamUserId]
        );
        let rating = current.rows[0]?.rating ?? null;
        if (current.rows.length === 0) {
            const latest = await client.query<{ rating: number | null }>(
                `SELECT rating FROM stream_sessions
                 WHERE stream_user_id = $1
                 ORDER BY started_at DESC
                 LIMIT 1`,
                [streamUserId]
            );
            rating = latest.rows[0]?.rating ?? null;
        }

        await client.query(
            `UPDATE stream_sessions
             SET ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE stream_user_id = $1 AND ended_at IS NULL`,
            [streamUserId]
        );

        const inserted = await client.query<StreamSessionRow>(
            `INSERT INTO stream_sessions (stream_user_id, rating)
             VALUES ($1, $2)
             RETURNING ${SESSION_COLUMNS}`,
            [streamUserId, rating]
        );

        await client.query("COMMIT");
        return toStreamSession(inserted.rows[0]);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Admin-support действие (WK-52): закрывает явно зависшую активную сессию
// без открытия новой (в отличие от resetActiveSession, которое сразу же
// открывает следующую - это self-service "Начать новый стрим"). Возвращает
// null, если активной сессии уже не было - вызывающий код должен трактовать
// это как "нечего завершать", а не как ошибку.
export const endActiveSession = async (
    streamUserId: string
): Promise<StreamSession | null> => {
    const result = await pool.query<StreamSessionRow>(
        `UPDATE stream_sessions
         SET ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE stream_user_id = $1 AND ended_at IS NULL
         RETURNING ${SESSION_COLUMNS}`,
        [streamUserId]
    );
    return result.rows[0] ? toStreamSession(result.rows[0]) : null;
};

// Текущая (если есть) или последняя завершённая сессия - для admin-карточки
// пользователя (WK-52), которой нужен один ряд "что сейчас/было со
// стримом", а не создание сессии как побочный эффект (в отличие от
// getOrCreateActiveSession, которым self-service эндпоинты создают строку,
// если её ещё не было).
export const getLatestSessionForUser = async (
    streamUserId: string
): Promise<StreamSession | null> => {
    const result = await pool.query<StreamSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM stream_sessions
         WHERE stream_user_id = $1
         ORDER BY started_at DESC
         LIMIT 1`,
        [streamUserId]
    );
    return result.rows[0] ? toStreamSession(result.rows[0]) : null;
};
