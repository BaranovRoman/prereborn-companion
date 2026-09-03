import { env } from "../config/env.js";

// Внутренняя нормализованная модель - весь остальной код (dota-sync-service)
// работает только с этим, не с форматом ответа конкретного провайдера.
// Позже можно добавить STRATZ/другой источник, реализовав тот же интерфейс,
// не трогая sync-логику.
export interface DotaMatch {
    matchId: string;
    accountId: number;
    heroId: number;
    isWin: boolean;
    startedAt: Date;
}

// Точное поведение проверено эмпирически на живом api.opendota.com (2026-07-23):
// - приватный профиль и аккаунт без матчей неразличимы - оба отдают HTTP 200 [];
//   документированного способа их различить через recentMatches нет, поэтому
//   оба состояния сознательно схлопнуты в "ok" с пустым списком, а не
//   выдуманы из недокументированных полей;
// - несуществующий account_id у /players/{id} отдаёт 404 (но recentMatches
//   для него тоже просто вернёт [] - not_found здесь скорее задел на
//   будущее, чем реально наблюдаемое поведение этого конкретного эндпоинта);
// - GET /api/metadata подтверждает: freeRateLimit=60/мин, freeCallLimit=3000/день,
//   api_key не обязателен для этой нагрузки.
export type DotaMatchProviderResult =
    | { status: "ok"; matches: DotaMatch[] }
    | { status: "not_found" }
    | { status: "rate_limited" }
    | { status: "unavailable" };

export interface DotaPlayerProfile {
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
}

export type DotaPlayerProfileResult =
    | { status: "ok"; profile: DotaPlayerProfile }
    | { status: "not_found" | "rate_limited" | "unavailable" };

// WK-133 - один герой из ответа GET /players/{id}/heroes. games/win - это
// именно то, что реально нужно продукту (см. отчёт по задаче, п.12): losses
// вычисляется как games - win (в Dota у матча нет других исходов), сырые
// with_games/with_win/against_* сознательно не прокидываются дальше -
// продуктовый контракт не должен разрастаться сверх того, что реально
// используется (см. секцию 21 задачи).
export interface DotaPlayerHeroStats {
    heroId: number;
    games: number;
    wins: number;
}

export type DotaPlayerHeroesResult =
    | { status: "ok"; heroes: DotaPlayerHeroStats[] }
    | { status: "not_found" | "rate_limited" | "unavailable" };

export interface DotaMatchProvider {
    getRecentMatches(accountId: number): Promise<DotaMatchProviderResult>;
    getPlayerProfile(accountId: number): Promise<DotaPlayerProfileResult>;
    // Один запрос отдаёт статистику по ВСЕМ героям сразу - вызывающий код
    // (кэш + контроллер) должен запрашивать это один раз и выбирать нужного
    // героя на своей стороне, а не дёргать OpenDota на каждый клик по герою
    // в Hero Detail (см. задачи секция 20 "cache/request behavior").
    getPlayerHeroes(accountId: number): Promise<DotaPlayerHeroesResult>;
}

const OPENDOTA_BASE_URL = "https://api.opendota.com/api";
const REQUEST_TIMEOUT_MS = 8000;
// recentMatches отдаёt максимум ~20 записей, лёгкий JSON (десятки КБ) - кап
// с большим запасом, просто чтобы не распарсить что-то аномально огромное.
const MAX_RESPONSE_BYTES = 1_000_000;

// Поля ровно как в реальном ответе OpenDota (см. комментарий выше) -
// перечисляем только то, что реально используем.
interface OpenDotaRecentMatch {
    match_id: number;
    player_slot: number;
    radiant_win: boolean;
    hero_id: number;
    start_time: number;
}

const isOpenDotaMatch = (value: unknown): value is OpenDotaRecentMatch => {
    if (typeof value !== "object" || value === null) return false;
    const match = value as Record<string, unknown>;
    return (
        typeof match.match_id === "number" &&
        typeof match.player_slot === "number" &&
        typeof match.radiant_win === "boolean" &&
        typeof match.hero_id === "number" &&
        typeof match.start_time === "number"
    );
};

const parseOpenDotaProfile = (value: unknown): DotaPlayerProfile | null => {
    if (!value || typeof value !== "object") return null;
    const profile = (value as Record<string, unknown>).profile;
    if (!profile || typeof profile !== "object") return null;
    const data = profile as Record<string, unknown>;
    if (typeof data.personaname !== "string" || !data.personaname.trim()) {
        return null;
    }
    return {
        displayName: data.personaname.trim(),
        avatarUrl: typeof data.avatarfull === "string" ? data.avatarfull : null,
        profileUrl: typeof data.profileurl === "string" ? data.profileurl : null,
    };
};

