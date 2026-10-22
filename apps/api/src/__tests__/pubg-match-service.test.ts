import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// WK-183 - PUBG proxy: JSON:API parsing, per-player projection, caching of
// immutable matches, the shared player-call budget and the 1 s Companion
// transport budget. fetch is stubbed - no real PUBG API traffic.

const env = vi.hoisted(() => ({ pubgApiKey: "unit-pubg-key" as string | null }));
vi.mock("../config/env.js", () => ({ env }));

import {
    __resetPubgCachesForTests,
    getPubgMatches,
    mapDisplayName,
    playerRef,
    parseMatch,
    parsePlayer,
} from "../services/pubg-match-service.js";

const ACCOUNT = "account.0123456789abcdef";
const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

const playerBody = (matchIds = ids) => ({
    data: [{ type: "player", id: ACCOUNT, attributes: { name: "ProPlayer", shardId: "steam" },
        relationships: { matches: { data: matchIds.map((id) => ({ type: "match", id })) } } }],
});
const matchBody = (index: number) => ({
    data: { type: "match", id: ids[index], attributes: {
        createdAt: new Date(Date.UTC(2026, 9, 20, 20, 0) - index * 3_600_000).toISOString(),
        duration: 1800 + index, mapName: index % 2 ? "Desert_Main" : "Baltic_Main", gameMode: "squad-fpp" } },
    included: [
        { type: "participant", id: "p1", attributes: { stats: { playerId: ACCOUNT, name: "ProPlayer", winPlace: index + 1, kills: index, damageDealt: 100.6 + index } } },
        { type: "participant", id: "p2", attributes: { stats: { playerId: "account.other", winPlace: 40, kills: 9, damageDealt: 999 } } },
        { type: "roster", id: "r1", attributes: { stats: { rank: 1 } } },
    ],
});

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/vnd.api+json" } });

