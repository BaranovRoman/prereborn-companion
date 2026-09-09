import { describe, it, expect } from "vitest";
import type { DotaCountBucket, DotaPlayerHeroStats } from "../services/dota-match-provider.js";
import {
    computeAccountLifetimeStats,
    computeHeroesPlayedCount,
    computeMainRole,
    LANE_ROLE_LABELS,
} from "../services/opendota-player-summary.js";

// Player-summary rows next to Player Radar (МАТЧЕЙ/ПОСЛЕДНИЕ N/ОСН. РОЛЬ/
// ГЕРОЕВ) - pure calc over already-cached OpenDota responses, same "no I/O,
// unit-tested directly" contract as opendota-player-profile-radar.test.ts.

const hero = (overrides: Partial<DotaPlayerHeroStats> = {}): DotaPlayerHeroStats => ({
    heroId: 1,
    games: 10,
    wins: 5,
    ...overrides,
});

describe("computeAccountLifetimeStats", () => {
    it("sums games/wins across every hero in the /heroes response", () => {
        const heroes = [hero({ heroId: 1, games: 100, wins: 60 }), hero({ heroId: 2, games: 50, wins: 20 })];
        expect(computeAccountLifetimeStats(heroes)).toEqual({
            games: 150,
            wins: 80,
            losses: 70,
            winRate: (80 / 150) * 100,
        });
    });

    it("returns null for an account with zero lifetime games", () => {
        expect(computeAccountLifetimeStats([])).toBeNull();
        expect(computeAccountLifetimeStats([hero({ games: 0, wins: 0 })])).toBeNull();
    });
});

describe("computeHeroesPlayedCount", () => {
    it("counts only heroes with games > 0, no minimum-match threshold", () => {
        const heroes = [
            hero({ heroId: 1, games: 1, wins: 0 }),
            hero({ heroId: 2, games: 0, wins: 0 }),
            hero({ heroId: 3, games: 42, wins: 20 }),
        ];
        expect(computeHeroesPlayedCount(heroes)).toBe(2);
    });

    it("returns 0 for an empty heroes list", () => {
        expect(computeHeroesPlayedCount([])).toBe(0);
    });
});

const bucket = (games: number, win = 0): DotaCountBucket => ({ games, win });

describe("computeMainRole", () => {
    it("picks the lane_role bucket with the most games", () => {
        const roleCounts: Record<string, DotaCountBucket> = {
            "1": bucket(20),
            "2": bucket(80),
            "3": bucket(5),
        };
        expect(computeMainRole(roleCounts)).toEqual({ code: 2, label: "Мид", games: 80 });
    });

    it("labels every documented lane_role code (verified against odota/web's own localization)", () => {
        expect(LANE_ROLE_LABELS).toEqual({
            0: "—",
            1: "Керри",
            2: "Мид",
            3: "Оффлейн",
            4: "Лес",
        });
    });

    it("returns null when counts are unavailable", () => {
        expect(computeMainRole(null)).toBeNull();
    });

    it("returns null when every bucket has zero games", () => {
        expect(computeMainRole({ "1": bucket(0), "2": bucket(0) })).toBeNull();
    });

    it("returns null (not a smaller-bucket fallback) when the dominant bucket has an undocumented lane_role code - never misattributes the main role to a less-played bucket just because it's labelable", () => {
        const roleCounts: Record<string, DotaCountBucket> = { "1": bucket(5), "99": bucket(500) };
        expect(computeMainRole(roleCounts)).toBeNull();
    });
});