// Ответ OpenDota на GET /players/{id}/heroes - поле hero_id наблюдалось и
// как число, и как строку в разных клиентах этого эндпоинта, поэтому
// принимаем оба варианта, а не падаем на строгой проверке типа.
interface OpenDotaPlayerHero {
    hero_id: number;
    games: number;
    win: number;
}

const toFiniteNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
};

const isOpenDotaPlayerHero = (value: unknown): value is OpenDotaPlayerHero => {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        toFiniteNumber(record.hero_id) !== null &&
        toFiniteNumber(record.games) !== null &&
        toFiniteNumber(record.win) !== null
    );
};

const parseOpenDotaPlayerHero = (value: OpenDotaPlayerHero): DotaPlayerHeroStats => ({
    heroId: toFiniteNumber(value.hero_id) as number,
    games: toFiniteNumber(value.games) as number,
    wins: toFiniteNumber(value.win) as number,
});

// player_slot < 128 - игрок на стороне Radiant (0-127), иначе Dire (128-255).
// Победа игрока = его сторона совпала с radiant_win. Задокументированное
// поведение OpenDota/Dota 2 replay-формата, не догадка.
const resolveIsWin = (match: OpenDotaRecentMatch): boolean => {
    const isRadiantPlayer = match.player_slot < 128;
    return isRadiantPlayer === match.radiant_win;
};

export const openDotaMatchProvider: DotaMatchProvider = {
    async getRecentMatches(accountId: number): Promise<DotaMatchProviderResult> {
        const url = new URL(
            `${OPENDOTA_BASE_URL}/players/${accountId}/recentMatches`
        );
        if (env.openDotaApiKey) {
            url.searchParams.set("api_key", env.openDotaApiKey);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, { signal: controller.signal });

            if (response.status === 404) return { status: "not_found" };
            if (response.status === 429) return { status: "rate_limited" };
            if (!response.ok) return { status: "unavailable" };

            const raw = await response.text();
            if (raw.length > MAX_RESPONSE_BYTES) return { status: "unavailable" };

            let data: unknown;
            try {
                data = JSON.parse(raw);
            } catch {
                return { status: "unavailable" };
            }
            if (!Array.isArray(data)) return { status: "unavailable" };

            const matches: DotaMatch[] = data
                .filter(isOpenDotaMatch)
                .map((match) => ({
                    matchId: match.match_id.toString(),
                    accountId,
                    heroId: match.hero_id,
                    isWin: resolveIsWin(match),
                    startedAt: new Date(match.start_time * 1000),
                }));

            return { status: "ok", matches };
        } catch {
            return { status: "unavailable" };
        } finally {
            clearTimeout(timeout);
        }
    },
    async getPlayerProfile(accountId: number): Promise<DotaPlayerProfileResult> {
        const url = new URL(`${OPENDOTA_BASE_URL}/players/${accountId}`);
        if (env.openDotaApiKey) {
            url.searchParams.set("api_key", env.openDotaApiKey);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (response.status === 404) return { status: "not_found" };
            if (response.status === 429) return { status: "rate_limited" };
            if (!response.ok) return { status: "unavailable" };
            const raw = await response.text();
            if (raw.length > MAX_RESPONSE_BYTES) return { status: "unavailable" };
            const profile = parseOpenDotaProfile(JSON.parse(raw) as unknown);
            return profile
                ? { status: "ok", profile }
                : { status: "not_found" };
        } catch {
            return { status: "unavailable" };
        } finally {
            clearTimeout(timeout);
        }
    },
    async getPlayerHeroes(accountId: number): Promise<DotaPlayerHeroesResult> {
        const url = new URL(`${OPENDOTA_BASE_URL}/players/${accountId}/heroes`);
        if (env.openDotaApiKey) {
            url.searchParams.set("api_key", env.openDotaApiKey);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (response.status === 404) return { status: "not_found" };
            if (response.status === 429) return { status: "rate_limited" };
            if (!response.ok) return { status: "unavailable" };

            const raw = await response.text();
            if (raw.length > MAX_RESPONSE_BYTES) return { status: "unavailable" };

            let data: unknown;
            try {
                data = JSON.parse(raw);
            } catch {
                return { status: "unavailable" };
            }
            if (!Array.isArray(data)) return { status: "unavailable" };

            const heroes = data.filter(isOpenDotaPlayerHero).map(parseOpenDotaPlayerHero);
            return { status: "ok", heroes };
        } catch {
            return { status: "unavailable" };
        } finally {
            clearTimeout(timeout);
        }
    },
};
