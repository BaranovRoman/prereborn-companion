import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// WK-148 - contract coverage for the lightweight favorite-heroes bundle
// endpoint the Companion background poller (opendota_overlay_cache.rs) uses,
// since the local Between Matches renderer has no Tauri IPC access.

const getSteamLink = vi.fn();
const getCachedPlayerHeroes = vi.fn();
const getCachedHeroPatchCounts = vi.fn();
const resolveCurrentPatchId = vi.fn();

vi.mock("../services/stream-user-service.js", () => ({ getSteamLink }));
vi.mock("../services/opendota-hero-stats-cache-service.js", () => ({ getCachedPlayerHeroes }));
vi.mock("../services/opendota-hero-insights-cache-service.js", () => ({
    getCachedHeroPatchCounts,
    getCachedHeroRecentMatches: vi.fn(),
    getCachedHeroTotals: vi.fn(),
}));
vi.mock("../services/opendota-account-insights-cache-service.js", () => ({
    resolveCurrentPatchId,
    getCachedAccountCounts: vi.fn(),
    getCachedAccountTotals: vi.fn(),
    getCachedAccountRankings: vi.fn(),
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

const makeReq = (heroIds: string | undefined, streamUserId = "user-1"): Request =>
    ({ query: heroIds === undefined ? {} : { heroIds }, streamUserId, requestId: "test" } as unknown as Request);

const link = { steamId64: "1", dotaAccountId: 999, connectedAt: "now" };

beforeEach(() => {
    getSteamLink.mockReset();
    getCachedPlayerHeroes.mockReset();
    getCachedHeroPatchCounts.mockReset();
    resolveCurrentPatchId.mockReset();
});

describe("getOpenDotaFavoriteHeroesController", () => {
    it("rejects a missing/empty heroIds with 400 before touching any service", async () => {
        const { getOpenDotaFavoriteHeroesController } = await import("../controllers/stream/opendota.js");
        const res = makeRes();
        await getOpenDotaFavoriteHeroesController(makeReq(undefined), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(getSteamLink).not.toHaveBeenCalled();
    });

    it("rejects more than 3 heroIds (matches favoriteHeroIds .max(3))", async () => {
        const { getOpenDotaFavoriteHeroesController } = await import("../controllers/stream/opendota.js");
        const res = makeRes();
        await getOpenDotaFavoriteHeroesController(makeReq("1,2,3,4"), res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns steam_not_connected without touching OpenDota caches", async () => {
        getSteamLink.mockResolvedValue(null);
        const { getOpenDotaFavoriteHeroesController } = await import("../controllers/stream/opendota.js");
        const res = makeRes();
        await getOpenDotaFavoriteHeroesController(makeReq("1,2"), res);
        expect(res.json).toHaveBeenCalledWith({ status: "steam_not_connected" });
        expect(getCachedPlayerHeroes).not.toHaveBeenCalled();
    });

    it("returns lifetime + patch per hero, preserving the requested heroIds order", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedPlayerHeroes.mockResolvedValue({
            status: "ok",
            heroes: [
                { heroId: 2, games: 40, wins: 22 },
                { heroId: 1, games: 132, wins: 71 },
            ],
        });
        resolveCurrentPatchId.mockResolvedValue({ status: "ok", patchId: 60, patchName: "7.41" });
        getCachedHeroPatchCounts.mockImplementation(async (_accountId, heroId) => ({
            status: "ok",
            patch: { "60": { games: heroId === 1 ? 12 : 3, win: heroId === 1 ? 7 : 1 } },
        }));

        const { getOpenDotaFavoriteHeroesController } = await import("../controllers/stream/opendota.js");
        const res = makeRes();
        await getOpenDotaFavoriteHeroesController(makeReq("1,2"), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: "ok",
                patchName: "7.41",
                heroes: [
                    {
                        heroId: 1,
                        lifetime: { games: 132, wins: 71, losses: 61, winRate: (71 / 132) * 100 },
                        patch: { patchId: 60, games: 12, wins: 7, losses: 5, winRate: (7 / 12) * 100 },
                    },
                    {
                        heroId: 2,
                        lifetime: { games: 40, wins: 22, losses: 18, winRate: (22 / 40) * 100 },
                        patch: { patchId: 60, games: 3, wins: 1, losses: 2, winRate: (1 / 3) * 100 },
                    },
                ],
            })
        );
    });

    it("nulls out a hero missing from the lifetime /heroes response instead of crashing", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedPlayerHeroes.mockResolvedValue({ status: "ok", heroes: [] });
        resolveCurrentPatchId.mockResolvedValue({ status: "unavailable" });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "unavailable" });

        const { getOpenDotaFavoriteHeroesController } = await import("../controllers/stream/opendota.js");
        const res = makeRes();
        await getOpenDotaFavoriteHeroesController(makeReq("5"), res);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: "ok",
                patchName: null,
                heroes: [{ heroId: 5, lifetime: null, patch: null }],
            })
        );
    });

    it("propagates a rate_limited lifetime fetch as-is", async () => {
        getSteamLink.mockResolvedValue(link);
        getCachedPlayerHeroes.mockResolvedValue({ status: "rate_limited" });
        resolveCurrentPatchId.mockResolvedValue({ status: "rate_limited" });
        getCachedHeroPatchCounts.mockResolvedValue({ status: "rate_limited" });

        const { getOpenDotaFavoriteHeroesController } = await import("../controllers/stream/opendota.js");
        const res = makeRes();
        await getOpenDotaFavoriteHeroesController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "rate_limited" });
    });
});
