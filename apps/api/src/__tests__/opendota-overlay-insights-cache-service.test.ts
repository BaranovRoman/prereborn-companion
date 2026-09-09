import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";
import {
    getCachedOverlayFavoriteHeroStats,
    getCachedOverlayRadar,
    getCachedOverlayPlayerSummary,
    __resetOpenDotaOverlayInsightsCacheForTests,
} from "../services/opendota-overlay-insights-cache-service.js";
import { __resetOpenDotaHeroInsightsCacheForTests } from "../services/opendota-hero-insights-cache-service.js";
import { __resetOpenDotaAccountInsightsCacheForTests } from "../services/opendota-account-insights-cache-service.js";
import { __resetOpenDotaHeroStatsCacheForTests } from "../services/opendota-hero-stats-cache-service.js";
import { __resetOpenDotaPatchConstantsCacheForTests } from "../services/opendota-patch-constants-service.js";

// WK-148 - the public Between Matches path: cold call must return null
// immediately (never await OpenDota), a background fetch fills the cache,
// and a later call within the TTL returns the filled value - the same
// contract steam-profile-cache-service.ts guarantees for Steam profile data.

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    __resetOpenDotaOverlayInsightsCacheForTests();
    __resetOpenDotaHeroInsightsCacheForTests();
    __resetOpenDotaAccountInsightsCacheForTests();
    __resetOpenDotaHeroStatsCacheForTests();
    __resetOpenDotaPatchConstantsCacheForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("getCachedOverlayFavoriteHeroStats", () => {
    it("returns null on a cold cache without awaiting the upstream fetch", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockImplementation(
            () => new Promise(() => {}) // never resolves - would hang the test if awaited
        );

        const result = await getCachedOverlayFavoriteHeroStats(1, [10, 20]);
        expect(result).toBeNull();
    });

    it("fills in on a later call once the background fetch resolves, with both lifetime and patch lines", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 10, games: 132, wins: 71 }],
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockImplementation(async (accountId, heroId) => {
            if (heroId === undefined) {
                return { status: "ok", counts: { patch: { "60": { games: 5, win: 3 } }, laneRole: {} } };
            }
            return { status: "ok", counts: { patch: { "60": { games: 4, win: 2 } }, laneRole: {} } };
        });
        vi.spyOn(openDotaMatchProvider, "getPatchConstants").mockResolvedValue({
            status: "ok",
            patches: [{ id: 60, name: "7.41" }],
        });

        const first = await getCachedOverlayFavoriteHeroStats(1, [10]);
        expect(first).toBeNull();

        await flushMicrotasks();
        const second = await getCachedOverlayFavoriteHeroStats(1, [10]);
        expect(second).toEqual({
            patchName: "7.41",
            isLatestKnown: true,
            perHero: {
                10: {
                    lifetime: { games: 132, wins: 71, losses: 61, winRate: (71 / 132) * 100 },
                    patch: { patchId: 60, games: 4, wins: 2, losses: 2, winRate: 50 },
                },
            },
        });
    });

    it("still returns the lifetime line when patch resolution fails", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 10, games: 50, wins: 20 }],
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({ status: "unavailable" });

        await getCachedOverlayFavoriteHeroStats(1, [10]);
        await flushMicrotasks();
        const result = await getCachedOverlayFavoriteHeroStats(1, [10]);

        expect(result).toEqual({
            patchName: null,
            isLatestKnown: false,
            perHero: { 10: { lifetime: { games: 50, wins: 20, losses: 30, winRate: 40 }, patch: null } },
        });
    });

    it("returns null for an empty favorite-hero list without touching OpenDota", async () => {
        const spy = vi.spyOn(openDotaMatchProvider, "getPlayerCounts");
        const result = await getCachedOverlayFavoriteHeroStats(1, []);
        expect(result).toBeNull();
        expect(spy).not.toHaveBeenCalled();
    });

    it("keys the cache by the favorite-hero set - a different set triggers its own per-hero fetch", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({ status: "ok", heroes: [] });
        const spy = vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: { "60": { games: 1, win: 1 } }, laneRole: {} },
        });
        vi.spyOn(openDotaMatchProvider, "getPatchConstants").mockResolvedValue({ status: "ok", patches: [] });

        await getCachedOverlayFavoriteHeroStats(1, [10]);
        await flushMicrotasks();
        await getCachedOverlayFavoriteHeroStats(1, [10]);
        await getCachedOverlayFavoriteHeroStats(1, [20]);
        await flushMicrotasks();

        // account-wide counts (unfiltered) are reused across hero-sets via the
        // underlying blocking account-insights cache - only the per-hero
        // (hero_id-filtered) call differs between [10] and [20].
        const unfilteredCalls = spy.mock.calls.filter((call) => call[1] === undefined);
        expect(unfilteredCalls.length).toBe(1);
        const heroFilteredCalls = spy.mock.calls.filter((call) => call[1] !== undefined);
        expect(heroFilteredCalls.map((call) => call[1])).toEqual(expect.arrayContaining([10, 20]));
    });
});

