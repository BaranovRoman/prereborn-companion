import { describe, it, expect, vi, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";

// WK-133 - getPlayerHeroes powers Hero Detail's OpenDota panel; these pin the
// exact failure matrix the task calls for (ok/malformed/429/5xx/timeout),
// mocking the global `fetch` the provider calls directly rather than hitting
// the real OpenDota API from tests.

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("openDotaMatchProvider.getPlayerHeroes", () => {
    it("parses a well-formed heroes array", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                jsonResponse([
                    { hero_id: 1, games: 10, win: 6, with_games: 0, with_win: 0 },
                    { hero_id: 2, games: 3, win: 0 },
                ])
            )
        );

        const result = await openDotaMatchProvider.getPlayerHeroes(12345);
        expect(result).toEqual({
            status: "ok",
            heroes: [
                { heroId: 1, games: 10, wins: 6 },
                { heroId: 2, games: 3, wins: 0 },
            ],
        });
    });

    it("coerces a string hero_id (observed shape in some clients) instead of dropping it", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse([{ hero_id: "1", games: 5, win: 2 }]))
        );

        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "ok", heroes: [{ heroId: 1, games: 5, wins: 2 }] });
    });

    it("drops malformed entries but keeps well-formed ones in the same response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                jsonResponse([
                    { hero_id: 1, games: 5, win: 2 },
                    { hero_id: "not-a-number", games: 5, win: 2 },
                    { games: 5, win: 2 },
                    null,
                ])
            )
        );

        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "ok", heroes: [{ heroId: 1, games: 5, wins: 2 }] });
    });

    it("returns unavailable for a non-array JSON body", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ not: "an array" })));
        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "unavailable" });
    });

    it("returns unavailable for a malformed (non-JSON) body", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "unavailable" });
    });

    it("maps HTTP 404 to not_found", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "not_found" });
    });

    it("maps HTTP 429 to rate_limited", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "rate_limited" });
    });

    it("maps HTTP 5xx to unavailable", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "unavailable" });
    });

    it("maps a network/timeout failure to unavailable", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"))
        );
        const result = await openDotaMatchProvider.getPlayerHeroes(1);
        expect(result).toEqual({ status: "unavailable" });
    });

    it("never forwards an API key in the request when none is configured", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
        vi.stubGlobal("fetch", fetchMock);
        await openDotaMatchProvider.getPlayerHeroes(1);
        const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(requestedUrl.searchParams.has("api_key")).toBe(false);
    });
});
