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

describe("DraftProtectionLayer", () => {
    it("renders the cinematic draft scene when protection is off", () => {
        const { getByTestId } = render(<DraftProtectionLayer mode="off" payload={null} />);
        expect(getByTestId("cinematic-draft-layer")).toBeTruthy();
    });

    it("renders a text-free, data-free screensaver for full cover", () => {
        const { getByTestId } = render(<DraftProtectionLayer mode="cover" />);
        const layer = getByTestId("draft-protection-layer");
        // No status text, no hero identity, no timer - just background +
        // the bouncing Prereborn logo (see full-cover-view.tsx).
        expect(layer.textContent).toBe("");
        expect(layer.querySelector("img")).toBeTruthy();
    });

    it("renders the fake draft picker for the substitute mode", () => {
        const { getByTestId } = render(
            <DraftProtectionLayer mode="substitute" payload={null} />
        );
        expect(getByTestId("fake-draft-picker")).toBeTruthy();
        // enter state starts with nothing focused yet - carousel/showcase
        // populate once the controller advances past "enter".
        expect(getByTestId("fake-countdown").textContent).toMatch(/^\d{2}$/);
    });
});
