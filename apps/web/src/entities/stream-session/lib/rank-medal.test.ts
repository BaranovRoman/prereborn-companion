import { describe, expect, it } from "vitest";
import { getRankMedal } from "./rank-medal";

describe("getRankMedal", () => {
    it("maps a known rating to its tier/division medal", () => {
        expect(getRankMedal(3_100)).toEqual({ fileName: "legend-1.png", label: "Legend 1" });
    });

    it("maps rating 0 to Herald 1 (lowest known medal)", () => {
        expect(getRankMedal(0)).toEqual({ fileName: "herald-1.png", label: "Herald 1" });
    });

    it("maps the Immortal threshold and beyond to immortal.png, no division", () => {
        expect(getRankMedal(5_620)).toEqual({ fileName: "immortal.png", label: "Immortal" });
        expect(getRankMedal(9_000)).toEqual({ fileName: "immortal.png", label: "Immortal" });
    });

    it("falls back to null for unknown rating (null or negative)", () => {
        expect(getRankMedal(null)).toBeNull();
        expect(getRankMedal(-1)).toBeNull();
    });
});
