import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CinematicDraftLayer } from "./cinematic-draft-layer";

// jsdom does not implement matchMedia - DraftSceneBackground's RedFogBackground
// reads prefers-reduced-motion unconditionally (see draft-protection-layer.test.tsx
// for the same stub/rationale).
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

describe("CinematicDraftLayer", () => {
    it("renders 10 empty slots when nothing is known yet", () => {
        const { getByTestId, container } = render(<CinematicDraftLayer payload={null} />);
        expect(getByTestId("cinematic-draft-layer")).toBeTruthy();
        expect(container.querySelectorAll('[data-testid^="draft-slot-"]').length).toBe(10);
        // Слоты остаются пустыми, но статичные подписи ряда (RADIANT/DIRE) -
        // часть композиции, не производная от данных, и остаются всегда.
        for (const slot of container.querySelectorAll('[data-testid^="draft-slot-"]')) {
            expect(slot.textContent).toBe("");
        }
        expect(container.textContent).toBe("RADIANTDIRE");
    });

    it("places the player's own hero in their own team's first slot", () => {
        const { getByTestId } = render(
            <CinematicDraftLayer payload={{ player: { team_name: "radiant" }, hero: { id: 1 } }} />
        );
        expect(getByTestId("draft-slot-top-0").textContent).not.toBe("");
        expect(getByTestId("draft-slot-top-1").textContent).toBe("");
        expect(getByTestId("draft-slot-bottom-0").textContent).toBe("");
    });

    it("places the player's own hero on the bottom row for the dire team", () => {
        const { getByTestId } = render(
            <CinematicDraftLayer payload={{ player: { team_name: "dire" }, hero: { id: 1 } }} />
        );
        expect(getByTestId("draft-slot-bottom-0").textContent).not.toBe("");
        expect(getByTestId("draft-slot-top-0").textContent).toBe("");
    });

    it("never renders enemy/teammate pick data - only the local player's own hero can ever appear", () => {
        const { getByTestId } = render(
            <CinematicDraftLayer
                payload={{
                    player: { team_name: "radiant" },
                    hero: { id: 1 },
                    draft: { team2: { pick0_id: 2 }, team3: { pick0_id: 3 } },
                }}
            />
        );
        // Only slot top-0 (the local player) may be filled; every other slot,
        // including all 4 remaining radiant slots and all 5 dire slots, must
        // stay empty regardless of what a draft.* section claims.
        for (const row of ["top", "bottom"] as const) {
            for (let index = 0; index < 5; index++) {
                if (row === "top" && index === 0) continue;
                expect(getByTestId(`draft-slot-${row}-${index}`).textContent).toBe("");
            }
        }
    });
});
