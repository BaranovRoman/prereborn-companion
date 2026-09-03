import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// WK-133 - controller-level coverage for the product contract Hero Detail
// consumes (задача, секция 28): linked/not-linked, hero present/absent,
// upstream rate_limited/unavailable, and the hard requirement that the
// response never carries the raw OpenDota payload or the API key. Mocks the
// two services the controller composes rather than hitting a real DB/network
// - dota-match-provider.ts and opendota-hero-stats-cache-service.ts already
// have their own focused unit coverage.

const getSteamLink = vi.fn();
const getCachedPlayerHeroes = vi.fn();

vi.mock("../services/stream-user-service.js", () => ({ getSteamLink }));
vi.mock("../services/opendota-hero-stats-cache-service.js", () => ({ getCachedPlayerHeroes }));
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

beforeEach(() => {
    getSteamLink.mockReset();
    getCachedPlayerHeroes.mockReset();
});

describe("getOpenDotaHeroStatsController", () => {
    it("returns steam_not_connected when the user has no Steam link", async () => {
        getSteamLink.mockResolvedValue(null);
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "steam_not_connected" });
        expect(getCachedPlayerHeroes).not.toHaveBeenCalled();
    });

    it("returns product-shaped ok stats for a linked user with hero data", async () => {
        getSteamLink.mockResolvedValue({ steamId64: "1", dotaAccountId: 999, connectedAt: "now" });
        getCachedPlayerHeroes.mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 1, games: 10, wins: 6 }],
        });
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(getCachedPlayerHeroes).toHaveBeenCalledWith(999);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: "ok",
                source: "opendota",
                heroId: 1,
                games: 10,
                wins: 6,
                losses: 4,
                winRate: 60,
            })
        );
        const body = (res as unknown as { body: Record<string, unknown> }).body;
        expect(body).not.toHaveProperty("apiKey");
        expect(body).not.toHaveProperty("api_key");
        expect(body).not.toHaveProperty("heroes");
    });

    it("returns no_data when the linked account has never played the requested hero", async () => {
        getSteamLink.mockResolvedValue({ steamId64: "1", dotaAccountId: 999, connectedAt: "now" });
        getCachedPlayerHeroes.mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 2, games: 10, wins: 6 }],
        });
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "no_data" });
    });

    it("returns no_data for a hero with zero recorded games", async () => {
        getSteamLink.mockResolvedValue({ steamId64: "1", dotaAccountId: 999, connectedAt: "now" });
        getCachedPlayerHeroes.mockResolvedValue({
            status: "ok",
            heroes: [{ heroId: 1, games: 0, wins: 0 }],
        });
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "no_data" });
    });

    it("propagates a rate_limited upstream result as-is", async () => {
        getSteamLink.mockResolvedValue({ steamId64: "1", dotaAccountId: 999, connectedAt: "now" });
        getCachedPlayerHeroes.mockResolvedValue({ status: "rate_limited" });
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "rate_limited" });
    });

    it("propagates an unavailable upstream result as-is", async () => {
        getSteamLink.mockResolvedValue({ steamId64: "1", dotaAccountId: 999, connectedAt: "now" });
        getCachedPlayerHeroes.mockResolvedValue({ status: "unavailable" });
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "unavailable" });
    });

    it("maps a not_found upstream result to no_data (private profile and no matches are indistinguishable)", async () => {
        getSteamLink.mockResolvedValue({ steamId64: "1", dotaAccountId: 999, connectedAt: "now" });
        getCachedPlayerHeroes.mockResolvedValue({ status: "not_found" });
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("1"), res);

        expect(res.json).toHaveBeenCalledWith({ status: "no_data" });
    });

    it("rejects a non-numeric heroId with 400 before touching Steam link/OpenDota", async () => {
        const { getOpenDotaHeroStatsController } = await import(
            "../controllers/stream/opendota.js"
        );

        const res = makeRes();
        await getOpenDotaHeroStatsController(makeReq("not-a-number"), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(getSteamLink).not.toHaveBeenCalled();
    });
});
