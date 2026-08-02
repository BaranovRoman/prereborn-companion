import { pool } from "../db/client.js";

// Companion online, если последнее состояние получено не более N секунд
// назад - используется и публичным overlay (isCompanionOnline), и потенциально
// UI /stream в будущем. Значение из задачи: "не более ~15 секунд назад".
const ONLINE_THRESHOLD_MS = 15_000;

// Ключи, которых в публичном/сохранённом payload быть не должно ни при каких
// обстоятельствах - секреты и служебная авторизационная информация. Дота
// умеет присылать блок "auth": {"token": "..."} , если он сконфигурирован в
// GSI .cfg (сейчас companion его не пишет, но поле остаётся частью
// протокола) - вычищаем рекурентно по ИМЕНИ ключа на любом уровне
// вложенности, а не только на верхнем, потому что структура GSI не
// документирована формально и может меняться. Проверка регистронезависимая
// и по паттерну (includes), а не по точному имени - defense in depth важнее
// показа поля, которое было бы полезно, но потенциально секретно.
const SECRET_KEY_PATTERN = /token|auth|password|secret|authorization/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Рекурсивно вырезает потенциально секретные поля из произвольного JSON.
// Не мутирует вход - возвращает новое значение, безопасное для сохранения
// в БД и для публичной отдачи в debug overlay.
export const sanitizeGsiPayload = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(sanitizeGsiPayload);
    }
    if (isPlainObject(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            if (SECRET_KEY_PATTERN.test(key)) continue;
            result[key] = sanitizeGsiPayload(val);
        }
        return result;
    }
    return value;
};

export interface CompanionState {
    payload: unknown;
    receivedAt: string;
    companionVersion: string | null;
}

interface CompanionStateRow {
    payload: unknown;
    received_at: Date;
    companion_version: string | null;
}

// received_at - момент, когда ЭТОТ сервер принял запрос (CURRENT_TIMESTAMP),
// а не клиентский timestamp из тела запроса. Часы companion (Windows-машина
// пользователя) могут расходиться с сервером - "давно ли видели companion"
// должно опираться на одни часы, иначе isCompanionOnline может ошибочно
// показывать online/offline из-за рассинхрона времени, а не реального
// состояния соединения.
export const upsertCompanionState = async (
    streamUserId: string,
    payload: unknown,
    companionVersion: string | null
): Promise<void> => {
    const sanitized = sanitizeGsiPayload(payload);
    await pool.query(
        `INSERT INTO stream_companion_states (stream_user_id, payload, received_at, companion_version)
         VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP, $3)
         ON CONFLICT (stream_user_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             received_at = EXCLUDED.received_at,
             companion_version = EXCLUDED.companion_version,
             updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, JSON.stringify(sanitized), companionVersion]
    );
    await touchCompanionPresence(streamUserId);
};

// Presence is independent from Dota GSI. Companion polls the command endpoint
// while it is running, including in the menu or when Dota is closed.
export const touchCompanionPresence = async (streamUserId: string): Promise<void> => {
    await pool.query(
        `UPDATE stream_users
         SET companion_last_seen_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND (companion_last_seen_at IS NULL
                OR companion_last_seen_at < CURRENT_TIMESTAMP - INTERVAL '5 seconds')`,
        [streamUserId]
    );
};

export const getCompanionLastSeenAt = async (
    streamUserId: string
): Promise<string | null> => {
    const result = await pool.query<{ companion_last_seen_at: Date | null }>(
        "SELECT companion_last_seen_at FROM stream_users WHERE id = $1",
        [streamUserId]
    );
    return result.rows[0]?.companion_last_seen_at?.toISOString() ?? null;
};

export const getCompanionState = async (
    streamUserId: string
): Promise<CompanionState | null> => {
    const result = await pool.query<CompanionStateRow>(
        `SELECT payload, received_at, companion_version
         FROM stream_companion_states WHERE stream_user_id = $1`,
        [streamUserId]
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
        // Уже был очищен в upsertCompanionState перед сохранением, но
        // прогоняем ещё раз перед отдачей наружу - дешёвая и идемпотентная
        // защита на случай, если в будущем появится другой путь записи,
        // не прошедший через upsertCompanionState.
        payload: sanitizeGsiPayload(row.payload),
        receivedAt: row.received_at.toISOString(),
        companionVersion: row.companion_version,
    };
};

export const isCompanionOnline = (receivedAt: string | null): boolean => {
    if (!receivedAt) return false;
    return Date.now() - new Date(receivedAt).getTime() <= ONLINE_THRESHOLD_MS;
};
