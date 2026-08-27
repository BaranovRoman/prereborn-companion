import { getStreamUserGameMode, type StreamGameMode } from "./stream-user-service.js";
import {
    getMatchCountForSession,
    getSessionMatchRatingDelta,
    getSessionStartRating,
} from "./stream-match-service.js";
import type { StreamSession } from "./stream-session-service.js";

// WK-53 - "итог стрима": every field here already exists on the domain model
// (session row + stream_matches) - no new denormalized/frozen-snapshot
// storage. Computed live from current DB state, not cached at End-time, so a
// match that was still in_progress when the streamer clicked "Завершить
// стрим" (and legitimately keeps the ended session's id, see
// stream-match-service.ts) is correctly reflected once it finalizes.
export interface SessionSummary {
    sessionId: string;
    wins: number;
    losses: number;
    matchCount: number;
    // Текущая (на момент запроса) настройка режима аккаунта - тот же
    // источник, что и у sessionRatingDelta в overlay/companion (см. задачу:
    // не изобретать по-матчевую агрегацию режима для сессии). Управляет тем,
    // осмысленно ли показывать ratingStart/ratingEnd/ratingDelta - для
    // unranked они всегда null, а не выдуманное значение.
    gameMode: StreamGameMode;
    ratingStart: number | null;
    ratingEnd: number | null;
    // WK-105 - только вклад матчей этой сессии (см.
    // stream-match-service.ts::getSessionMatchRatingDelta) - НЕ
    // ratingEnd - ratingStart. Абсолютная коррекция "Текущего MMR"
    // (ratingAdjustment ниже) больше не просачивается сюда, поэтому
    // ratingStart + ratingDelta может честно не совпадать с ratingEnd - это
    // ожидаемо и означает, что после последнего матча была ручная
    // коррекция.
    ratingDelta: number | null;
    // WK-105 - кумулятивная абсолютная коррекция Текущего MMR за эту сессию
    // (applyAbsoluteRatingCorrection), не привязанная ни к одному матчу - 0,
    // если её не было. См. комментарий у ratingDelta выше: ratingEnd =
    // ratingStart + ratingDelta + ratingAdjustment (когда все три известны).
    ratingAdjustment: number;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
}

export const getSessionSummary = async (
    streamUserId: string,
    session: StreamSession
): Promise<SessionSummary> => {
    const [gameMode, matchCount] = await Promise.all([
        getStreamUserGameMode(streamUserId),
        getMatchCountForSession(session.id),
    ]);

    let ratingStart: number | null = null;
    let ratingDelta: number | null = null;
    if (gameMode === "ranked") {
        ratingStart = await getSessionStartRating(session.id);
        ratingDelta =
            session.rating !== null ? (await getSessionMatchRatingDelta(session.id)) ?? 0 : null;
    }

    const endedAtMs = session.endedAt ? Date.parse(session.endedAt) : null;
    const durationMs =
        endedAtMs !== null ? endedAtMs - Date.parse(session.startedAt) : null;

    return {
        sessionId: session.id,
        wins: session.wins,
        losses: session.losses,
        matchCount,
        gameMode,
        ratingStart,
        ratingEnd: gameMode === "ranked" ? session.rating : null,
        ratingDelta,
        ratingAdjustment: session.ratingAdjustment,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs,
    };
};
