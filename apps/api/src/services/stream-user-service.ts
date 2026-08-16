import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/client.js";
import { env } from "../config/env.js";

// Access-токен живёт час - достаточно долго, чтобы не дёргать /refresh на
// каждый визит /stream (в этой итерации нет фонового silent-refresh), но
// достаточно коротко, чтобы утечка токена из localStorage не была вечной.
const ACCESS_TOKEN_TTL = "1h";
// Refresh-токен живёт 30 дней и ротируется при каждом использовании
// (rotateRefreshToken) - см. схему в db/migrate.ts.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type StreamGameMode = "ranked" | "unranked";

export interface StreamUser {
    id: string;
    email: string;
    publicToken: string;
    createdAt: string;
    updatedAt: string;
    // Companion token - в отличие от publicToken, сырой секрет никогда не
    // хранится и не возвращается здесь. Только метаданные, чтобы UI мог
    // показать "настроен/не настроен" и дату без повторного раскрытия значения.
    companionTokenConfigured: boolean;
    companionTokenCreatedAt: string | null;
    // Текущий режим матчей ("что применится к СЛЕДУЮЩЕМУ завершённому
    // матчу") - см. services/stream-match-service.ts. Не привязан к
    // конкретной stream_session и не сбрасывается "Начать новый стрим".
    gameMode: StreamGameMode;
    onboardingCompletedAt: string | null;
}

interface StreamUserRow {
    id: number;
    email: string;
    password_hash: string;
    public_token: string;
    created_at: Date;
    updated_at: Date;
    companion_token_hash: string | null;
    companion_token_created_at: Date | null;
    game_mode: StreamGameMode;
    onboarding_completed_at: Date | null;
}

const PUBLIC_COLUMNS =
    "id, email, public_token, created_at, updated_at, companion_token_hash, companion_token_created_at, game_mode, onboarding_completed_at";

const toStreamUser = (
    row: Omit<StreamUserRow, "password_hash">
): StreamUser => ({
    id: row.id.toString(),
    email: row.email,
    publicToken: row.public_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    companionTokenConfigured: row.companion_token_hash !== null,
    companionTokenCreatedAt: row.companion_token_created_at
        ? row.companion_token_created_at.toISOString()
        : null,
    gameMode: row.game_mode,
    onboardingCompletedAt: row.onboarding_completed_at
        ? row.onboarding_completed_at.toISOString()
        : null,
});

export const completeOnboarding = async (id: string): Promise<StreamUser | null> => {
    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `UPDATE stream_users
         SET onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING ${PUBLIC_COLUMNS}`,
        [id]
    );
    return result.rows[0] ? toStreamUser(result.rows[0]) : null;
};

// Admin-support действие (WK-52): пользователь застрял на онбординге и не
// может пройти его заново без чистого состояния. В отличие от
// completeOnboarding это безусловный сброс в NULL, а не COALESCE.
export const resetOnboarding = async (id: string): Promise<StreamUser | null> => {
    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `UPDATE stream_users
         SET onboarding_completed_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING ${PUBLIC_COLUMNS}`,
        [id]
    );
    return result.rows[0] ? toStreamUser(result.rows[0]) : null;
};

// Общий sha256 и для refresh-токенов, и для companion-токена - оба
// хранятся на сервере только как хэш, сам секрет клиенту показывается
// один раз в момент выдачи.
const hashRefreshToken = (rawToken: string): string =>
    crypto.createHash("sha256").update(rawToken).digest("hex");

const hashCompanionToken = (rawToken: string): string =>
    crypto.createHash("sha256").update(rawToken).digest("hex");

export const emailExists = async (email: string): Promise<boolean> => {
    const result = await pool.query(
        "SELECT 1 FROM stream_users WHERE email = $1",
        [email]
    );
    return result.rows.length > 0;
};

export const createStreamUser = async (
    email: string,
    password: string
): Promise<StreamUser> => {
    const passwordHash = await bcrypt.hash(password, 10);
    const publicToken = crypto.randomUUID();

    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `INSERT INTO stream_users (email, password_hash, public_token)
         VALUES ($1, $2, $3)
         RETURNING ${PUBLIC_COLUMNS}`,
        [email, passwordHash, publicToken]
    );

    return toStreamUser(result.rows[0]);
};

