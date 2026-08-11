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
        expect(layout.scenes.gameplay.gameplayProtection.enabled).toBe(true);
        expect(layout.scenes.gameplay.gameplayProtection.zones[0]?.id).toBe("buyback-portraits");
        expect(layout.scenes.draft.gameplayProtection).toEqual({ enabled: false, zones: [] });
        expect(layout.scenes.draft.widgets.session.visible).toBe(true);
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
                draftProtection: { mode: "substitute" },
            }).draftProtection.mode
        ).toBe("substitute");
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
});
