import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// WK-183 - the controller validates the plugin's query before any upstream
// work and turns unexpected failures into a status, not a 500.

const getPubgMatches = vi.fn();
vi.mock("../services/pubg-match-service.js", () => ({
    getPubgMatches,
    MAX_MATCHES: 10,
    PUBG_PLATFORMS: ["steam", "kakao", "psn", "xbox"],
}));
vi.mock("../utils/logger.js", () => ({
    logger: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const makeRes = () => {
    const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
    res.status = vi.fn().mockImplementation((code: number) => { res.statusCode = code; return res as Response; });
    res.json = vi.fn().mockImplementation((body: unknown) => { res.body = body; return res as Response; });
    return res as Response & { statusCode?: number; body?: unknown };
};
const makeReq = (query: Record<string, string>): Request =>
    ({ query, streamUserId: "user-1", requestId: "test" } as unknown as Request);

beforeEach(() => {
    getPubgMatches.mockReset();
});

describe("getPubgMatchesController", () => {
    it("passes a valid nickname, platform and limit through", async () => {
        getPubgMatches.mockResolvedValue({ status: "player_not_found" });
        const { getPubgMatchesController } = await import("../controllers/stream/pubg.js");
        const res = makeRes();
        await getPubgMatchesController(makeReq({ platform: "steam", player: "Pro_Player-1", limit: "5" }), res);
        expect(getPubgMatches).toHaveBeenCalledWith("steam", "Pro_Player-1", 5);
        expect(res.body).toEqual({ status: "player_not_found" });
    });

    it("rejects an unknown platform or a nickname with path/query characters", async () => {
        const { getPubgMatchesController } = await import("../controllers/stream/pubg.js");
        for (const query of <Record<string, string>[]>[
            { platform: "stadia", player: "ProPlayer" },
            { platform: "steam", player: "../players" },
            { platform: "steam", player: "a&filter=b" },
            { platform: "steam", player: "ProPlayer", limit: "50" },
        ]) {
            const res = makeRes();
            await getPubgMatchesController(makeReq(query), res);
            expect(res.statusCode).toBe(400);
        }
        expect(getPubgMatches).not.toHaveBeenCalled();
    });

    it("turns an unexpected failure into unavailable", async () => {
        getPubgMatches.mockImplementation(async () => { throw new Error("upstream exploded"); });
        const { getPubgMatchesController } = await import("../controllers/stream/pubg.js");
        const res = makeRes();
        await getPubgMatchesController(makeReq({ platform: "psn", player: "ProPlayer" }), res);
        expect(res.body).toEqual({ status: "unavailable" });
    });
});
