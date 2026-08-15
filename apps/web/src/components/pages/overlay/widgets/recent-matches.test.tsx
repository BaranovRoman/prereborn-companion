import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_MATCHES } from "../../stream/overlay-editor/preview-data";
import { RecentMatches } from "./recent-matches";

afterEach(cleanup);

describe("RecentMatches", () => {
    it("renders more than five rows when configured", () => {
        render(
            <RecentMatches
                matches={PREVIEW_MATCHES}
                settings={{ limit: 8, source: "current-stream", direction: "newest-first", compact: true }}
                anchor="top-left"
            />
        );
        expect(screen.getAllByRole("img")).toHaveLength(8);
    });

    it("keeps the count independent from source", () => {
        render(
            <RecentMatches
                matches={PREVIEW_MATCHES}
                settings={{ limit: 3, source: "recent-matches", direction: "newest-first", compact: true }}
                anchor="top-left"
            />
        );
        expect(screen.getAllByRole("img")).toHaveLength(3);
        expect(screen.getByText("+5 ещё")).not.toBeNull();
    });
});