export const verifyStreamUserCredentials = async (
    email: string,
    password: string
): Promise<StreamUser | null> => {
    const result = await pool.query<StreamUserRow>(
        `SELECT ${PUBLIC_COLUMNS}, password_hash FROM stream_users WHERE email = $1`,
        [email]
    );

    const row = result.rows[0];
    if (!row) return null;

    const isValid = await bcrypt.compare(password, row.password_hash);
    if (!isValid) return null;

    return toStreamUser(row);
};

export const findStreamUserById = async (
    id: string
): Promise<StreamUser | null> => {
    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `SELECT ${PUBLIC_COLUMNS} FROM stream_users WHERE id = $1`,
        [id]
    );
    return result.rows[0] ? toStreamUser(result.rows[0]) : null;
};

// Только для публичного /overlay/:publicToken - намеренно не тащит email,
// чтобы контроллер не мог случайно отдать его наружу без авторизации.
export const findStreamUserIdByPublicToken = async (
    publicToken: string
): Promise<string | null> => {
    const result = await pool.query<{ id: number }>(
        "SELECT id FROM stream_users WHERE public_token = $1",
        [publicToken]
    );
    return result.rows[0] ? result.rows[0].id.toString() : null;
};

// Только текущий режим - без остальных полей пользователя. Вызывается на
// каждую финализацию GSI-матча (stream-match-service.ts), поэтому
// намеренно лёгкий запрос, а не полный findStreamUserById.
export const getStreamUserGameMode = async (
    streamUserId: string
): Promise<StreamGameMode> => {
    const result = await pool.query<{ game_mode: StreamGameMode }>(
        "SELECT game_mode FROM stream_users WHERE id = $1",
        [streamUserId]
    );
    return result.rows[0]?.game_mode ?? "ranked";
};

export const setGameMode = async (
    id: string,
    gameMode: StreamGameMode
): Promise<StreamUser | null> => {
    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `UPDATE stream_users
         SET game_mode = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING ${PUBLIC_COLUMNS}`,
        [gameMode, id]
    );
    return result.rows[0] ? toStreamUser(result.rows[0]) : null;
};

export const regeneratePublicToken = async (
    id: string
): Promise<StreamUser | null> => {
    const newToken = crypto.randomUUID();
    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `UPDATE stream_users
         SET public_token = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING ${PUBLIC_COLUMNS}`,
        [newToken, id]
    );
    return result.rows[0] ? toStreamUser(result.rows[0]) : null;
};

// Выдаёт новый companion-токен (apps/dota-companion) и возвращает его в
// открытом виде РОВНО ОДИН раз - вызывающий контроллер должен отдать его
// в ответе и никогда больше. На сервере остаётся только sha256-хэш
// (companion_token_hash) - как и с refresh-токенами, утечка БД не
// раскрывает активные секреты напрямую. Перезапись хэша - единственный
// механизм отзыва: старый токен перестаёт совпадать с новым хэшем сразу
// же, без отдельной таблицы/шага инвалидации.
export const regenerateCompanionToken = async (
    id: string
): Promise<{ user: StreamUser; token: string } | null> => {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashCompanionToken(rawToken);

    const result = await pool.query<Omit<StreamUserRow, "password_hash">>(
        `UPDATE stream_users
         SET companion_token_hash = $1, companion_token_created_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING ${PUBLIC_COLUMNS}`,
        [tokenHash, id]
    );

    const row = result.rows[0];
    if (!row) return null;
    return { user: toStreamUser(row), token: rawToken };
};

// Единственный способ определить владельца companion-токена -
// PUT /api/stream/companion/gsi-state (middleware/authenticate-companion-token.ts).
// Намеренно не тащит email/password_hash - тот же принцип, что и
// findStreamUserIdByPublicToken.
export const findStreamUserIdByCompanionToken = async (
    rawToken: string
): Promise<string | null> => {
    const tokenHash = hashCompanionToken(rawToken);
    const result = await pool.query<{ id: number }>(
        "SELECT id FROM stream_users WHERE companion_token_hash = $1",
        [tokenHash]
    );
    return result.rows[0] ? result.rows[0].id.toString() : null;
};

