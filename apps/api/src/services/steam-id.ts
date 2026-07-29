// Единственное место, где SteamID64 превращается в Dota/Steam32
// account_id (то же самое account_id, что использует OpenDota). Централизовано
// намеренно - весь остальной код должен получать dota_account_id уже
// готовым, а не пересчитывать формулу в нескольких местах.
//
// Формула стабильна с момента появления Steam: SteamID64 = base + account_id,
// base = 76561197960265728. Считаем через BigInt - сам SteamID64 (~7.6e16)
// уже превышает Number.MAX_SAFE_INTEGER (~9e15), обычная арифметика на
// number потеряла бы точность на этом шаге, даже если результат (account_id)
// сам по себе маленький.
const STEAM_ID64_BASE = 76561197960265728n;
const MAX_ACCOUNT_ID = 0xffffffffn; // account_id - 32-битный

const STEAM_ID64_PATTERN = /^\d{17}$/;

export const isValidSteamId64 = (value: string): boolean =>
    STEAM_ID64_PATTERN.test(value);

export const steamId64ToDotaAccountId = (steamId64: string): number => {
    if (!isValidSteamId64(steamId64)) {
        throw new Error(`Invalid SteamID64 format: ${steamId64}`);
    }

    const id64 = BigInt(steamId64);
    const accountId = id64 - STEAM_ID64_BASE;

    if (accountId < 0n || accountId > MAX_ACCOUNT_ID) {
        throw new Error(`SteamID64 out of expected range: ${steamId64}`);
    }

    return Number(accountId);
};
