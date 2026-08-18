import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftProtectionLayer } from "./draft-protection-layer";

// jsdom does not implement matchMedia - the reused DraftSceneBackground
// (red-fog-background.tsx) reads prefers-reduced-motion unconditionally, even
// when it falls back because WebGL2 itself is unavailable in jsdom (which it
// already handles gracefully). This stub only covers that environment gap,
// not the shader/component itself.
beforeEach(() => {
    vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        })
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

    it("renders the classic picker composition without real draft data for full cover", () => {
        const { getByTestId } = render(<DraftProtectionLayer mode="cover" />);
        const text = getByTestId("draft-protection-layer").textContent;
        expect(text).toContain("DRAFT PROTECTED");
        expect(text).toContain("Информация скрыта во время драфта");
        // no hero identity/timer of any kind in the cover composition
        expect(text).not.toMatch(/\d/);
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