export const signAccessToken = (streamUserId: string): string =>
    jwt.sign({ streamUserId }, env.streamJwtSecret, {
        expiresIn: ACCESS_TOKEN_TTL,
        algorithm: "HS256",
    });

// Возвращает "сырой" токен клиенту один раз - на сервере остаётся только
// его sha256-хэш (как пароль), поэтому утечка БД не раскрывает активные
// refresh-токены напрямую.
export const issueRefreshToken = async (
    streamUserId: string
): Promise<string> => {
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashRefreshToken(rawToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await pool.query(
        `INSERT INTO stream_refresh_tokens (stream_user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [streamUserId, tokenHash, expiresAt]
    );

    return rawToken;
};

// Ротация: старый refresh-токен удаляется и заменяется новым в одной
// транзакции - повторное использование украденного/использованного токена
// невозможно, а не просто "не рекомендуется".
export const rotateRefreshToken = async (
    rawToken: string
): Promise<{ streamUserId: string; refreshToken: string } | null> => {
    const tokenHash = hashRefreshToken(rawToken);
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query<{
            stream_user_id: number;
            expires_at: Date;
        }>(
            `DELETE FROM stream_refresh_tokens
             WHERE token_hash = $1
             RETURNING stream_user_id, expires_at`,
            [tokenHash]
        );

        const row = result.rows[0];
        if (!row || row.expires_at.getTime() < Date.now()) {
            await client.query("ROLLBACK");
            return null;
        }

        const streamUserId = row.stream_user_id.toString();
        const newRawToken = crypto.randomBytes(32).toString("base64url");
        const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

        await client.query(
            `INSERT INTO stream_refresh_tokens (stream_user_id, token_hash, expires_at)
             VALUES ($1, $2, $3)`,
            [streamUserId, hashRefreshToken(newRawToken), newExpiresAt]
        );

        await client.query("COMMIT");
        return { streamUserId, refreshToken: newRawToken };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export const revokeRefreshToken = async (rawToken: string): Promise<void> => {
    await pool.query("DELETE FROM stream_refresh_tokens WHERE token_hash = $1", [
        hashRefreshToken(rawToken),
    ]);
};

export interface SteamLink {
    steamId64: string;
    dotaAccountId: number;
    connectedAt: string;
}

// Только для controllers/stream/steam.ts (статус интеграции) и
// dota-sync-service.ts - никогда не используется для публичного overlay.
export const getSteamLink = async (
    streamUserId: string
): Promise<SteamLink | null> => {
    const result = await pool.query<{
        steam_id64: string | null;
        dota_account_id: string | null;
        steam_connected_at: Date | null;
    }>(
        "SELECT steam_id64, dota_account_id, steam_connected_at FROM stream_users WHERE id = $1",
        [streamUserId]
    );
    const row = result.rows[0];
    if (!row || !row.steam_id64 || row.dota_account_id === null || !row.steam_connected_at) {
        return null;
    }
    return {
        steamId64: row.steam_id64,
        dotaAccountId: Number(row.dota_account_id),
        connectedAt: row.steam_connected_at.toISOString(),
    };
};

export class SteamAlreadyLinkedError extends Error {
    constructor() {
        super("This Steam account is already linked to another user");
        this.name = "SteamAlreadyLinkedError";
    }
}

// Постгрес-код unique_violation - используется и здесь, и в других местах,
// где ON CONFLICT неудобен (нужно отличить "уже занято" от прочих ошибок).
const isUniqueViolation = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505";

export const linkSteamAccount = async (
    streamUserId: string,
    steamId64: string,
    dotaAccountId: number
): Promise<void> => {
    try {
        await pool.query(
            `UPDATE stream_users
             SET steam_id64 = $1, dota_account_id = $2, steam_connected_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [steamId64, dotaAccountId, streamUserId]
        );
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new SteamAlreadyLinkedError();
        }
        throw error;
    }
};

// Не трогает stream_sessions/stream_match_events/public_token - см.
// требование "отвязка не должна удалять историю/OBS URL" в controllers/stream/steam.ts.
export const unlinkSteamAccount = async (streamUserId: string): Promise<void> => {
    await pool.query(
        `UPDATE stream_users
         SET steam_id64 = NULL, dota_account_id = NULL, steam_connected_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [streamUserId]
    );
};