describe("getCachedOverlayRadar", () => {
    it("returns null on a cold cache and fills in after the background fetch resolves", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({
            status: "ok",
            heroes: Array.from({ length: 8 }, (_, i) => ({ heroId: i + 1, games: 5, wins: 2 })),
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerTotals").mockResolvedValue({
            status: "ok",
            totals: {
                kills: { n: 40, sum: 400 }, deaths: { n: 40, sum: 200 }, assists: { n: 40, sum: 400 },
                goldPerMin: { n: 40, sum: 20000 }, xpPerMin: { n: 40, sum: 20000 }, lastHits: { n: 40, sum: 4000 },
                heroDamage: { n: 0, sum: 0 }, towerDamage: { n: 0, sum: 0 }, heroHealing: { n: 0, sum: 0 },
            },
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: {}, laneRole: {} },
        });

        const first = await getCachedOverlayRadar(1);
        expect(first).toBeNull();

        await flushMicrotasks();
        const second = await getCachedOverlayRadar(1);
        expect(second).not.toBeNull();
        expect(second!.insufficientSample).toBe(false);
    });

    it("caches an insufficient-sample outcome rather than retrying every poll", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 1, games: 3, wins: 1 }],
        });
        const totalsSpy = vi.spyOn(openDotaMatchProvider, "getPlayerTotals").mockResolvedValue({
            status: "ok",
            totals: {
                kills: { n: 0, sum: 0 }, deaths: { n: 0, sum: 0 }, assists: { n: 0, sum: 0 },
                goldPerMin: { n: 0, sum: 0 }, xpPerMin: { n: 0, sum: 0 }, lastHits: { n: 0, sum: 0 },
                heroDamage: { n: 0, sum: 0 }, towerDamage: { n: 0, sum: 0 }, heroHealing: { n: 0, sum: 0 },
            },
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: {}, laneRole: {} },
        });

        await getCachedOverlayRadar(1);
        await flushMicrotasks();
        await getCachedOverlayRadar(1);

        expect(totalsSpy).toHaveBeenCalledTimes(1);
    });
});

// WK-148 - player-summary rows next to Player Radar (МАТЧЕЙ/ПОСЛЕДНИЕ N/
// ОСН. РОЛЬ/ГЕРОЕВ). Same null-и-фоновая-заливка contract as
// favoriteHeroes/radar above - reuses the SAME getCachedPlayerHeroes/
// getCachedAccountCounts calls the radar already makes, plus
// getCachedAccountRecentMatches (its own cache, see opendota-account-
// insights-cache-service.ts).
describe("getCachedOverlayPlayerSummary", () => {
    it("returns null on a cold cache without awaiting the upstream fetch", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockImplementation(
            () => new Promise(() => {}) // never resolves - would hang the test if awaited
        );

        const result = await getCachedOverlayPlayerSummary(1);
        expect(result).toBeNull();
    });

    it("fills in on a later call once the background fetch resolves, with all four rows", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({
            status: "ok",
            heroes: [
                { heroId: 1, games: 100, wins: 60 },
                { heroId: 2, games: 20, wins: 5 },
            ],
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: {}, laneRole: { "1": { games: 90, win: 50 }, "2": { games: 30, win: 15 } } },
        });
        vi.spyOn(openDotaMatchProvider, "getRecentMatches").mockResolvedValue({
            status: "ok",
            matches: Array.from({ length: 20 }, (_, i) => ({
                matchId: String(i),
                accountId: 1,
                heroId: 1,
                isWin: i % 2 === 0,
                startedAt: new Date(),
            })),
        });

        const first = await getCachedOverlayPlayerSummary(1);
        expect(first).toBeNull();

        await flushMicrotasks();
        const second = await getCachedOverlayPlayerSummary(1);
        expect(second).toEqual({
            lifetime: { games: 120, wins: 65, losses: 55, winRate: (65 / 120) * 100 },
            heroesPlayed: 2,
            mainRole: { code: 1, label: "Керри", games: 90 },
            recentForm: { sample: 20, wins: 10, losses: 10, winRate: 50 },
        });
    });

    it("still returns lifetime/heroesPlayed when counts and recentMatches are unavailable", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 1, games: 10, wins: 4 }],
        });
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({ status: "unavailable" });
        vi.spyOn(openDotaMatchProvider, "getRecentMatches").mockResolvedValue({ status: "unavailable" });

        await getCachedOverlayPlayerSummary(1);
        await flushMicrotasks();
        const result = await getCachedOverlayPlayerSummary(1);

        expect(result).toEqual({
            lifetime: { games: 10, wins: 4, losses: 6, winRate: 40 },
            heroesPlayed: 1,
            mainRole: null,
            recentForm: null,
        });
    });
});
