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

    // WK-100 - 0 matches in the current stream must render nothing at all:
    // no empty card, no "no matches" text, no placeholder.
    it("renders nothing when the current stream has 0 matches", () => {
        const { container } = render(
            <RecentMatches
                matches={[]}
                settings={{ limit: 5, source: "current-stream", direction: "newest-first", compact: true }}
                anchor="top-left"
            />
        );
        expect(container.firstChild).toBeNull();
    });

    it("the section appears automatically once the first match is present", () => {
        render(
            <RecentMatches
                matches={PREVIEW_MATCHES.slice(0, 1)}
                settings={{ limit: 5, source: "current-stream", direction: "newest-first", compact: true }}
                anchor="top-left"
            />
        );
        expect(screen.getAllByRole("img")).toHaveLength(1);
    });
});
