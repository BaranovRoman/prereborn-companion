import { describe, it, expect } from "vitest";
import type { DotaHeroMatch, DotaPlayerTotals } from "../services/dota-match-provider.js";
import {
    computeRecentForm,
    computeHeroPatchStats,
    computeHeroKdaAverages,
    computeHeroParsedAverages,
    averageStatTotal,
    MIN_PARSED_SAMPLE,
} from "../services/opendota-hero-insights-formulas.js";

// WK-148 - секция 14 требует явную unit-покрытие каждой формулы Hero Detail:
// recent form с выборкой < лимита запроса, патч-блок с/без данных на текущем
// патче, KDA/GPM/XPM, parsed-only метрики (недостаточно/достаточно покрытия).

const match = (overrides: Partial<DotaHeroMatch> = {}): DotaHeroMatch => ({
    matchId: "1",
    isWin: true,
    kills: 5,
    deaths: 2,
    assists: 8,
    goldPerMin: 500,
    xpPerMin: 600,
    lastHits: 150,
    heroDamage: 10000,
    towerDamage: 1000,
    heroHealing: 0,
    ...overrides,
});

const emptyTotals = (): DotaPlayerTotals => ({
    kills: { n: 0, sum: 0 },
    deaths: { n: 0, sum: 0 },
    assists: { n: 0, sum: 0 },
    goldPerMin: { n: 0, sum: 0 },
    xpPerMin: { n: 0, sum: 0 },
    lastHits: { n: 0, sum: 0 },
    heroDamage: { n: 0, sum: 0 },
    towerDamage: { n: 0, sum: 0 },
    heroHealing: { n: 0, sum: 0 },
});

describe("computeRecentForm", () => {
    it("returns null for an empty match list", () => {
        expect(computeRecentForm([])).toBeNull();
    });

    it("does not imply a sample of 20 when fewer matches exist", () => {
        const matches = [match({ isWin: true }), match({ isWin: false }), match({ isWin: true })];
        expect(computeRecentForm(matches)).toEqual({
            sample: 3,
            wins: 2,
            losses: 1,
            winRate: (2 / 3) * 100,
        });
    });

    it("computes wins/losses/winRate for a full 20-match sample", () => {
        const matches = [
            ...Array.from({ length: 12 }, () => match({ isWin: true })),
            ...Array.from({ length: 8 }, () => match({ isWin: false })),
        ];
        expect(computeRecentForm(matches)).toEqual({ sample: 20, wins: 12, losses: 8, winRate: 60 });
    });
});

describe("computeHeroPatchStats", () => {
    it("returns null when the player has not played this hero on the current patch", () => {
        expect(computeHeroPatchStats({ "58": { games: 10, win: 6 } }, 60)).toBeNull();
    });

    it("returns null for a present-but-zero-games bucket rather than a 0-match stat", () => {
        expect(computeHeroPatchStats({ "60": { games: 0, win: 0 } }, 60)).toBeNull();
    });

    it("computes games/wins/losses/winRate for the resolved patch", () => {
        expect(computeHeroPatchStats({ "60": { games: 12, win: 7 } }, 60)).toEqual({
            patchId: 60,
            games: 12,
            wins: 7,
            losses: 5,
            winRate: (7 / 12) * 100,
        });
    });
});

describe("averageStatTotal", () => {
    it("returns null when n is below the minimum sample", () => {
        expect(averageStatTotal({ n: 2, sum: 200 }, 5)).toBeNull();
    });

    it("returns sum/n when n meets the minimum sample", () => {
        expect(averageStatTotal({ n: 5, sum: 250 }, 5)).toBe(50);
    });

    it("defaults to a minimum sample of 1 (reliable, non-parsed fields)", () => {
        expect(averageStatTotal({ n: 1, sum: 42 })).toBe(42);
        expect(averageStatTotal({ n: 0, sum: 0 })).toBeNull();
    });
});

describe("computeHeroKdaAverages", () => {
    it("returns null fields when totals are empty (no data)", () => {
        expect(computeHeroKdaAverages(emptyTotals())).toEqual({
            kills: null,
            deaths: null,
            assists: null,
            goldPerMin: null,
            xpPerMin: null,
        });
    });

    it("averages kills/deaths/assists/gpm/xpm as sum/n", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            kills: { n: 26, sum: 359 },
            deaths: { n: 26, sum: 94 },
            assists: { n: 26, sum: 186 },
            goldPerMin: { n: 26, sum: 16954 },
            xpPerMin: { n: 26, sum: 18626 },
        };
        const result = computeHeroKdaAverages(totals);
        expect(result.kills).toBeCloseTo(359 / 26);
        expect(result.deaths).toBeCloseTo(94 / 26);
        expect(result.assists).toBeCloseTo(186 / 26);
        expect(result.goldPerMin).toBeCloseTo(16954 / 26);
        expect(result.xpPerMin).toBeCloseTo(18626 / 26);
    });
});

describe("computeHeroParsedAverages", () => {
    it("omits fields below MIN_PARSED_SAMPLE instead of averaging a tiny parsed subset", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            heroDamage: { n: MIN_PARSED_SAMPLE - 1, sum: 100000 },
        };
        expect(computeHeroParsedAverages(totals).heroDamage).toBeNull();
    });

    it("shows the average once parse coverage meets MIN_PARSED_SAMPLE", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            heroDamage: { n: MIN_PARSED_SAMPLE, sum: 100000 },
            towerDamage: { n: MIN_PARSED_SAMPLE, sum: 25000 },
            heroHealing: { n: MIN_PARSED_SAMPLE, sum: 0 },
        };
        const result = computeHeroParsedAverages(totals);
        expect(result.heroDamage).toBe(100000 / MIN_PARSED_SAMPLE);
        expect(result.towerDamage).toBe(25000 / MIN_PARSED_SAMPLE);
        expect(result.heroHealing).toBe(0);
    });
});
