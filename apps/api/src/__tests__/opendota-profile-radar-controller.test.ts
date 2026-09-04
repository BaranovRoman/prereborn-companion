import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// WK-148 - contract coverage for the account-wide "ПРОФИЛЬ ИГРОКА" radar
// endpoint. Formula correctness is covered directly in
// opendota-player-profile-radar.test.ts; this file only pins the
// status-contract wiring (steam link / insufficient_data / rate_limited).

const getSteamLink = vi.fn();
const getCachedPlayerHeroes = vi.fn();
const getCachedAccountTotals = vi.fn();
const getCachedAccountCounts = vi.fn();

vi.mock("../services/stream-user-service.js", () => ({ getSteamLink }));
vi.mock("../services/opendota-hero-stats-cache-service.js", () => ({ getCachedPlayerHeroes }));
vi.mock("../services/opendota-account-insights-cache-service.js", () => ({
    getCachedAccountTotals,
    getCachedAccountCounts,
    getCachedAccountRankings: vi.fn(),
    resolveCurrentPatchId: vi.fn(),
}));
vi.mock("../services/opendota-hero-insights-cache-service.js", () => ({
    getCachedHeroRecentMatches: vi.fn(),
    getCachedHeroPatchCounts: vi.fn(),
    getCachedHeroTotals: vi.fn(),
}));
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

const makeReq = (streamUserId = "user-1"): Request =>
    ({ streamUserId, requestId: "test" } as unknown as Request);

const link = { steamId64: "1", dotaAccountId: 999, connectedAt: "now" };

beforeEach(() => {
    getSteamLink.mockReset();
    getCachedPlayerHeroes.mockReset();
    getCachedAccountTotals.mockReset();
    getCachedAccountCounts.mockReset();
});

describe("getOpenDotaProfileRadarController", () => {
    it("returns steam_not_connected when there is no Steam link", async () => {
        getSteamLink.mockResolvedValue(null);
        const { getOpenDotaProfileRadarController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaProfileRadarController(makeReq(), res);

        expect(res.json).toHaveBeenCalledWith({ status: "steam_not_connected" });
        expect(getCachedPlayerHeroes).not.toHaveBeenCalled();
    });

    it("returns insufficient_data below the minimum sample", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedPlayerHeroes.mockResolvedValue({ status: "ok", heroes: [{ heroId: 1, games: 5, wins: 3 }] });
        getCachedAccountTotals.mockResolvedValue({
            status: "ok",
            totals: {
                kills: { n: 5, sum: 50 }, deaths: { n: 5, sum: 25 }, assists: { n: 5, sum: 40 },
                goldPerMin: { n: 5, sum: 2500 }, xpPerMin: { n: 5, sum: 2500 }, lastHits: { n: 5, sum: 500 },
                heroDamage: { n: 0, sum: 0 }, towerDamage: { n: 0, sum: 0 }, heroHealing: { n: 0, sum: 0 },
            },
        });
        getCachedAccountCounts.mockResolvedValue({ status: "ok", counts: { patch: {}, laneRole: {} } });
        const { getOpenDotaProfileRadarController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaProfileRadarController(makeReq(), res);

        expect(res.json).toHaveBeenCalledWith({ status: "insufficient_data" });
    });

    it("returns rate_limited when heroes or totals are rate limited", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedPlayerHeroes.mockResolvedValue({ status: "rate_limited" });
        getCachedAccountTotals.mockResolvedValue({ status: "rate_limited" });
        getCachedAccountCounts.mockResolvedValue({ status: "rate_limited" });
        const { getOpenDotaProfileRadarController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaProfileRadarController(makeReq(), res);

        expect(res.json).toHaveBeenCalledWith({ status: "rate_limited" });
    });

    it("returns a populated radar once the sample is sufficient", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedPlayerHeroes.mockResolvedValue({
            status: "ok",
            heroes: Array.from({ length: 8 }, (_, i) => ({ heroId: i + 1, games: 5, wins: 2 })), // 40 games
        });
        getCachedAccountTotals.mockResolvedValue({
            status: "ok",
            totals: {
                kills: { n: 40, sum: 400 }, deaths: { n: 40, sum: 200 }, assists: { n: 40, sum: 400 },
                goldPerMin: { n: 40, sum: 20000 }, xpPerMin: { n: 40, sum: 20000 }, lastHits: { n: 40, sum: 4000 },
                heroDamage: { n: 0, sum: 0 }, towerDamage: { n: 0, sum: 0 }, heroHealing: { n: 0, sum: 0 },
            },
        });
        getCachedAccountCounts.mockResolvedValue({ status: "ok", counts: { patch: {}, laneRole: {} } });
        const { getOpenDotaProfileRadarController } = await import("../controllers/stream/opendota.js");

        const res = makeRes();
        await getOpenDotaProfileRadarController(makeReq(), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ status: "ok", source: "opendota" })
        );
        const body = (res as unknown as { body: Record<string, unknown> }).body;
        expect(body.combat).not.toBeNull();
        expect(body.farm).not.toBeNull();
        expect(body.flexibility).not.toBeNull();
    });
});
