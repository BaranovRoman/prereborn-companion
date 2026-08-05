import { describe, expect, it } from "vitest";
import { createMinimapWards } from "./anti-snipe-layer";

describe("createMinimapWards", () => {
    it("keeps the clean map empty", () => {
        expect(createMinimapWards("clean")).toEqual([]);
    });

    it("keeps the original static Dotabod cover free from duplicate DOM wards", () => {
        expect(createMinimapWards("random-a")).toEqual([]);
    });

    it("creates deterministic, visible generated presets inside the map", () => {
        const wards = createMinimapWards("random-b");
        expect(wards).toHaveLength(56);
        expect(wards).toEqual(createMinimapWards("random-b"));
        expect(wards.every(({ x, y }) => x >= 7 && x <= 93 && y >= 7 && y <= 93)).toBe(true);
        expect(new Set(wards.map(({ kind }) => kind))).toEqual(new Set(["observer", "sentry"]));
    });

    it("makes the dense and interactive variants meaningfully populated", () => {
        expect(createMinimapWards("random-dense")).toHaveLength(74);
        expect(createMinimapWards("interactive")).toHaveLength(60);
    });
});
