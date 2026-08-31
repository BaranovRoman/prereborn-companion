import { describe, expect, it } from "vitest";
import { normalizeOverlayLayout } from "./normalize-layout";

describe("normalizeOverlayLayout", () => {
    it("migrates a v1 layout into gameplay without blanking the overlay", () => {
        const layout = normalizeOverlayLayout({
            version: 1,
            widgets: {
                session: {
                    xVw: 42,
                    yVh: 7,
                    scale: 1,
                    visible: true,
                    anchor: "top-left",
                },
            },
            aspectRatio: { preset: "16:9", widthRatio: 16, heightRatio: 9 },
        });

        expect(layout.version).toBe(5);
        expect(layout.scenes.gameplay.widgets.session.xVw).toBe(42);
        expect(layout.scenes.draft.widgets.session.visible).toBe(true);
    });

    it("drops the retired currentGame widget when migrating a saved v4 layout", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            scenes: { gameplay: { widgets: { currentGame: { xVw: 44, yVh: 55, scale: 1, visible: true, anchor: "center" } } } },
        });
        expect(layout.version).toBe(5);
        expect(layout.scenes.gameplay.widgets).not.toHaveProperty("currentGame");
    });

    it("fails closed for old or malformed draft protection settings", () => {
        expect(normalizeOverlayLayout({ version: 3 }).draftProtection.mode).toBe(
            "cover"
        );
        expect(
            normalizeOverlayLayout({
                version: 4,
                draftProtection: { mode: "unexpected" },
            }).draftProtection.mode
        ).toBe("cover");
    });

    it("preserves an explicit public draft mode", () => {
        expect(
            normalizeOverlayLayout({
                version: 4,
                draftProtection: { mode: "off" },
            }).draftProtection.mode
        ).toBe("off");
        expect(
            normalizeOverlayLayout({
                version: 4,
                draftProtection: { mode: "cover" },
            }).draftProtection.mode
        ).toBe("cover");
    });

    // WK-69 regression: Fake Draft ("substitute") was removed as a
    // selectable mode, but layouts persisted before this change may still
    // have it saved. Silently mapping it to "off" would strip protection
    // from a stream the user explicitly protected, so it must fail closed
    // to "cover" instead - same fallback as any other invalid value.
    it("migrates the legacy substitute mode to cover instead of dropping protection", () => {
        expect(
            normalizeOverlayLayout({
                version: 4,
                draftProtection: { mode: "substitute" },
            }).draftProtection.mode
        ).toBe("cover");
    });

    // The reserved future "photorealism" mode has no renderer yet - it must
    // not become persistable/selectable just because the string exists as a
    // constant (RESERVED_FUTURE_DRAFT_PROTECTION_MODE).
    it("does not accept the reserved future photorealism mode", () => {
        expect(
            normalizeOverlayLayout({
                version: 4,
                draftProtection: { mode: "photorealism" },
            }).draftProtection.mode
        ).toBe("cover");
    });

    it("migrates percentage camera coordinates to OBS pixels", () => {
        const layout = normalizeOverlayLayout({
            scenes: {
                gameplay: {
                    cameraZone: {
                        enabled: true,
                        xPercent: 50,
                        yPercent: 50,
                        widthPercent: 25,
                        heightPercent: 25,
                    },
                },
            },
        });

        expect(layout.scenes.gameplay.cameraZone).toEqual({
            enabled: true,
            anchor: "top-left",
            x: 960,
            y: 540,
            width: 480,
            height: 270,
        });
    });

    it("uses a complete default for malformed data", () => {
        const layout = normalizeOverlayLayout(null);
        expect(layout.scenes.gameplay.widgets.session.visible).toBe(true);
        expect(layout.scenes.draft.cameraZone.width).toBeGreaterThan(0);
    });

    it("migrates v2 edge offsets to OBS alignment-point coordinates", () => {
        const layout = normalizeOverlayLayout({
            version: 2,
            scenes: {
                gameplay: {
                    cameraZone: {
                        enabled: true,
                        anchor: "bottom-right",
                        x: 60,
                        y: 67,
                        width: 400,
                        height: 300,
                    },
                },
            },
        });
        expect(layout.scenes.gameplay.cameraZone).toMatchObject({
            anchor: "bottom-right",
            x: 1860,
            y: 1013,
        });
    });

    it("defaults old Recent Games settings to five current-stream matches", () => {
        const settings = normalizeOverlayLayout({ version: 4 }).scenes.gameplay.widgets.recentMatches.recentMatches;
        expect(settings).toMatchObject({ limit: 5, source: "current-stream" });
    });

    // WK-86: old persisted layouts predate draftProtection.text entirely -
    // must default to an empty/no-op text, not throw or blank the layout.
    it("defaults draft protection text for a layout that predates it", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "cover" },
        });
        expect(layout.draftProtection.text).toMatchObject({ content: "", anchor: "bottom-center" });
    });

    it("preserves persisted draft protection text content/position", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: {
                mode: "cover",
                text: { content: "ДРАФТ", xVw: 12, yVh: 34, scale: 1.25, visible: true, anchor: "top-left" },
            },
        });
        expect(layout.draftProtection.text).toMatchObject({
            content: "ДРАФТ",
            xVw: 12,
            yVh: 34,
            scale: 1.25,
            anchor: "top-left",
        });
    });

    it("clamps an oversized draft protection text instead of dropping it", () => {
        const layout = normalizeOverlayLayout({
            version: 4,
            draftProtection: { mode: "cover", text: { content: "x".repeat(500) } },
        });
        expect(layout.draftProtection.text.content).toHaveLength(80);
    });

    it("preserves custom count/source and rejects invalid persisted values", () => {
        const configured = normalizeOverlayLayout({
            version: 4,
            scenes: { gameplay: { widgets: { recentMatches: { recentMatches: { limit: 15, source: "recent-matches" } } } } },
        }).scenes.gameplay.widgets.recentMatches.recentMatches;
        expect(configured).toMatchObject({ limit: 15, source: "recent-matches" });

        for (const limit of [0, 21, 2.5, Number.NaN]) {
            const normalized = normalizeOverlayLayout({
                version: 4,
                scenes: { gameplay: { widgets: { recentMatches: { recentMatches: { limit, source: "invalid" } } } } },
            }).scenes.gameplay.widgets.recentMatches.recentMatches;
            expect(normalized).toMatchObject({ limit: 5, source: "current-stream" });
        }
    });
});
