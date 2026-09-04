import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// WK-148 - contract coverage for the additive Hero Detail enrichment endpoint
// (recentForm/patch/kda/parsed metrics/ranking), same mocking style as
// opendota-hero-stats-controller.test.ts (WK-133): mock the composed
// services, call the controller directly with hand-built req/res.

const getSteamLink = vi.fn();
const getCachedHeroRecentMatches = vi.fn();
const getCachedHeroPatchCounts = vi.fn();
const getCachedHeroTotals = vi.fn();
const getCachedAccountRankings = vi.fn();
const resolveCurrentPatchId = vi.fn();

vi.mock("../services/stream-user-service.js", () => ({ getSteamLink }));
vi.mock("../services/opendota-hero-insights-cache-service.js", () => ({
    getCachedHeroRecentMatches,
    getCachedHeroPatchCounts,
    getCachedHeroTotals,
}));
vi.mock("../services/opendota-account-insights-cache-service.js", () => ({
    getCachedAccountRankings,
    resolveCurrentPatchId,
    // getOpenDotaHeroStatsController lives in the same module and imports
    // getCachedPlayerHeroes from a different service, unaffected here.
}));
vi.mock("../services/opendota-hero-stats-cache-service.js", () => ({ getCachedPlayerHeroes: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
    logger: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const makeRes = () => {
    const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
    res.status = vi.fn().mockImplementation((code: number) => {
        res.statusCode = code;
        return res as Response;
    });
    res.json = vi.fn().mockImplementation((body: unknown) => {
        res.body = body;
        return res as Response;
    });
    return res as Response & { statusCode?: number; body?: unknown };
};

const makeReq = (heroId: string, streamUserId = "user-1"): Request =>
    ({ params: { heroId }, streamUserId, requestId: "test" } as unknown as Request);

const link = { steamId64: "1", dotaAccountId: 999, connectedAt: "now" };

beforeEach(() => {
    getSteamLink.mockReset();
    getCachedHeroRecentMatches.mockReset();
    getCachedHeroPatchCounts.mockReset();
    getCachedHeroTotals.mockReset();
    getCachedAccountRankings.mockReset();
    resolveCurrentPatchId.mockReset();
});

const emptyTotals = {
    kills: { n: 0, sum: 0 }, deaths: { n: 0, sum: 0 }, assists: { n: 0, sum: 0 },
    goldPerMin: { n: 0, sum: 0 }, xpPerMin: { n: 0, sum: 0 }, lastHits: { n: 0, sum: 0 },
    heroDamage: { n: 0, sum: 0 }, towerDamage: { n: 0, sum: 0 }, heroHealing: { n: 0, sum: 0 },
};

describe("getOpenDotaHeroInsightsController", () => {
    it("returns steam_not_connected without touching any OpenDota cache", async () => {
        getSteamLink.mockResolvedValue(null);
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "steam_not_connected" });
        expect(getCachedHeroRecentMatches).not.toHaveBeenCalled();
    });

    it("returns no_data when all three core pieces are not_found", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedHeroRecentMatches.mockResolvedValue({ status: "not_found" });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "not_found" });
        getCachedHeroTotals.mockResolvedValue({ status: "not_found" });
        resolveCurrentPatchId.mockResolvedValue({ status: "no_data" });
        getCachedAccountRankings.mockResolvedValue({ status: "not_found" });
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "no_data" });
    });

    it("returns rate_limited when every core piece is rate limited", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedHeroRecentMatches.mockResolvedValue({ status: "rate_limited" });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "rate_limited" });
        getCachedHeroTotals.mockResolvedValue({ status: "rate_limited" });
        resolveCurrentPatchId.mockResolvedValue({ status: "rate_limited" });
        getCachedAccountRankings.mockResolvedValue({ status: "rate_limited" });
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "rate_limited" });
    });

    it("degrades gracefully: totals ok but recentMatches/patch failed still yields status ok with those fields null", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedHeroRecentMatches.mockResolvedValue({ status: "unavailable" });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "unavailable" });
        getCachedHeroTotals.mockResolvedValue({
            status: "ok",
            totals: { ...emptyTotals, kills: { n: 10, sum: 50 }, assists: { n: 10, sum: 80 }, deaths: { n: 10, sum: 20 } },
        });
        resolveCurrentPatchId.mockResolvedValue({ status: "unavailable" });
        getCachedAccountRankings.mockResolvedValue({ status: "unavailable" });
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: "ok",
                recentForm: null,
                patch: null,
                kills: 5,
                deaths: 2,
                assists: 8,
                rankPercent: null,
            })
        );
    });

    it("omits the patch block when the player has no games on the resolved current patch", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedHeroRecentMatches.mockResolvedValue({ status: "ok", matches: [] });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "ok", patch: { "55": { games: 5, win: 3 } } });
        getCachedHeroTotals.mockResolvedValue({ status: "ok", totals: emptyTotals });
        resolveCurrentPatchId.mockResolvedValue({ status: "ok", patchId: 60, patchName: "7.41" });
        getCachedAccountRankings.mockResolvedValue({ status: "ok", rankings: [] });
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "ok", patch: null }));
    });

    it("includes the resolved patch block and rank percent when everything is available", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedHeroRecentMatches.mockResolvedValue({
            status: "ok",
            matches: [
                { matchId: "1", isWin: true, kills: 1, deaths: 1, assists: 1, goldPerMin: null, xpPerMin: null, lastHits: null, heroDamage: null, towerDamage: null, heroHealing: null },
            ],
        });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "ok", patch: { "60": { games: 7, win: 4 } } });
        getCachedHeroTotals.mockResolvedValue({ status: "ok", totals: emptyTotals });
        resolveCurrentPatchId.mockResolvedValue({ status: "ok", patchId: 60, patchName: "7.41", isLatestKnown: true });
        getCachedAccountRankings.mockResolvedValue({ status: "ok", rankings: [{ heroId: 1, percentRank: 0.834 }] });
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: "ok",
                recentForm: { sample: 1, wins: 1, losses: 0, winRate: 100 },
                patch: { patchId: 60, patchName: "7.41", isLatestKnown: true, games: 7, wins: 4, losses: 3, winRate: (4 / 7) * 100 },
                rankPercent: 83.4,
            })
        );
    });

    it("marks the patch block as not-latest when the player's patch is behind OpenDota's known current patch", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedHeroRecentMatches.mockResolvedValue({ status: "ok", matches: [] });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "ok", patch: { "58": { games: 5, win: 3 } } });
        getCachedHeroTotals.mockResolvedValue({ status: "ok", totals: emptyTotals });
        resolveCurrentPatchId.mockResolvedValue({ status: "ok", patchId: 58, patchName: "7.39", isLatestKnown: false });
        getCachedAccountRankings.mockResolvedValue({ status: "ok", rankings: [] });
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                patch: expect.objectContaining({ patchName: "7.39", isLatestKnown: false }),
            })
        );
    });

    it("rejects a non-numeric heroId with 400 before touching any service", async () => {
        const { getOpenDotaHeroInsightsController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaHeroInsightsController(makeReq("nope"), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(getSteamLink).not.toHaveBeenCalled();
    });
});
