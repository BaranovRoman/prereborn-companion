import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CinematicDraftLayer } from "./cinematic-draft-layer";

afterEach(cleanup);

describe("CinematicDraftLayer", () => {
    it("renders 10 empty slots when nothing is known yet", () => {
        const { getByTestId, container } = render(<CinematicDraftLayer payload={null} />);
        expect(getByTestId("cinematic-draft-layer")).toBeTruthy();
        expect(container.querySelectorAll('[data-testid^="draft-slot-"]').length).toBe(10);
        expect(container.textContent).toBe("");
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
