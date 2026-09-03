import {
    openDotaMatchProvider,
    type DotaPlayerHeroStats,
    type DotaPlayerHeroesResult,
} from "./dota-match-provider.js";

// WK-133 - GET /players/{id}/heroes отдаёт статистику по ВСЕМ героям одним
// запросом (см. dota-match-provider.ts), поэтому кэшируем весь список на
// account_id, а не по одному герою - иначе переключение героев в Hero Detail
// било бы по OpenDota на каждый клик (задача, секция 20). 10 минут - между
// "не долбить OpenDota на каждое открытие Hero Detail" и "не показывать
// стухшие данные слишком долго"; отдельная сущность от
// steam-profile-cache-service.ts (5 мин, только профиль), т.к. это разные
// данные с разной стоимостью обновления.
const HERO_STATS_TTL_MS = 10 * 60_000;

type CachedResult =
    | { status: "ok"; heroes: DotaPlayerHeroStats[] }
    | { status: "not_found" | "rate_limited" | "unavailable" };

interface CacheEntry {
    expiresAt: number;
    result: CachedResult;
}

const cache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<CachedResult>>();

// В отличие от getCachedSteamProfile (публичный оверлей, никогда не ждёт
// OpenDota), это авторизованный точечный запрос из Hero Detail - здесь можно
// и нужно дождаться реального ответа на холодном кэше, а не отдавать null.
export const getCachedPlayerHeroes = async (dotaAccountId: number): Promise<CachedResult> => {
    const cached = cache.get(dotaAccountId);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const existing = inFlight.get(dotaAccountId);
    if (existing) return existing;

    const request = openDotaMatchProvider
        .getPlayerHeroes(dotaAccountId)
        .then((result: DotaPlayerHeroesResult) => {
            // rate_limited/unavailable намеренно не кэшируются - следующий
            // запрос должен иметь шанс попасть в уже восстановившийся
            // OpenDota, а не залипнуть на TTL с временным сбоем.
            if (result.status === "ok" || result.status === "not_found") {
                cache.set(dotaAccountId, { result, expiresAt: Date.now() + HERO_STATS_TTL_MS });
            }
            return result;
        })
        .finally(() => {
            inFlight.delete(dotaAccountId);
        });

    inFlight.set(dotaAccountId, request);
    return request;
};

// Тестам нужен способ сбросить модульное состояние между кейсами.
export const __resetOpenDotaHeroStatsCacheForTests = (): void => {
    cache.clear();
    inFlight.clear();
};
