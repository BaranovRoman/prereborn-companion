import { describe, expect, it } from "vitest";
import {
    compareVersions,
    isCompanionVersionSupported,
} from "../utils/companion-version.js";

describe("compareVersions", () => {
    it("orders by major/minor/patch", () => {
        expect(compareVersions("0.4.0", "0.3.9")).toBeGreaterThan(0);
        expect(compareVersions("0.3.9", "0.4.0")).toBeLessThan(0);
        expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    });

    it("treats missing segments as zero", () => {
        expect(compareVersions("1", "1.0.0")).toBe(0);
        expect(compareVersions("1.2", "1.2.0")).toBe(0);
    });
});

describe("isCompanionVersionSupported", () => {
    it("accepts a version at or above the floor", () => {
        expect(isCompanionVersionSupported("0.4.0", "0.4.0")).toBe(true);
        expect(isCompanionVersionSupported("0.5.1", "0.4.0")).toBe(true);
    });

    it("rejects a version below the floor", () => {
        expect(isCompanionVersionSupported("0.3.9", "0.4.0")).toBe(false);
    });

    it("does not block missing or malformed versions", () => {
        expect(isCompanionVersionSupported(undefined, "0.4.0")).toBe(true);
        expect(isCompanionVersionSupported(null, "0.4.0")).toBe(true);
        expect(isCompanionVersionSupported("not-a-version", "0.4.0")).toBe(true);
    });
});
