import { describe, it, expect } from "vitest";
import type { DotaPlayerTotals } from "../services/dota-match-provider.js";
import {
    normalizeToScore,
    computeCombatAxis,
    computeFarmAxis,
    computeSupportAxis,
    computeObjectivesAxis,
    computeFlexibilityAxis,
    computePlayerProfileRadar,
    hasSufficientRadarSample,
    RADAR_ANCHORS,
    MIN_RADAR_SAMPLE_GAMES,
    FLEXIBILITY_CONFIDENCE_SATURATION_GAMES,
} from "../services/opendota-player-profile-radar.js";

// WK-148 - секция 14: normalization/clamping per axis, minimum sample,
// missing optional metrics, hero concentration lowering Гибкость, broader
// distribution raising it, role diversity affecting it, missing role data
// falling back safely, and the explicit anti-case ("50 heroes x 1 game each"
// must NOT produce ~100).

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

describe("normalizeToScore", () => {
    it("clamps below the min anchor to 0", () => {
        expect(normalizeToScore(-100, { min: 0, max: 100 })).toBe(0);
    });

    it("clamps above the max anchor to 100", () => {
        expect(normalizeToScore(1000, { min: 0, max: 100 })).toBe(100);
    });

    it("maps the midpoint to 50", () => {
        expect(normalizeToScore(50, { min: 0, max: 100 })).toBe(50);
    });
});

describe("computeCombatAxis", () => {
    it("returns null when kills/assists totals are empty", () => {
        expect(computeCombatAxis(emptyTotals())).toBeNull();
    });

    it("uses kills+assists alone when hero_damage coverage is insufficient", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            kills: { n: 100, sum: 1000 },
            assists: { n: 100, sum: 1000 },
        };
        const expected = normalizeToScore(10 + 10, RADAR_ANCHORS.combatKillsAssists);
        expect(computeCombatAxis(totals)).toBe(expected);
    });

    it("blends kills+assists with hero_damage once parse coverage is sufficient", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            kills: { n: 100, sum: 1000 },
            assists: { n: 100, sum: 1000 },
            heroDamage: { n: 50, sum: 50 * 15000 },
        };
        const kaScore = normalizeToScore(20, RADAR_ANCHORS.combatKillsAssists);
        const dmgScore = normalizeToScore(15000, RADAR_ANCHORS.combatHeroDamage);
        expect(computeCombatAxis(totals)).toBe(Math.round((kaScore + dmgScore) / 2));
    });
});

describe("computeFarmAxis", () => {
    it("returns null when no farm metrics are available", () => {
        expect(computeFarmAxis(emptyTotals())).toBeNull();
    });

    it("averages available farm metrics and degrades gracefully when one is missing", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            goldPerMin: { n: 10, sum: 4750 },
            xpPerMin: { n: 10, sum: 5250 },
        };
        const gpmScore = normalizeToScore(475, RADAR_ANCHORS.farmGpm);
        const xpmScore = normalizeToScore(525, RADAR_ANCHORS.farmXpm);
        expect(computeFarmAxis(totals)).toBe(Math.round((gpmScore + xpmScore) / 2));
    });
});

describe("computeSupportAxis", () => {
    it("returns null when assists are unavailable", () => {
        expect(computeSupportAxis(emptyTotals())).toBeNull();
    });

    it("uses assists alone when healing coverage is insufficient", () => {
        const totals: DotaPlayerTotals = { ...emptyTotals(), assists: { n: 50, sum: 750 } };
        expect(computeSupportAxis(totals)).toBe(normalizeToScore(15, RADAR_ANCHORS.supportAssists));
    });

    it("weights assists 70% / healing 30% once healing coverage is sufficient", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            assists: { n: 50, sum: 750 },
            heroHealing: { n: 20, sum: 20 * 1500 },
        };
        const assistsScore = normalizeToScore(15, RADAR_ANCHORS.supportAssists);
        const healingScore = normalizeToScore(1500, RADAR_ANCHORS.supportHealing);
        expect(computeSupportAxis(totals)).toBe(Math.round(assistsScore * 0.7 + healingScore * 0.3));
    });
});

describe("computeObjectivesAxis", () => {
    it("hides the axis entirely when tower_damage parse coverage is insufficient", () => {
        const totals: DotaPlayerTotals = { ...emptyTotals(), towerDamage: { n: 2, sum: 8000 } };
        expect(computeObjectivesAxis(totals)).toBeNull();
    });

    it("computes the axis once coverage is sufficient", () => {
        const totals: DotaPlayerTotals = { ...emptyTotals(), towerDamage: { n: 10, sum: 30000 } };
        expect(computeObjectivesAxis(totals)).toBe(normalizeToScore(3000, RADAR_ANCHORS.objectivesTowerDamage));
    });
});

