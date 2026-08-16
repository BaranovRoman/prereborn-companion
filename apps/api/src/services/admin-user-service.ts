import { pool } from "../db/client.js";
import { findStreamUserById, type StreamUser } from "./stream-user-service.js";
import { getSteamLink, type SteamLink } from "./stream-user-service.js";
import { getTwitchLinkSummary, type TwitchLinkSummary } from "./twitch-integration-service.js";
import {
    getLatestSessionForUser,
    type StreamSession,
} from "./stream-session-service.js";
import {
    getCompanionState,
    getCompanionLastSeenAt,
    isCompanionOnline,
    type CompanionState,
} from "./stream-companion-service.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// Список не бесконечен, но и не крошечный - ограничиваем длину поискового
// запроса, а не только LIMIT выдачи, чтобы ILIKE не строил бессмысленно
// длинный паттерн из вставленного пользователем текста.
const MAX_QUERY_LENGTH = 100;

export interface AdminUserSummary {
    id: string;
    email: string;
    createdAt: string;
    onboardingCompletedAt: string | null;
    steamConnected: boolean;
    twitchConnected: boolean;
    twitchDisplayName: string | null;
    companionOnline: boolean;
    companionLastSeenAt: string | null;
    activeSessionStartedAt: string | null;
}

export interface AdminUserListResult {
    users: AdminUserSummary[];
    total: number;
    page: number;
    pageSize: number;
}

interface AdminUserListRow {
    id: number;
    email: string;
    created_at: Date;
    onboarding_completed_at: Date | null;
    steam_id64: string | null;
    companion_last_seen_at: Date | null;
    twitch_display_name: string | null;
    active_session_started_at: Date | null;
    total_count: string;
}

// Экранируем спецсимволы LIKE (%, _, \), чтобы поиск по подстроке email не
// вёл себя неожиданно, если пользователь ввёл их буквально - параметризация
// уже защищает от SQL-инъекции, это только про корректность паттерна.
const escapeLikePattern = (value: string): string =>
    value.replace(/[\\%_]/g, (char) => `\\${char}`);

export const listAdminUsers = async (params: {
    page?: number;
    pageSize?: number;
    query?: string;
}): Promise<AdminUserListResult> => {
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE))
    );
    const rawQuery = (params.query ?? "").trim().slice(0, MAX_QUERY_LENGTH);
    const likePattern = rawQuery ? `%${escapeLikePattern(rawQuery)}%` : null;
    const offset = (page - 1) * pageSize;

    // Один запрос вместо LIST + COUNT (COUNT(*) OVER() в том же проходе) и
    // JOIN вместо запроса per-user - иначе список из N строк дал бы N+1 к
    // stream_twitch_links/stream_sessions на каждую загрузку страницы.
    const result = await pool.query<AdminUserListRow>(
        `SELECT
            u.id,
            u.email,
            u.created_at,
            u.onboarding_completed_at,
            u.steam_id64,
            u.companion_last_seen_at,
            t.display_name AS twitch_display_name,
            s.started_at AS active_session_started_at,
            COUNT(*) OVER() AS total_count
         FROM stream_users u
         LEFT JOIN stream_twitch_links t ON t.stream_user_id = u.id
         LEFT JOIN stream_sessions s ON s.stream_user_id = u.id AND s.ended_at IS NULL
         WHERE $1::text IS NULL OR u.email ILIKE $1 ESCAPE '\\'
         ORDER BY u.created_at DESC
         LIMIT $2 OFFSET $3`,
        [likePattern, pageSize, offset]
    );

    const users: AdminUserSummary[] = result.rows.map((row) => ({
        id: row.id.toString(),
        email: row.email,
        createdAt: row.created_at.toISOString(),
        onboardingCompletedAt: row.onboarding_completed_at
            ? row.onboarding_completed_at.toISOString()
            : null,
        steamConnected: row.steam_id64 !== null,
        twitchConnected: row.twitch_display_name !== null,
        twitchDisplayName: row.twitch_display_name,
        companionOnline: isCompanionOnline(
            row.companion_last_seen_at ? row.companion_last_seen_at.toISOString() : null
        ),
        companionLastSeenAt: row.companion_last_seen_at
            ? row.companion_last_seen_at.toISOString()
            : null,
        activeSessionStartedAt: row.active_session_started_at
            ? row.active_session_started_at.toISOString()
            : null,
    }));

    const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;

    return { users, total, page, pageSize };
};

export interface AdminUserDetail {
    user: StreamUser;
    steam: SteamLink | null;
    twitch: TwitchLinkSummary | null;
    companion: {
        online: boolean;
        lastSeenAt: string | null;
        lastGsiState: CompanionState | null;
    };
    latestSession: StreamSession | null;
}

// Несколько точечных запросов вместо одного огромного JOIN - это карточка
// ОДНОГО пользователя (не список), поэтому N+1 здесь нет: ровно один запрос
// на каждый существующий кусок state, все уже написаны и покрыты тестами в
// своих сервисах (getSteamLink и т.д.), дублировать их SQL сюда не нужно.
export const getAdminUserDetail = async (
    id: string
): Promise<AdminUserDetail | null> => {
    const user = await findStreamUserById(id);
    if (!user) return null;

    const [steam, twitch, lastSeenAt, lastGsiState, latestSession] =
        await Promise.all([
            getSteamLink(id),
            getTwitchLinkSummary(id),
            getCompanionLastSeenAt(id),
            getCompanionState(id),
            getLatestSessionForUser(id),
        ]);

    return {
        user,
        steam,
        twitch,
        companion: {
            online: isCompanionOnline(lastSeenAt),
            lastSeenAt,
            lastGsiState,
        },
        latestSession,
    };
};
