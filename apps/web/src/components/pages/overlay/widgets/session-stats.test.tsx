import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStats } from "./session-stats";

afterEach(cleanup);

describe("SessionStats", () => {
    it("renders a rank medal for a known rating without changing MMR/W-L values", () => {
        render(
            <SessionStats
                rating={3_100}
                sessionRatingDelta={25}
                wins={5}
                losses={2}
                gameMode="ranked"
            />
        );
        const medal = screen.getByRole("img", { name: "Legend 1 rank medal" });
        expect(medal.getAttribute("src")).toContain("legend-1.png");
        expect(screen.getByText(/3100 MMR/)).not.toBeNull();
        expect(screen.getByText(/5W \/ 2L/)).not.toBeNull();
    });

    it("renders no medal when rating is unknown (graceful fallback)", () => {
        render(
            <SessionStats
                rating={null}
                sessionRatingDelta={null}
                wins={1}
                losses={0}
                gameMode="ranked"
            />
        );
        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByText(/1W \/ 0L/)).not.toBeNull();
    });
});
