import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftProtectionLayer } from "./draft-protection-layer";

// jsdom does not implement matchMedia - the reused DraftSceneBackground
// (red-fog-background.tsx) reads prefers-reduced-motion unconditionally, even
// when it falls back because WebGL2 itself is unavailable in jsdom (which it
// already handles gracefully). This stub only covers that environment gap,
// not the shader/component itself.
// jsdom also does not implement ResizeObserver - only BouncingLogo
// (full-cover mode) constructs one; every real target (browsers, OBS's
// Chromium-based browser source) supports it natively, so this is a test-env
// stub only, not a production fallback.
beforeEach(() => {
    vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        })
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const SCENE_WIDTH = 1920;
const SCENE_HEIGHT = 1080;

describe("DraftProtectionLayer", () => {
    it("renders nothing for mode off - a literal no-op over the real Dota UI", () => {
        const { container } = render(
            <DraftProtectionLayer mode="off" sceneWidth={SCENE_WIDTH} sceneHeight={SCENE_HEIGHT} />
        );
        expect(container.innerHTML).toBe("");
    });

    it("renders a text-free, data-free screensaver for full cover with no text configured", () => {
        const { getByTestId } = render(
            <DraftProtectionLayer mode="cover" sceneWidth={SCENE_WIDTH} sceneHeight={SCENE_HEIGHT} />
        );
        const layer = getByTestId("draft-protection-layer");
        // No status text, no hero identity, no timer - just background +
        // the bouncing Prereborn logo (see full-cover-view.tsx).
        expect(layer.textContent).toBe("");
        expect(layer.querySelector("img")).toBeTruthy();
    });

    // WK-86: empty content must never render (old layouts without the field,
    // or a user who cleared the input, must look exactly like before).
    it("renders nothing for an empty/whitespace-only configured text (WK-86)", () => {
        const { getByTestId } = render(
            <DraftProtectionLayer
                mode="cover"
                sceneWidth={SCENE_WIDTH}
                sceneHeight={SCENE_HEIGHT}
                text={{ content: "   ", xVw: 50, yVh: 88, scale: 1, visible: true, anchor: "bottom-center" }}
            />
        );
        expect(getByTestId("draft-protection-layer").textContent).toBe("");
    });

    // WK-86: a configured, non-empty text must render alongside the logo,
    // without disabling it.
    it("renders configured custom text for full cover alongside the logo (WK-86)", () => {
        const { getByTestId, getByText } = render(
            <DraftProtectionLayer
                mode="cover"
                sceneWidth={SCENE_WIDTH}
                sceneHeight={SCENE_HEIGHT}
                text={{ content: "ДРАФТ", xVw: 50, yVh: 88, scale: 1, visible: true, anchor: "bottom-center" }}
            />
        );
        expect(getByText("ДРАФТ")).toBeTruthy();
        expect(getByTestId("draft-protection-layer").querySelector("img")).toBeTruthy();
    });
});