describe("computeFlexibilityAxis", () => {
    it("does not produce an absurd maximum from a tiny one-game-per-hero sample", () => {
        const heroGames = Array.from({ length: 50 }, () => 1); // 50 heroes, 1 game each = 50 total
        const score = computeFlexibilityAxis({ heroGames, roleGames: null });
        expect(score).not.toBeNull();
        expect(score!).toBeLessThan(50);
    });

    it("scores heavy hero concentration low", () => {
        const heroGames = [280, 5, 5, 5, 5]; // 300 total, dominated by one hero
        const score = computeFlexibilityAxis({ heroGames, roleGames: null });
        expect(score).not.toBeNull();
        expect(score!).toBeLessThan(20);
    });

    it("scores a broad, meaningful hero distribution high", () => {
        const heroGames = Array.from({ length: 20 }, () => 25); // 500 total, evenly spread
        const score = computeFlexibilityAxis({ heroGames, roleGames: null });
        expect(score).not.toBeNull();
        expect(score!).toBeGreaterThan(60);
    });

    it("broader distribution scores higher than heavy concentration at the same volume", () => {
        const concentrated = [280, 5, 5, 5, 5];
        const broad = Array.from({ length: 20 }, () => 15); // same 300 total, spread across 20 heroes
        const concentratedScore = computeFlexibilityAxis({ heroGames: concentrated, roleGames: null })!;
        const broadScore = computeFlexibilityAxis({ heroGames: broad, roleGames: null })!;
        expect(broadScore).toBeGreaterThan(concentratedScore);
    });

    it("factors in role diversity when available", () => {
        const heroGames = Array.from({ length: 20 }, () => 25); // 500 total
        const oneRole = [500]; // played a single role exclusively
        const fiveRoles = [100, 100, 100, 100, 100]; // evenly split across all roles
        const oneRoleScore = computeFlexibilityAxis({ heroGames, roleGames: oneRole })!;
        const fiveRoleScore = computeFlexibilityAxis({ heroGames, roleGames: fiveRoles })!;
        expect(fiveRoleScore).toBeGreaterThan(oneRoleScore);
    });

    it("falls back to hero diversity alone when role data is unavailable", () => {
        const heroGames = Array.from({ length: 20 }, () => 25);
        const withNullRoles = computeFlexibilityAxis({ heroGames, roleGames: null });
        const withEmptyRoles = computeFlexibilityAxis({ heroGames, roleGames: [] });
        expect(withNullRoles).toEqual(withEmptyRoles);
        expect(withNullRoles).not.toBeNull();
    });

    it("returns null when there are no hero games at all", () => {
        expect(computeFlexibilityAxis({ heroGames: [], roleGames: null })).toBeNull();
    });

    it("dampens the score below the confidence saturation threshold", () => {
        const heroGames = Array.from({ length: 20 }, () => 5); // 100 total, well under saturation
        const score = computeFlexibilityAxis({ heroGames, roleGames: null })!;
        expect(FLEXIBILITY_CONFIDENCE_SATURATION_GAMES).toBeGreaterThan(100);
        expect(score).toBeLessThan(80);
    });
});

describe("hasSufficientRadarSample / computePlayerProfileRadar", () => {
    it("flags insufficient sample below MIN_RADAR_SAMPLE_GAMES", () => {
        expect(hasSufficientRadarSample(MIN_RADAR_SAMPLE_GAMES - 1)).toBe(false);
        expect(hasSufficientRadarSample(MIN_RADAR_SAMPLE_GAMES)).toBe(true);
    });

    it("returns all-null axes with insufficientSample when the account has too few games", () => {
        const heroGames = [5, 5]; // 10 total, below MIN_RADAR_SAMPLE_GAMES
        const result = computePlayerProfileRadar(emptyTotals(), heroGames, null);
        expect(result).toEqual({
            combat: null,
            farm: null,
            support: null,
            objectives: null,
            flexibility: null,
            insufficientSample: true,
        });
    });

    it("computes axes once the sample is sufficient", () => {
        const totals: DotaPlayerTotals = {
            ...emptyTotals(),
            kills: { n: 40, sum: 400 },
            assists: { n: 40, sum: 400 },
            goldPerMin: { n: 40, sum: 40 * 500 },
        };
        const heroGames = Array.from({ length: 8 }, () => 5); // 40 total, meets the minimum
        const result = computePlayerProfileRadar(totals, heroGames, null);
        expect(result.insufficientSample).toBe(false);
        expect(result.combat).not.toBeNull();
        expect(result.farm).not.toBeNull();
        expect(result.flexibility).not.toBeNull();
    });
});
