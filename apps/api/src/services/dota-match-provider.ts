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

// WK-148 - одно свежее совпадение из GET /players/{id}/matches?hero_id=X.
// gold/xp/last_hits/hero_damage/tower_damage/hero_healing запрашиваются через
// project= и не требуют parsed-реплея (кроме hero_damage/tower_damage/
// hero_healing - они null, если конкретный матч не распарсен), поэтому все
// три помечены nullable уже на этом уровне.
export interface DotaHeroMatch {
    matchId: string;
    isWin: boolean;
    kills: number;
    deaths: number;
    assists: number;
    goldPerMin: number | null;
    xpPerMin: number | null;
    lastHits: number | null;
    heroDamage: number | null;
    towerDamage: number | null;
    heroHealing: number | null;
}

export type DotaHeroMatchesResult =
    | { status: "ok"; matches: DotaHeroMatch[] }
    | { status: "not_found" | "rate_limited" | "unavailable" };

export interface DotaCountBucket {
    games: number;
    win: number;
}

// GET /players/{id}/counts - без hero_id это разбивка по всему аккаунту
// (нужна для определения "текущего патча" и для оси Гибкость радара), с
// hero_id - та же структура, но только по матчам на этом герое (нужна для
// патч-блока Hero Detail и второй строки Favorite Heroes). Используем только
// patch/lane_role - остальные группы (leaver_status, game_mode, region и т.д.)
// продукту не нужны.
export interface DotaPlayerCounts {
    patch: Record<string, DotaCountBucket>;
    laneRole: Record<string, DotaCountBucket>;
}

export type DotaPlayerCountsResult =
    | { status: "ok"; counts: DotaPlayerCounts }
    | { status: "not_found" | "rate_limited" | "unavailable" };

export interface DotaStatTotal {
    // Число матчей, реально учтённых в sum - НЕ равно общему числу игр, если
    // поле требует parsed-реплея (hero_damage/tower_damage/hero_healing).
    // average = sum / n; при n === 0 показывать среднее нельзя.
    n: number;
    sum: number;
}

export interface DotaPlayerTotals {
    kills: DotaStatTotal;
    deaths: DotaStatTotal;
    assists: DotaStatTotal;
    goldPerMin: DotaStatTotal;
    xpPerMin: DotaStatTotal;
    lastHits: DotaStatTotal;
    heroDamage: DotaStatTotal;
    towerDamage: DotaStatTotal;
    heroHealing: DotaStatTotal;
}

export type DotaPlayerTotalsResult =
    | { status: "ok"; totals: DotaPlayerTotals }
    | { status: "not_found" | "rate_limited" | "unavailable" };

// GET /players/{id}/rankings - один запрос на ВСЕ герои сразу, как и
// getPlayerHeroes. Порог выборки для percent_rank не документирован и
// нестабилен (odota/core#729) - отсутствие героя в списке не ошибка, а
// нормальное "недостаточно данных для рейтинга".
export interface DotaHeroRanking {
    heroId: number;
    percentRank: number;
}

export type DotaPlayerRankingsResult =
    | { status: "ok"; rankings: DotaHeroRanking[] }
    | { status: "not_found" | "rate_limited" | "unavailable" };

// GET /constants/patch - НЕ привязан к account_id, это глобальный список
// патчей Dota. Кэшируется отдельно (opendota-patch-constants-service.ts) на
// весь бэкенд, а не на пользователя.
export interface DotaPatchConstant {
    id: number;
    name: string;
}

export type DotaPatchConstantsResult =
    | { status: "ok"; patches: DotaPatchConstant[] }
    | { status: "rate_limited" | "unavailable" };

export interface DotaMatchProvider {
    getRecentMatches(accountId: number): Promise<DotaMatchProviderResult>;
    getPlayerProfile(accountId: number): Promise<DotaPlayerProfileResult>;
    // Один запрос отдаёт статистику по ВСЕМ героям сразу - вызывающий код
    // (кэш + контроллер) должен запрашивать это один раз и выбирать нужного
    // героя на своей стороне, а не дёргать OpenDota на каждый клик по герою
    // в Hero Detail (см. задачи секция 20 "cache/request behavior").
    getPlayerHeroes(accountId: number): Promise<DotaPlayerHeroesResult>;
    // WK-148 - последние matches по конкретному герою (recent form). limit по
    // умолчанию 20, но параметризован - вызывающий код не должен
    // предполагать фиксированное число, если у игрока меньше матчей.
    getPlayerMatchesByHero(
        accountId: number,
        heroId: number,
        limit?: number
    ): Promise<DotaHeroMatchesResult>;
    getPlayerCounts(accountId: number, heroId?: number): Promise<DotaPlayerCountsResult>;
    getPlayerTotals(accountId: number, heroId?: number): Promise<DotaPlayerTotalsResult>;
    getPlayerRankings(accountId: number): Promise<DotaPlayerRankingsResult>;
    getPatchConstants(): Promise<DotaPatchConstantsResult>;
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
const resolveIsWin = (match: { player_slot: number; radiant_win: boolean }): boolean => {
    const isRadiantPlayer = match.player_slot < 128;
    return isRadiantPlayer === match.radiant_win;
};

// WK-148 - те же nullable-числовые поля, что toFiniteNumber, но null/undefined
// - валидный результат (поле не распарсено), а не повод отбросить весь матч.
const toNullableFiniteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    return toFiniteNumber(value);
};

