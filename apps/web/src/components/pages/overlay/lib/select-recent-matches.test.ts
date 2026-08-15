import { describe, expect, it } from "vitest";
import type { StreamMatch } from "@/entities/stream-session/model/types";
import { selectRecentMatches } from "./select-recent-matches";

const match = (id: string): StreamMatch => ({
    id, dotaMatchId: id, heroId: 1, kills: 1, deaths: 2, assists: 3, inventory: [],
    result: "win", ratingBefore: 1000, ratingDelta: 25, ratingAfter: 1025,
    gameMode: "ranked", endedAt: new Date(0).toISOString(),
});

describe("selectRecentMatches", () => {
    it("switches scopes independently of the configured count", () => {
        const current = [match("current")];
        const recent = [match("recent")];
        const data = { matches: current, recentMatches: recent };
        expect(selectRecentMatches(data, "current-stream")).toBe(current);
        expect(selectRecentMatches(data, "recent-matches")).toBe(recent);
    });

    it("fails safely when an older payload has no account-wide history", () => {
        expect(selectRecentMatches({ matches: [match("current")] }, "recent-matches")).toEqual([]);
    });
});
