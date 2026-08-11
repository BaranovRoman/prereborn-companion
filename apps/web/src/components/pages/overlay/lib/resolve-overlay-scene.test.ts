import { describe, expect, it } from "vitest";
import { resolveOverlayScene } from "./resolve-overlay-scene";

describe("resolveOverlayScene", () => {
    it("gives an explicit test override highest priority", () => {
        expect(resolveOverlayScene({
            override: "gameplay", companionOnline: false,
            derived: "betweenMatches", draftProtectionMode: "cover",
        })).toBe("gameplay");
    });

    it("uses the protected draft fallback when companion state is stale", () => {
        expect(resolveOverlayScene({
            override: null, companionOnline: false,
            derived: "gameplay", draftProtectionMode: "cover",
        })).toBe("draft");
    });

    it("preserves the derived custom scene when draft protection is disabled", () => {
        expect(resolveOverlayScene({
            override: null, companionOnline: false,
            derived: "draft", draftProtectionMode: "off",
        })).toBe("draft");
    });

    it("uses the current safe GSI-derived scene while online", () => {
        expect(resolveOverlayScene({
            override: null, companionOnline: true,
            derived: "draft", draftProtectionMode: "cover",
        })).toBe("draft");
    });
});