type FetchStub = (url: string | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<Parameters<FetchStub>, ReturnType<FetchStub>>>;
beforeEach(() => {
    __resetPubgCachesForTests();
    env.pubgApiKey = "unit-pubg-key";
    fetchMock = vi.fn<Parameters<FetchStub>, ReturnType<FetchStub>>(async (url) => {
        const path = String(url);
        if (path.includes("/players?")) return json(200, playerBody());
        const index = ids.findIndex((id) => path.endsWith(`/matches/${id}`));
        return index >= 0 ? json(200, matchBody(index)) : json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("PUBG parsing", () => {
    it("maps internal map ids and keeps unknown ones readable", () => {
        expect(mapDisplayName("Baltic_Main")).toBe("Erangel");
        expect(mapDisplayName("Neon_Main")).toBe("Rondo");
        expect(mapDisplayName("Future_Main")).toBe("Future");
    });
    it("reads the player's account id and match ids only", () => {
        const player = parsePlayer(playerBody([ids[0], "not-a-match-id", ids[1]]));
        expect(player).toEqual({ accountId: ACCOUNT, name: "ProPlayer", matchIds: [ids[0], ids[1]] });
        expect(parsePlayer({ data: [] })).toBeNull();
        expect(parsePlayer({ data: [{ id: "x" }] })).toBeNull();
    });
    it("projects participant stats per account and rejects malformed matches", () => {
        const match = parseMatch(matchBody(2))!;
        expect(match.map).toBe("Erangel");
        expect(match.participants.get(ACCOUNT)).toEqual({ place: 3, kills: 2, damage: 103 });
        expect(parseMatch({ data: { attributes: { createdAt: "nope" } } })).toBeNull();
    });
});

describe("latency log", () => {
    it("identifies a player by a short hash, never by the nickname or the key", async () => {
        const { logger } = await import("../utils/logger.js");
        const info = vi.spyOn(logger, "info");
        await getPubgMatches("steam", "ProPlayer", 2, 1_000);
        const lines = JSON.stringify(info.mock.calls);
        expect(lines).toContain(playerRef("steam:proplayer"));
        expect(playerRef("steam:proplayer")).toMatch(/^[0-9a-f]{12}$/);
        expect(lines.toLowerCase()).not.toContain("proplayer");
        expect(lines).not.toContain("unit-pubg-key");
        expect(lines).not.toContain("api.pubg.com");
        info.mockRestore();
    });
});

describe("getPubgMatches", () => {
    it("answers not_configured without any network call when the key is missing", async () => {
        env.pubgApiKey = null;
        expect(await getPubgMatches("steam", "ProPlayer", 10)).toEqual({ status: "not_configured" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns the newest matches projected for this player, sends the key only upstream", async () => {
        const result = await getPubgMatches("steam", "ProPlayer", 3, 1_000);
        expect(result).toMatchObject({ status: "ok", complete: true, player: { name: "ProPlayer", platform: "steam" } });
        if (result.status !== "ok") throw new Error("expected ok");
        expect(result.matches.map((m) => m.id)).toEqual(ids.slice(0, 3));
        expect(result.matches[1]).toMatchObject({ map: "Miramar", place: 2, kills: 1, damage: 102, gameMode: "squad-fpp" });
        expect(JSON.stringify(result)).not.toContain("unit-pubg-key");
        expect(JSON.stringify(result)).not.toContain("account.other");
        const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer unit-pubg-key");
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("caches the player for a minute and immutable matches for good", async () => {
        await getPubgMatches("steam", "ProPlayer", 3, 1_000);
        await getPubgMatches("steam", "proplayer", 3, 1_000);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("answers within the budget with what is cached and completes on a later poll", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        fetchMock.mockImplementation(async (url: string | URL) => {
            const path = String(url);
            if (path.includes("/players?")) return json(200, playerBody());
            await gate;
            const index = ids.findIndex((id) => path.endsWith(`/matches/${id}`));
            return json(200, matchBody(index));
        });
        const first = await getPubgMatches("steam", "ProPlayer", 2, 20);
        expect(first).toMatchObject({ status: "ok", complete: false, matches: [] });
        release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        const second = await getPubgMatches("steam", "ProPlayer", 2, 20);
        expect(second).toMatchObject({ status: "ok", complete: true });
        if (second.status === "ok") expect(second.matches).toHaveLength(2);
    });

    it("reports a missing player and upstream rate limiting", async () => {
        fetchMock.mockResolvedValueOnce(json(404, {}));
        expect(await getPubgMatches("steam", "Nobody", 10, 1_000)).toEqual({ status: "player_not_found" });
        fetchMock.mockResolvedValueOnce(json(429, {}));
        expect(await getPubgMatches("xbox", "Busy", 10, 1_000)).toEqual({ status: "rate_limited" });
    });

    it("tells when a new match first showed up in the player's list (latency diagnostics)", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
            let listed = ids.slice(1, 4);
            fetchMock.mockImplementation(async (url: string | URL) => {
                const path = String(url);
                if (path.includes("/players?")) return json(200, playerBody(listed));
                const index = ids.findIndex((id) => path.endsWith(`/matches/${id}`));
                return json(200, matchBody(index));
            });
            const first = await getPubgMatches("steam", "ProPlayer", 3, 1_000);
            if (first.status !== "ok") throw new Error("expected ok");
            // The first list has no baseline: when PUBG listed these is unknown.
            expect(first.timing.playerFetchedAt).toBe("2026-10-22T10:00:00.000Z");
            expect(first.timing.matches[0]).toMatchObject({ listedAt: "2026-10-22T10:00:00.000Z", listedAfter: null });
            vi.setSystemTime(new Date("2026-10-22T10:01:30Z"));
            listed = ids.slice(0, 3);
            const second = await getPubgMatches("steam", "ProPlayer", 3, 1_000);
            if (second.status !== "ok") throw new Error("expected ok");
            expect(second.timing.matches[0]).toEqual({
                id: ids[0], listedAfter: "2026-10-22T10:00:00.000Z", listedAt: "2026-10-22T10:01:30.000Z", detailsAt: "2026-10-22T10:01:30.000Z",
            });
            // Already known matches keep their first sighting.
            expect(second.timing.matches[1]).toMatchObject({ id: ids[1], listedAt: "2026-10-22T10:00:00.000Z" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("never spends more than the shared per-minute player budget", async () => {
        for (let i = 0; i < 8; i++) await getPubgMatches("steam", `Player${i}`, 1, 1_000);
        const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/players?")).length;
        expect(before).toBe(8);
        expect(await getPubgMatches("steam", "OneMore", 1, 1_000)).toEqual({ status: "rate_limited" });
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/players?")).length).toBe(8);
    });
});
