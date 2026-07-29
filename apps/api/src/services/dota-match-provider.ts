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

export interface DotaMatchProvider {
    getRecentMatches(accountId: number): Promise<DotaMatchProviderResult>;
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
};
