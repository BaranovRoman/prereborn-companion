import crypto from "crypto";
import { pool } from "../db/client.js";

// Живёт ровно на время OpenID-хождения пользователя до Steam и обратно -
// 10 минут с большим запасом на то, что человек будет разглядывать страницу
// логина Steam.
const STATE_TTL_MS = 10 * 60 * 1000;

// Создаётся только когда пользователь уже авторизован (эндпоинт защищён
// authenticateStreamUser) - именно это и связывает анонимный callback от
// Steam с конкретным stream_user_id, а не что-либо в самом callback.
export const createConnectState = async (
    streamUserId: string
): Promise<string> => {
    // Мимоходом подчищаем протухшие неиспользованные state - отдельный
    // cron/scheduler ради этого заводить незачем, таблица и так маленькая.
    await pool.query(
        "DELETE FROM stream_steam_connect_states WHERE expires_at < NOW()"
    );

    const state = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await pool.query(
        `INSERT INTO stream_steam_connect_states (state, stream_user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [state, streamUserId, expiresAt]
    );

    return state;
};

// DELETE ... RETURNING - тот же приём, что и rotateRefreshToken:
// одноразовость гарантирована на уровне запроса, повторный callback с тем
// же state (replay) не найдёт уже ничего.
export const consumeConnectState = async (
    state: string
): Promise<string | null> => {
    const result = await pool.query<{
        stream_user_id: number;
        expires_at: Date;
    }>(
        `DELETE FROM stream_steam_connect_states
         WHERE state = $1
         RETURNING stream_user_id, expires_at`,
        [state]
    );

    const row = result.rows[0];
    if (!row || row.expires_at.getTime() < Date.now()) return null;

    return row.stream_user_id.toString();
};