interface OpenDotaHeroMatch {
    match_id: number;
    player_slot: number;
    radiant_win: boolean;
    kills: number;
    deaths: number;
    assists: number;
    gold_per_min?: number | null;
    xp_per_min?: number | null;
    last_hits?: number | null;
    hero_damage?: number | null;
    tower_damage?: number | null;
    hero_healing?: number | null;
}

const isOpenDotaHeroMatch = (value: unknown): value is OpenDotaHeroMatch => {
    if (typeof value !== "object" || value === null) return false;
    const match = value as Record<string, unknown>;
    return (
        typeof match.match_id === "number" &&
        typeof match.player_slot === "number" &&
        typeof match.radiant_win === "boolean" &&
        typeof match.kills === "number" &&
        typeof match.deaths === "number" &&
        typeof match.assists === "number"
    );
};

interface OpenDotaCountBucket {
    games: number;
    win: number;
}

const isOpenDotaCountBucket = (value: unknown): value is OpenDotaCountBucket => {
    if (typeof value !== "object" || value === null) return false;
    const bucket = value as Record<string, unknown>;
    return typeof bucket.games === "number" && typeof bucket.win === "number";
};

const parseCountGroup = (value: unknown): Record<string, DotaCountBucket> => {
    if (typeof value !== "object" || value === null) return {};
    const out: Record<string, DotaCountBucket> = {};
    for (const [key, bucket] of Object.entries(value as Record<string, unknown>)) {
        if (isOpenDotaCountBucket(bucket)) {
            out[key] = { games: bucket.games, win: bucket.win };
        }
    }
    return out;
};

interface OpenDotaTotalEntry {
    field: string;
    n: number;
    sum: number;
}

const isOpenDotaTotalEntry = (value: unknown): value is OpenDotaTotalEntry => {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.field === "string" &&
        typeof entry.n === "number" &&
        typeof entry.sum === "number"
    );
};

const EMPTY_TOTAL: DotaStatTotal = { n: 0, sum: 0 };

// Ключи ровно как в /totals ("field") -> наши camelCase поля. Остальные
// поля ответа (denies, stuns, pings, purchase_* и т.д.) продукту не нужны и
// сознательно не прокидываются (та же логика, что у DotaPlayerHeroStats).
const TOTALS_FIELD_MAP: Record<string, keyof DotaPlayerTotals> = {
    kills: "kills",
    deaths: "deaths",
    assists: "assists",
    gold_per_min: "goldPerMin",
    xp_per_min: "xpPerMin",
    last_hits: "lastHits",
    hero_damage: "heroDamage",
    tower_damage: "towerDamage",
    hero_healing: "heroHealing",
};

const parseOpenDotaTotals = (value: unknown): DotaPlayerTotals => {
    const totals: DotaPlayerTotals = {
        kills: { ...EMPTY_TOTAL },
        deaths: { ...EMPTY_TOTAL },
        assists: { ...EMPTY_TOTAL },
        goldPerMin: { ...EMPTY_TOTAL },
        xpPerMin: { ...EMPTY_TOTAL },
        lastHits: { ...EMPTY_TOTAL },
        heroDamage: { ...EMPTY_TOTAL },
        towerDamage: { ...EMPTY_TOTAL },
        heroHealing: { ...EMPTY_TOTAL },
    };
    if (!Array.isArray(value)) return totals;
    for (const entry of value) {
        if (!isOpenDotaTotalEntry(entry)) continue;
        const key = TOTALS_FIELD_MAP[entry.field];
        if (key) totals[key] = { n: entry.n, sum: entry.sum };
    }
    return totals;
};

interface OpenDotaRanking {
    hero_id: number;
    percent_rank: number;
}

const isOpenDotaRanking = (value: unknown): value is OpenDotaRanking => {
    if (typeof value !== "object" || value === null) return false;
    const ranking = value as Record<string, unknown>;
    return typeof ranking.hero_id === "number" && typeof ranking.percent_rank === "number";
};

interface OpenDotaPatchConstant {
    id: number;
    name: string;
}

const isOpenDotaPatchConstant = (value: unknown): value is OpenDotaPatchConstant => {
    if (typeof value !== "object" || value === null) return false;
    const patch = value as Record<string, unknown>;
    return typeof patch.id === "number" && typeof patch.name === "string";
};

type OpenDotaFetchResult =
    | { status: "ok"; data: unknown }
    | { status: "not_found" | "rate_limited" | "unavailable" };

