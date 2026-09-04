import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";
import {
    getCachedHeroRecentMatches,
    getCachedHeroPatchCounts,
    getCachedHeroTotals,
    __resetOpenDotaHeroInsightsCacheForTests,
} from "../services/opendota-hero-insights-cache-service.js";

// WK-148 - three independent per-(account,hero) caches (recentMatches/
// patchCounts/totals), same blocking/dedup/TTL contract as
// opendota-hero-stats-cache-service.ts (WK-133), verified once in depth for
// recentMatches and once per-key-isolation for the other two so a partial
// upstream failure on one piece doesn't force a shared cache miss on another.

beforeEach(() => {
    __resetOpenDotaHeroInsightsCacheForTests();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("getCachedHeroRecentMatches", () => {
    it("serves a second call within the TTL from cache", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerMatchesByHero")
            .mockResolvedValue({ status: "ok", matches: [] });

        await getCachedHeroRecentMatches(1, 2);
        await getCachedHeroRecentMatches(1, 2);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(1, 2, 20);
    });

    it("refetches once the TTL has elapsed", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerMatchesByHero")
            .mockResolvedValue({ status: "ok", matches: [] });

        await getCachedHeroRecentMatches(1, 2);
        vi.advanceTimersByTime(10 * 60_000 + 1);
        await getCachedHeroRecentMatches(1, 2);

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("does not cache rate_limited/unavailable - the next call retries", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerMatchesByHero")
            .mockResolvedValue({ status: "rate_limited" });

        await getCachedHeroRecentMatches(1, 2);
        await getCachedHeroRecentMatches(1, 2);

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("caches distinct entries per (accountId, heroId) pair", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerMatchesByHero")
            .mockImplementation(async (_accountId, heroId) => ({
                status: "ok",
                matches: [{ matchId: String(heroId), isWin: true, kills: 0, deaths: 0, assists: 0, goldPerMin: null, xpPerMin: null, lastHits: null, heroDamage: null, towerDamage: null, heroHealing: null }],
            }));

        await getCachedHeroRecentMatches(1, 10);
        await getCachedHeroRecentMatches(1, 11);
        await getCachedHeroRecentMatches(1, 10);

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("dedupes concurrent in-flight requests for the same (account, hero) key", async () => {
        let resolveProvider!: (value: { status: "ok"; matches: [] }) => void;
        const spy = vi.spyOn(openDotaMatchProvider, "getPlayerMatchesByHero").mockImplementation(
            () => new Promise((resolve) => { resolveProvider = resolve; })
        );

        const first = getCachedHeroRecentMatches(1, 2);
        const second = getCachedHeroRecentMatches(1, 2);
        resolveProvider({ status: "ok", matches: [] });
        await Promise.all([first, second]);

        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe("getCachedHeroPatchCounts", () => {
    it("caches per (account, hero) and does not share state with recentMatches", async () => {
        const countsSpy = vi
            .spyOn(openDotaMatchProvider, "getPlayerCounts")
            .mockResolvedValue({ status: "ok", counts: { patch: { "60": { games: 3, win: 2 } }, laneRole: {} } });
        const matchesSpy = vi
            .spyOn(openDotaMatchProvider, "getPlayerMatchesByHero")
            .mockResolvedValue({ status: "ok", matches: [] });

        await getCachedHeroPatchCounts(1, 2);
        await getCachedHeroRecentMatches(1, 2);

        expect(countsSpy).toHaveBeenCalledWith(1, 2);
        expect(matchesSpy).toHaveBeenCalledTimes(1);
    });
});

describe("getCachedHeroTotals", () => {
    it("returns the parsed totals bundle from the provider", async () => {
        const totals = {
            kills: { n: 1, sum: 1 }, deaths: { n: 1, sum: 1 }, assists: { n: 1, sum: 1 },
            goldPerMin: { n: 1, sum: 1 }, xpPerMin: { n: 1, sum: 1 }, lastHits: { n: 1, sum: 1 },
            heroDamage: { n: 1, sum: 1 }, towerDamage: { n: 1, sum: 1 }, heroHealing: { n: 1, sum: 1 },
        };
        vi.spyOn(openDotaMatchProvider, "getPlayerTotals").mockResolvedValue({ status: "ok", totals });

        const result = await getCachedHeroTotals(1, 2);
        expect(result).toEqual({ status: "ok", totals });
    });
});
