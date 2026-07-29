import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { getOrCreateActiveSession } from "./stream-session-service.js";
import { openDotaMatchProvider } from "./dota-match-provider.js";

export type SyncStatus =
    | "ok"
    | "skipped_cooldown"
    | "skipped_in_progress"
    | "steam_not_connected"
    | "not_found"
    | "rate_limited"
    | "unavailable";

export interface SyncResult {
    status: SyncStatus;
    processedMatches: number;
    winsAdded: number;
    lossesAdded: number;
    lastHeroId: number | null;
    syncedAt: string | null;
}

// Единственный (single PM2 fork instance, см. ecosystem.config.js) процесс -
// поэтому обычные in-memory Map/Set достаточны для cooldown и lock, без
// Redis/БД под это. Плата за простоту: оба сбрасываются при рестарте
// процесса (деплой) - в худшем случае это на один sync раньше положенного,
// не проблема безопасности.
const SYNC_COOLDOWN_MS = 60_000;
const inFlight = new Set<string>();
const lastAttemptAt = new Map<string, number>();

const emptyResult = (status: SyncStatus): SyncResult => ({
    status,
    processedMatches: 0,
    winsAdded: 0,
    lossesAdded: 0,
    lastHeroId: null,
    syncedAt: null,
});

// Публичный overlay (без авторизации) триггерит sync на каждый poll - этот
// cooldown ровно то, что не даёт превратить его в способ забомбить OpenDota:
// сколько бы запросов ни пришло за окно, наружу уйдёт максимум один.
export const syncRecentMatches = async (
    streamUserId: string
): Promise<SyncResult> => {
    if (inFlight.has(streamUserId)) {
        return emptyResult("skipped_in_progress");
    }

    const lastAttempt = lastAttemptAt.get(streamUserId);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < SYNC_COOLDOWN_MS) {
        return emptyResult("skipped_cooldown");
    }

    inFlight.add(streamUserId);
    lastAttemptAt.set(streamUserId, Date.now());

    try {
        return await performSync(streamUserId);
    } finally {
        inFlight.delete(streamUserId);
    }
};

const recordSyncFailure = async (
    sessionId: string,
    status: SyncStatus
): Promise<void> => {
    await pool.query(
        `UPDATE stream_sessions
         SET last_sync_status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [status, sessionId]
    );
};

const performSync = async (streamUserId: string): Promise<SyncResult> => {
    const userResult = await pool.query<{
        dota_account_id: string | null;
        steam_connected_at: Date | null;
    }>(
        "SELECT dota_account_id, steam_connected_at FROM stream_users WHERE id = $1",
        [streamUserId]
    );
    const userRow = userResult.rows[0];

    if (!userRow || userRow.dota_account_id === null || !userRow.steam_connected_at) {
        return emptyResult("steam_not_connected");
    }

    // BIGINT приходит из pg строкой - account_id всегда далеко в пределах
    // Number.MAX_SAFE_INTEGER (32-битный), конвертация безопасна.
    const dotaAccountId = Number(userRow.dota_account_id);
    const steamConnectedAt = userRow.steam_connected_at;

    const session = await getOrCreateActiveSession(streamUserId);
    const sessionStartedAt = new Date(session.startedAt);
    // Отсечка = позднее из двух: начало ТЕКУЩЕЙ сессии и момент привязки
    // Steam. Так закрывается и "не тащить старые матчи при первой привязке",
    // и "не тащить матчи из прошлой сессии после reset", и "не тащить матчи
    // до привязки, если Steam подключили посреди уже идущего стрима" - одним
    // и тем же условием, без отдельного watermark-поля.
    const cutoff =
        sessionStartedAt.getTime() > steamConnectedAt.getTime()
            ? sessionStartedAt
            : steamConnectedAt;

    const providerResult = await openDotaMatchProvider.getRecentMatches(
        dotaAccountId
    );

    if (providerResult.status !== "ok") {
        await recordSyncFailure(session.id, providerResult.status);
        logger.warn("Dota sync provider error", {
            streamUserId,
            status: providerResult.status,
        });
        return emptyResult(providerResult.status);
    }

    // OpenDota не гарантирует хронологический порядок в ответе - сортируем
    // сами перед обработкой (см. комментарий в dota-match-provider.ts).
    const candidateMatches = providerResult.matches
        .filter((match) => match.startedAt.getTime() >= cutoff.getTime())
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Лочим строку сессии - конкурентный sync (маловероятен благодаря
        // in-memory lock выше, но это ещё и defense-in-depth на случай
        // будущего multi-instance деплоя) не может создать гонку на UPDATE ниже.
        await client.query(
            "SELECT id FROM stream_sessions WHERE id = $1 FOR UPDATE",
            [session.id]
        );

        let winsAdded = 0;
        let lossesAdded = 0;
        let lastHeroId: number | null = null;
        let processedMatches = 0;

        for (const match of candidateMatches) {
            // ON CONFLICT DO NOTHING - реальная (не in-memory) гарантия от
            // повторного учёта: уникальный индекс (stream_user_id, match_id).
            const inserted = await client.query(
                `INSERT INTO stream_match_events
                   (stream_user_id, stream_session_id, match_id, hero_id, is_win, match_started_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (stream_user_id, match_id) DO NOTHING
                 RETURNING id`,
                [
                    streamUserId,
                    session.id,
                    match.matchId,
                    match.heroId,
                    match.isWin,
                    match.startedAt,
                ]
            );

            if (inserted.rows.length === 0) continue;

            processedMatches += 1;
            if (match.isWin) winsAdded += 1;
            else lossesAdded += 1;
            lastHeroId = match.heroId;
        }

        // wins/losses/rating больше НЕ обновляются здесь: с появлением
        // атомарной GSI-финализации (stream-match-service.ts:finalizeGsiMatch)
        // это стало единственным источником правды для счётчиков сессии -
        // если бы этот sync тоже прибавлял wins/losses по тому же самому
        // матчу (он рано или поздно попадёт и в OpenDota, и уже пришёл через
        // GSI), матч засчитался бы дважды. stream_match_events всё ещё
        // пишется выше - как и раньше, дедуп-журнал обработанных OpenDota-
        // матчей и источник last_hero_id, когда companion не запущен и GSI
        // ничего не прислал. winsAdded/lossesAdded остаются в возвращаемом
        // SyncResult только для логов/наблюдаемости.
        if (processedMatches > 0) {
            await client.query(
                `UPDATE stream_sessions
                 SET last_hero_id = $1,
                     last_synced_at = CURRENT_TIMESTAMP, last_sync_status = 'ok',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [lastHeroId, session.id]
            );
        } else {
            await client.query(
                `UPDATE stream_sessions
                 SET last_synced_at = CURRENT_TIMESTAMP, last_sync_status = 'ok',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [session.id]
            );
        }

        await client.query("COMMIT");

        logger.info("Dota sync completed", {
            streamUserId,
            processedMatches,
            winsAdded,
            lossesAdded,
        });

        return {
            status: "ok",
            processedMatches,
            winsAdded,
            lossesAdded,
            lastHeroId,
            syncedAt: new Date().toISOString(),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        logger.error("Dota sync transaction failed", {
            streamUserId,
            message: error instanceof Error ? error.message : String(error),
        });
        return emptyResult("unavailable");
    } finally {
        client.release();
    }
};
