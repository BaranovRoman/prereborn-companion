import { describe, it, expect, vi, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";

// WK-148 - the five new provider methods (matches-by-hero/counts/totals/
// rankings/patch-constants), same fetch-mocking style as
// dota-match-provider-player-heroes.test.ts (WK-133).

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("getPlayerMatchesByHero", () => {
    it("parses matches, resolves win/loss from player_slot vs radiant_win, keeps nullable stat fields", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse([
                { match_id: 1, player_slot: 0, radiant_win: true, kills: 5, deaths: 2, assists: 8, gold_per_min: 500, xp_per_min: 600, last_hits: 150, hero_damage: null, tower_damage: null, hero_healing: null },
                { match_id: 2, player_slot: 130, radiant_win: true, kills: 1, deaths: 5, assists: 2 },
            ])
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await openDotaMatchProvider.getPlayerMatchesByHero(1, 2, 20);
        expect(result).toEqual({
            status: "ok",
            matches: [
                { matchId: "1", isWin: true, kills: 5, deaths: 2, assists: 8, goldPerMin: 500, xpPerMin: 600, lastHits: 150, heroDamage: null, towerDamage: null, heroHealing: null },
                { matchId: "2", isWin: false, kills: 1, deaths: 5, assists: 2, goldPerMin: null, xpPerMin: null, lastHits: null, heroDamage: null, towerDamage: null, heroHealing: null },
            ],
        });

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.get("hero_id")).toBe("2");
        expect(url.searchParams.get("limit")).toBe("20");
        expect(url.searchParams.getAll("project")).toContain("gold_per_min");
    });

    it("maps HTTP 429 to rate_limited", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
        expect(await openDotaMatchProvider.getPlayerMatchesByHero(1, 2)).toEqual({ status: "rate_limited" });
    });
});

describe("getPlayerCounts", () => {
    it("parses patch and lane_role buckets, ignoring groups the product does not use", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                jsonResponse({
                    leaver_status: { "0": { games: 1, win: 1 } },
                    patch: { "58": { games: 10, win: 6 } },
                    lane_role: { "1": { games: 4, win: 2 } },
                })
            )
        );

        const result = await openDotaMatchProvider.getPlayerCounts(1, 2);
        expect(result).toEqual({
            status: "ok",
            counts: { patch: { "58": { games: 10, win: 6 } }, laneRole: { "1": { games: 4, win: 2 } } },
        });
    });

    it("omits hero_id from the query when not provided (account-wide call)", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ patch: {}, lane_role: {} }));
        vi.stubGlobal("fetch", fetchMock);

        await openDotaMatchProvider.getPlayerCounts(1);
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.has("hero_id")).toBe(false);
    });
});

describe("getPlayerTotals", () => {
    it("maps field/n/sum entries to the camelCase totals shape and defaults missing fields to zero", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                jsonResponse([
                    { field: "kills", n: 26, sum: 359 },
                    { field: "gold_per_min", n: 26, sum: 16954 },
                    { field: "denies", n: 26, sum: 100 }, // unused field, dropped
                ])
            )
        );

        const result = await openDotaMatchProvider.getPlayerTotals(1, 2);
        expect(result).toEqual({
            status: "ok",
            totals: {
                kills: { n: 26, sum: 359 },
                deaths: { n: 0, sum: 0 },
                assists: { n: 0, sum: 0 },
                goldPerMin: { n: 26, sum: 16954 },
                xpPerMin: { n: 0, sum: 0 },
                lastHits: { n: 0, sum: 0 },
                heroDamage: { n: 0, sum: 0 },
                towerDamage: { n: 0, sum: 0 },
                heroHealing: { n: 0, sum: 0 },
            },
        });
    });
});

describe("getPlayerRankings", () => {
    it("parses hero_id/percent_rank entries", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse([{ hero_id: 66, score: 8127, percent_rank: 0.98 }]))
        );

        const result = await openDotaMatchProvider.getPlayerRankings(1);
        expect(result).toEqual({ status: "ok", rankings: [{ heroId: 66, percentRank: 0.98 }] });
    });
});

describe("getPatchConstants", () => {
    it("parses the id/name patch list", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse([{ id: 59, name: "7.40", date: "2025-12-16" }]))
        );

        const result = await openDotaMatchProvider.getPatchConstants();
        expect(result).toEqual({ status: "ok", patches: [{ id: 59, name: "7.40" }] });
    });

    it("collapses not_found into unavailable (not a meaningful status for a global constants route)", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
        expect(await openDotaMatchProvider.getPatchConstants()).toEqual({ status: "unavailable" });
    });

    it("maps HTTP 429 to rate_limited", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
        expect(await openDotaMatchProvider.getPatchConstants()).toEqual({ status: "rate_limited" });
    });
});
