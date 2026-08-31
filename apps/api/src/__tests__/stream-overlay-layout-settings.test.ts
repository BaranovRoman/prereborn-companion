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

describe("Draft protection text normalization (WK-86)", () => {
    it("defaults to an empty/no-op text for a layout that predates the field", () => {
        const layout = normalizeOverlayLayout({ version: 4, draftProtection: { mode: "cover" } });
        expect(layout.draftProtection.text).toMatchObject({ content: "", anchor: "bottom-center" });
    });

    it("persists custom content, font size (scale) and position", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: {
                mode: "cover",
                text: { content: "НЕ ПОДГЛЯДЫВАТЬ", xVw: 20, yVh: 40, scale: 1.5, visible: true, anchor: "center" },
            },
        });
        expect(layout.draftProtection.text).toMatchObject({
            content: "НЕ ПОДГЛЯДЫВАТЬ",
            xVw: 20,
            yVh: 40,
            scale: 1.5,
            anchor: "center",
        });
    });

    it("truncates an oversized text to the max length instead of rejecting it", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "cover", text: { content: "y".repeat(500) } },
        });
        expect(layout.draftProtection.text.content).toHaveLength(80);
    });

    it("clamps position but preserves direct-resize scale above the old UI ceiling", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: {
                mode: "cover",
                text: { content: "x", xVw: 500, yVh: -50, scale: 10 },
            },
        });
        expect(layout.draftProtection.text).toMatchObject({ xVw: 100, yVh: 0, scale: 10 });
    });
});

describe("removed Current Game widget migration", () => {
    it("drops currentGame while preserving the supported Gameplay widgets", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            scenes: { gameplay: { widgets: { currentGame: { xVw: 44, yVh: 55, scale: 1, visible: true, anchor: "center" } } } },
        });
        expect(layout.version).toBe(5);
        expect(layout.scenes.gameplay.widgets).not.toHaveProperty("currentGame");
        expect(layout.scenes.gameplay.widgets).toHaveProperty("session");
        expect(layout.scenes.gameplay.widgets).toHaveProperty("recentMatches");
    });
});