// WK-148 - общий helper для новых точечных эндпоинтов (matches-by-hero,
// counts, totals, rankings, constants/patch): тот же timeout/response-cap/
// 404-429 контракт, что и у трёх исходных методов выше, но без дублирования
// boilerplate на каждый из пяти новых методов. Старые три метода намеренно не
// переведены на этот helper - не трогаем стабильный код без необходимости.
const fetchOpenDota = async (
    path: string,
    searchParams?: Record<string, string | string[]>
): Promise<OpenDotaFetchResult> => {
    const url = new URL(`${OPENDOTA_BASE_URL}${path}`);
    if (env.openDotaApiKey) {
        url.searchParams.set("api_key", env.openDotaApiKey);
    }
    if (searchParams) {
        for (const [key, value] of Object.entries(searchParams)) {
            if (Array.isArray(value)) {
                for (const entry of value) url.searchParams.append(key, entry);
            } else {
                url.searchParams.set(key, value);
            }
        }
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

        try {
            return { status: "ok", data: JSON.parse(raw) };
        } catch {
            return { status: "unavailable" };
        }
    } catch {
        return { status: "unavailable" };
    } finally {
        clearTimeout(timeout);
    }
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
    async getPlayerMatchesByHero(
        accountId: number,
        heroId: number,
        limit = 20
    ): Promise<DotaHeroMatchesResult> {
        const result = await fetchOpenDota(`/players/${accountId}/matches`, {
            hero_id: String(heroId),
            limit: String(limit),
            sort: "-start_time",
            // gold_per_min/xp_per_min/last_hits/hero_damage/tower_damage/
            // hero_healing не отдаются по умолчанию - только через project=.
            project: [
                "gold_per_min",
                "xp_per_min",
                "last_hits",
                "hero_damage",
                "tower_damage",
                "hero_healing",
            ],
        });
        if (result.status !== "ok") return result;
        if (!Array.isArray(result.data)) return { status: "unavailable" };

        const matches = result.data.filter(isOpenDotaHeroMatch).map((match) => ({
            matchId: match.match_id.toString(),
            isWin: resolveIsWin(match),
            kills: match.kills,
            deaths: match.deaths,
            assists: match.assists,
            goldPerMin: toNullableFiniteNumber(match.gold_per_min),
            xpPerMin: toNullableFiniteNumber(match.xp_per_min),
            lastHits: toNullableFiniteNumber(match.last_hits),
            heroDamage: toNullableFiniteNumber(match.hero_damage),
            towerDamage: toNullableFiniteNumber(match.tower_damage),
            heroHealing: toNullableFiniteNumber(match.hero_healing),
        }));
        return { status: "ok", matches };
    },
    async getPlayerCounts(accountId: number, heroId?: number): Promise<DotaPlayerCountsResult> {
        const result = await fetchOpenDota(
            `/players/${accountId}/counts`,
            heroId !== undefined ? { hero_id: String(heroId) } : undefined
        );
        if (result.status !== "ok") return result;
        if (typeof result.data !== "object" || result.data === null) {
            return { status: "unavailable" };
        }
        const raw = result.data as Record<string, unknown>;
        return {
            status: "ok",
            counts: {
                patch: parseCountGroup(raw.patch),
                laneRole: parseCountGroup(raw.lane_role),
            },
        };
    },
    async getPlayerTotals(accountId: number, heroId?: number): Promise<DotaPlayerTotalsResult> {
        const result = await fetchOpenDota(
            `/players/${accountId}/totals`,
            heroId !== undefined ? { hero_id: String(heroId) } : undefined
        );
        if (result.status !== "ok") return result;
        return { status: "ok", totals: parseOpenDotaTotals(result.data) };
    },
    async getPlayerRankings(accountId: number): Promise<DotaPlayerRankingsResult> {
        const result = await fetchOpenDota(`/players/${accountId}/rankings`);
        if (result.status !== "ok") return result;
        if (!Array.isArray(result.data)) return { status: "unavailable" };

        const rankings = result.data.filter(isOpenDotaRanking).map((ranking) => ({
            heroId: ranking.hero_id,
            percentRank: ranking.percent_rank,
        }));
        return { status: "ok", rankings };
    },
    async getPatchConstants(): Promise<DotaPatchConstantsResult> {
        const result = await fetchOpenDota("/constants/patch");
        if (result.status === "rate_limited") return { status: "rate_limited" };
        // /constants/patch не привязан к аккаунту - "not_found" здесь не
        // осмысленный статус, схлопываем в unavailable вместе с ним.
        if (result.status !== "ok") return { status: "unavailable" };
        if (!Array.isArray(result.data)) return { status: "unavailable" };

        const patches = result.data
            .filter(isOpenDotaPatchConstant)
            .map((patch) => ({ id: patch.id, name: patch.name }));
        return { status: "ok", patches };
    },
};
