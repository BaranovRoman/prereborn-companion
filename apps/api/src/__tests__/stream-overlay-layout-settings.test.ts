import { describe, expect, it } from "vitest";
import { normalizeOverlayLayout } from "../services/stream-overlay-layout-service.js";

describe("Recent Games layout settings", () => {
    it("migrates old layouts to the current-stream scope and count 5", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            scenes: { gameplay: { widgets: { recentMatches: { xVw: 41, yVh: 12 } } } },
        });
        expect(layout.scenes.gameplay.widgets.recentMatches).toMatchObject({
            xVw: 41, yVh: 12, recentMatches: { limit: 5, source: "current-stream" },
        });
    });

    it("persists custom count and source independently", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            scenes: { gameplay: { widgets: { recentMatches: { recentMatches: { limit: 15, source: "recent-matches", direction: "newest-first", compact: true } } } } },
        });
        expect(layout.scenes.gameplay.widgets.recentMatches.recentMatches).toMatchObject({ limit: 15, source: "recent-matches" });
    });

    it.each([0, 21, 1.5, "10"])("falls back safely for invalid count %s", (limit) => {
        const layout = normalizeOverlayLayout({
            version: 4,
            scenes: { gameplay: { widgets: { recentMatches: { recentMatches: { limit, source: "invalid" } } } } },
        });
        expect(layout.scenes.gameplay.widgets.recentMatches.recentMatches).toMatchObject({ limit: 5, source: "current-stream" });
    });
});

describe("Draft protection mode normalization", () => {
    // WK-69: "substitute" (Fake Draft) was removed as a selectable mode.
    // Layouts saved before this change may still have it persisted - it must
    // fail closed to "cover" (still protected), never to "off" (unprotected).
    it("migrates the legacy substitute mode to cover", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "substitute" },
        });
        expect(layout.draftProtection.mode).toBe("cover");
    });

    it("preserves an existing cover config unchanged", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "cover" },
        });
        expect(layout.draftProtection.mode).toBe("cover");
    });

    it("preserves an explicit off config", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "off" },
        });
        expect(layout.draftProtection.mode).toBe("off");
    });

    it("does not accept the reserved future photorealism mode", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "photorealism" },
        });
        expect(layout.draftProtection.mode).toBe("cover");
    });
});
