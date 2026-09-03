import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";
import {
    getCachedPlayerHeroes,
    __resetOpenDotaHeroStatsCacheForTests,
} from "../services/opendota-hero-stats-cache-service.js";

// WK-133 - a single player-heroes response covers every hero (see
// dota-match-provider.ts's doc comment), so this cache exists specifically
// to stop Hero Detail from re-hitting OpenDota on every hero switch. These
// tests pin that contract plus the "never cache a transient failure" rule.

beforeEach(() => {
    __resetOpenDotaHeroStatsCacheForTests();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("getCachedPlayerHeroes", () => {
    it("serves a second call within the TTL from cache, without a second provider call", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerHeroes")
            .mockResolvedValue({ status: "ok", heroes: [{ heroId: 1, games: 5, wins: 3 }] });

        const first = await getCachedPlayerHeroes(42);
        const second = await getCachedPlayerHeroes(42);

        expect(first).toEqual({ status: "ok", heroes: [{ heroId: 1, games: 5, wins: 3 }] });
        expect(second).toEqual(first);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("refetches once the TTL has elapsed", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerHeroes")
            .mockResolvedValue({ status: "ok", heroes: [] });

        await getCachedPlayerHeroes(42);
        vi.advanceTimersByTime(10 * 60_000 + 1);
        await getCachedPlayerHeroes(42);

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("does not cache a rate_limited result - the next call retries the provider", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerHeroes")
            .mockResolvedValue({ status: "rate_limited" });

        await getCachedPlayerHeroes(42);
        await getCachedPlayerHeroes(42);

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("does not cache an unavailable result - the next call retries the provider", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerHeroes")
            .mockResolvedValue({ status: "unavailable" });

        await getCachedPlayerHeroes(42);
        await getCachedPlayerHeroes(42);

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("caches a not_found result (private profile/no matches are indistinguishable and stable)", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerHeroes")
            .mockResolvedValue({ status: "not_found" });

        await getCachedPlayerHeroes(42);
        await getCachedPlayerHeroes(42);

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent in-flight requests for the same account into one provider call", async () => {
        let resolveProvider!: (value: { status: "ok"; heroes: never[] }) => void;
        const spy = vi.spyOn(openDotaMatchProvider, "getPlayerHeroes").mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveProvider = resolve;
                })
        );

        const first = getCachedPlayerHeroes(42);
        const second = getCachedPlayerHeroes(42);
        resolveProvider({ status: "ok", heroes: [] });

        await Promise.all([first, second]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("keeps separate cache entries per account", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerHeroes")
            .mockImplementation(async (accountId: number) => ({
                status: "ok",
                heroes: [{ heroId: 1, games: accountId, wins: 0 }],
            }));

        const forAccount1 = await getCachedPlayerHeroes(1);
        const forAccount2 = await getCachedPlayerHeroes(2);

        expect(forAccount1).toEqual({ status: "ok", heroes: [{ heroId: 1, games: 1, wins: 0 }] });
        expect(forAccount2).toEqual({ status: "ok", heroes: [{ heroId: 1, games: 2, wins: 0 }] });
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
