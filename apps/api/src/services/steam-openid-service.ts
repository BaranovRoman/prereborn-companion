import { env } from "../config/env.js";

// Steam использует OpenID 2.0 в "dumb consumer" режиме - вместо проверки
// подписи локально (сложная криптография, легко ошибиться) мы отправляем
// Steam те же параметры обратно с openid.mode=check_authentication, и Steam
// сам подтверждает/опровергает подлинность. Ровно так же работает
// passport-steam и большинство минимальных Steam-login реализаций - не
// требует дополнительной npm-зависимости (`openid`/`passport-steam`
// давно не обновлялись, тащить их ради одного POST-запроса избыточно).
const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const VERIFY_TIMEOUT_MS = 8000;
// Ответ Steam - пара строк plain text, никогда не бывает большим; кап -
// просто defensive guard от аномального/подменённого ответа.
const MAX_RESPONSE_BYTES = 8192;

export interface SteamConfigured {
    realm: string;
    returnUrl: string;
}

// Возвращает null, если STEAM_OPENID_REALM/RETURN_URL не заданы - вызывающий
// код (controllers/stream/steam.ts) сам решает, как об этом сообщить
// пользователю, здесь только конфигурация.
export const getSteamConfig = (): SteamConfigured | null => {
    if (!env.steamOpenidRealm || !env.steamOpenidReturnUrl) return null;
    return { realm: env.steamOpenidRealm, returnUrl: env.steamOpenidReturnUrl };
};

export const buildSteamAuthUrl = (config: SteamConfigured, state: string): string => {
    const params = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": `${config.returnUrl}?state=${encodeURIComponent(state)}`,
        "openid.realm": config.realm,
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    });
    return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
};

// Извлекает и валидирует SteamID64 из openid.claimed_id вида
// "https://steamcommunity.com/openid/id/<17 цифр>" - без доверия к самой
// строке до отдельной подписной проверки в verifySteamCallback.
const CLAIMED_ID_PATTERN =
    /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

// Только строковые query-параметры - Steam никогда не присылает массивы,
// вложенный ParsedQs/массив от express трактуем как заведомо невалидный
// callback, а не пытаемся угадать намерение.
export type CallbackQuery = Record<string, unknown>;

const normalizeQuery = (query: CallbackQuery): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
        if (typeof value === "string") result[key] = value;
    }
    return result;
};

export interface SteamVerifyResult {
    valid: boolean;
    steamId64?: string;
}

export const verifySteamCallback = async (
    rawQuery: CallbackQuery
): Promise<SteamVerifyResult> => {
    const query = normalizeQuery(rawQuery);

    if (query["openid.ns"] !== "http://specs.openid.net/auth/2.0") {
        return { valid: false };
    }
    if (query["openid.mode"] !== "id_res") {
        return { valid: false };
    }

    const claimedId = query["openid.claimed_id"];
    const match = claimedId ? CLAIMED_ID_PATTERN.exec(claimedId) : null;
    if (!match) return { valid: false };
    const steamId64 = match[1];

    // Пересылаем Steam ровно те openid.* поля, что он прислал - подменяем
    // только mode на check_authentication. Цель верификации всегда
    // хардкожен на STEAM_OPENID_ENDPOINT (реальный Steam), а не на что-то
    // из ответа (например openid.op_endpoint) - это и закрывает попытку
    // подсунуть поддельный "identity provider" через параметры callback.
    const verifyParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith("openid.")) verifyParams.set(key, value);
    }
    verifyParams.set("openid.mode", "check_authentication");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    try {
        const response = await fetch(STEAM_OPENID_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: verifyParams.toString(),
            signal: controller.signal,
        });

        if (!response.ok) return { valid: false };

        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) return { valid: false };

        const isValid = /is_valid\s*:\s*true/.test(text);
        return isValid ? { valid: true, steamId64 } : { valid: false };
    } catch {
        return { valid: false };
    } finally {
        clearTimeout(timeout);
    }
};
