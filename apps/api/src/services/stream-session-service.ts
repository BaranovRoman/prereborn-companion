import { pool } from "../db/client.js";

export type SyncStatus = "ok" | "not_found" | "rate_limited" | "unavailable";

export interface StreamSession {
    id: string;
    streamUserId: string;
    rating: number | null;
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
    "id, stream_user_id, rating, wins, losses, last_hero_id, started_at, ended_at, created_at, updated_at, last_synced_at, last_sync_status";

export const toStreamSession = (row: StreamSessionRow): StreamSession => ({
    id: row.id.toString(),
    streamUserId: row.stream_user_id.toString(),
    rating: row.rating,
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

// Race-safe без явной транзакции: партиционный уникальный индекс
// idx_stream_sessions_one_active_per_user (db/migrate.ts) не даст создать
// вторую активную строку - при конфликте ON CONFLICT DO NOTHING просто не
// возвращает строку, и мы читаем уже существующую активную сессию.
export const getOrCreateActiveSession = async (
    streamUserId: string
): Promise<StreamSession> => {
    const inserted = await pool.query<StreamSessionRow>(
        `INSERT INTO stream_sessions (stream_user_id)
         VALUES ($1)
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
    return toStreamSession(existing.rows[0]);
};

export interface SessionPatch {
    rating?: number | null;
    wins?: number;
    losses?: number;
    lastHeroId?: number | null;
}

// Частичное обновление: различаем "поле не передано" (undefined, не
// трогаем) и "поле явно очищено" (null, например снять героя) через
// проверку "in patch", а не просто truthiness.
export const updateActiveSession = async (
    streamUserId: string,
    patch: SessionPatch
): Promise<StreamSession> => {
    await getOrCreateActiveSession(streamUserId);

    const values: unknown[] = [streamUserId];
    const setFragments: string[] = [];

    const addField = (column: string, value: unknown) => {
        values.push(value);
        setFragments.push(`${column} = $${values.length}`);
    };

    if ("rating" in patch) addField("rating", patch.rating);
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

// Завершает текущую активную сессию и сразу открывает новую с тем же
// rating - статистика текущего стрима (wins/losses/lastHeroId) не
// переносится. Транзакция + FOR UPDATE: конкурентный PATCH не должен
// перекрыть только что закрытую сессию новыми значениями "в никуда".
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
        const rating = current.rows[0]?.rating ?? null;

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
