import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";
import {
    getCachedAccountCounts,
    getCachedAccountTotals,
    getCachedAccountRankings,
    resolveCurrentPatchId,
    __resetOpenDotaAccountInsightsCacheForTests,
} from "../services/opendota-account-insights-cache-service.js";
import { __resetOpenDotaPatchConstantsCacheForTests } from "../services/opendota-patch-constants-service.js";

// WK-148 - account-wide (unfiltered) caches feeding current-patch resolution
// and the player-profile radar. Same blocking/TTL contract as the hero-scoped
// caches; resolveCurrentPatchId is the "patch id from real match data, never
// calendar guessing" strategy from the task (секция 1).

beforeEach(() => {
    __resetOpenDotaAccountInsightsCacheForTests();
    __resetOpenDotaPatchConstantsCacheForTests();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("getCachedAccountCounts / getCachedAccountTotals / getCachedAccountRankings", () => {
    it("caches counts within the TTL without a second provider call", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerCounts")
            .mockResolvedValue({ status: "ok", counts: { patch: {}, laneRole: {} } });

        await getCachedAccountCounts(7);
        await getCachedAccountCounts(7);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(7);
    });

    it("keeps totals and rankings caches independent of counts", async () => {
        const countsSpy = vi
            .spyOn(openDotaMatchProvider, "getPlayerCounts")
            .mockResolvedValue({ status: "ok", counts: { patch: {}, laneRole: {} } });
        const totalsSpy = vi.spyOn(openDotaMatchProvider, "getPlayerTotals").mockResolvedValue({
            status: "ok",
            totals: {
                kills: { n: 0, sum: 0 }, deaths: { n: 0, sum: 0 }, assists: { n: 0, sum: 0 },
                goldPerMin: { n: 0, sum: 0 }, xpPerMin: { n: 0, sum: 0 }, lastHits: { n: 0, sum: 0 },
                heroDamage: { n: 0, sum: 0 }, towerDamage: { n: 0, sum: 0 }, heroHealing: { n: 0, sum: 0 },
            },
        });
        const rankingsSpy = vi
            .spyOn(openDotaMatchProvider, "getPlayerRankings")
            .mockResolvedValue({ status: "ok", rankings: [] });

        await getCachedAccountCounts(7);
        await getCachedAccountTotals(7);
        await getCachedAccountRankings(7);

        expect(countsSpy).toHaveBeenCalledTimes(1);
        expect(totalsSpy).toHaveBeenCalledTimes(1);
        expect(rankingsSpy).toHaveBeenCalledTimes(1);
    });

    it("does not cache a rate_limited counts result", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPlayerCounts")
            .mockResolvedValue({ status: "rate_limited" });

        await getCachedAccountCounts(7);
        await getCachedAccountCounts(7);

        expect(spy).toHaveBeenCalledTimes(2);
    });
});

describe("resolveCurrentPatchId", () => {
    it("picks the highest patch id with games > 0, not a calendar guess", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: {
                patch: {
                    "56": { games: 10, win: 5 },
                    "58": { games: 20, win: 12 },
                    "59": { games: 0, win: 0 }, // present but never actually played
                },
                laneRole: {},
            },
        });
        vi.spyOn(openDotaMatchProvider, "getPatchConstants").mockResolvedValue({
            status: "ok",
            patches: [
                { id: 56, name: "7.37" },
                { id: 58, name: "7.39" },
                { id: 59, name: "7.40" },
            ],
        });

        // Player's newest observed patch (58) is behind the highest patch id
        // OpenDota knows about (59) - not confirmed to be the live patch.
        const result = await resolveCurrentPatchId(1);
        expect(result).toEqual({ status: "ok", patchId: 58, patchName: "7.39", isLatestKnown: false });
    });

    it("marks isLatestKnown true when the player's newest observed patch IS the highest known patch id", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: { "58": { games: 20, win: 12 }, "59": { games: 4, win: 3 } }, laneRole: {} },
        });
        vi.spyOn(openDotaMatchProvider, "getPatchConstants").mockResolvedValue({
            status: "ok",
            patches: [
                { id: 58, name: "7.39" },
                { id: 59, name: "7.40" },
            ],
        });

        const result = await resolveCurrentPatchId(1);
        expect(result).toEqual({ status: "ok", patchId: 59, patchName: "7.40", isLatestKnown: true });
    });

    it("omits patchName rather than showing an incorrect label when the id is unmapped", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: { "999": { games: 5, win: 3 } }, laneRole: {} },
        });
        vi.spyOn(openDotaMatchProvider, "getPatchConstants").mockResolvedValue({
            status: "ok",
            patches: [{ id: 58, name: "7.39" }],
        });

        const result = await resolveCurrentPatchId(1);
        expect(result).toEqual({ status: "ok", patchId: 999, patchName: null, isLatestKnown: true });
    });

    it("returns no_data when the account has no patch-attributed games", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({
            status: "ok",
            counts: { patch: { "58": { games: 0, win: 0 } }, laneRole: {} },
        });

        const result = await resolveCurrentPatchId(1);
        expect(result).toEqual({ status: "no_data" });
    });

    it("propagates a rate_limited counts failure without touching patch constants", async () => {
        vi.spyOn(openDotaMatchProvider, "getPlayerCounts").mockResolvedValue({ status: "rate_limited" });
        const constantsSpy = vi.spyOn(openDotaMatchProvider, "getPatchConstants");

        const result = await resolveCurrentPatchId(1);
        expect(result).toEqual({ status: "rate_limited" });
        expect(constantsSpy).not.toHaveBeenCalled();
    });
});
