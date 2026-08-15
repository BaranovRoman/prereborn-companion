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
