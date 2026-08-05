import { describe, expect, it } from "vitest";
import { createMinimapWards } from "./anti-snipe-layer";

describe("createMinimapWards", () => {
    it("keeps the clean map empty", () => {
        expect(createMinimapWards("clean")).toEqual([]);
    });

    it("creates deterministic, visible presets inside the map", () => {
        const wards = createMinimapWards("random-a");
        expect(wards).toHaveLength(22);
        expect(wards).toEqual(createMinimapWards("random-a"));
        expect(wards.every(({ x, y }) => x >= 7 && x <= 93 && y >= 7 && y <= 93)).toBe(true);
        expect(new Set(wards.map(({ kind }) => kind))).toEqual(new Set(["observer", "sentry"]));
    });

    it("makes the dense and interactive variants meaningfully populated", () => {
        expect(createMinimapWards("random-dense")).toHaveLength(42);
        expect(createMinimapWards("interactive")).toHaveLength(28);
    });
});
