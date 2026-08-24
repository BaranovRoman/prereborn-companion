import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StreamEndedScene } from "./stream-ended-scene";
import { buildMatch, buildOverlayData, buildSummary } from "./stream-ended-scene.fixtures";

afterEach(cleanup);

// WK-98 - regression coverage for the real post-stream final scene that
// replaces WK-53's StreamEndedBanner (small ribbon over an otherwise fully
// live Between Matches dashboard). These tests pin: the scene is a
// structurally separate composition (no Between Matches widgets), it never
// invents data the backend didn't send, and it stays honest when the
// session-scoped match list is capped shorter than the true match count.
describe("StreamEndedScene", () => {
    it("renders the primary result and hides Between Matches-only content", () => {
        render(<StreamEndedScene data={buildOverlayData()} />);

        expect(screen.getByText("Стрим завершён")).toBeTruthy();
        expect(screen.getByTestId("record-wins").textContent).toBe("2");
        expect(screen.getByTestId("record-losses").textContent).toBe("4");
        expect(screen.getByTestId("match-count").textContent).toBe("6");

        // These are Between Matches-only concerns (queue-scene-ui.tsx) -
        // must never appear on the post-stream scene at all.
        expect(screen.queryByText(/TWITCH CHAT/i)).toBeNull();
        expect(screen.queryByText(/WEBCAM/i)).toBeNull();
        expect(screen.queryByText(/Donaters/i)).toBeNull();
        expect(screen.queryByText(/Subscribers/i)).toBeNull();
    });

    it("shows the MMR block with start->end range for a ranked session", () => {
        render(<StreamEndedScene data={buildOverlayData()} />);

        expect(screen.getByTestId("mmr-delta").textContent).toBe("-50 MMR");
        expect(screen.getByTestId("mmr-range").textContent).toBe("5,986 → 5,936");
    });

    it("hides MMR entirely for an unranked session (no invented rating data)", () => {
        const data = buildOverlayData({
            sessionSummary: buildSummary({
                gameMode: "unranked",
                ratingStart: null,
                ratingEnd: null,
                ratingDelta: null,
            }),
        });
        render(<StreamEndedScene data={data} />);

        expect(screen.queryByTestId("mmr-delta")).toBeNull();
        expect(screen.queryByTestId("mmr-range")).toBeNull();
    });

    it("renders a zero-match ended session cleanly, with no match strip", () => {
        const data = buildOverlayData({
            sessionSummary: buildSummary({
                wins: 0,
                losses: 0,
                matchCount: 0,
                ratingStart: null,
                ratingDelta: 0,
            }),
            matches: [],
        });
        render(<StreamEndedScene data={data} />);

        expect(screen.getByText("Стрим завершён")).toBeTruthy();
        expect(screen.getByTestId("record-wins").textContent).toBe("0");
        expect(screen.getByTestId("match-count").textContent).toBe("0");
        // No known rating start this session (ratingStart null) - delta
        // still shown honestly (0), but no fabricated "null -> X" range.
        expect(screen.getByTestId("mmr-delta").textContent).toBe("±0 MMR");
        expect(screen.queryByTestId("mmr-range")).toBeNull();
        expect(screen.queryByLabelText("Матчи сессии")).toBeNull();
    });

    it.each([
        [25, "+25 MMR"],
        [-25, "-25 MMR"],
        [0, "±0 MMR"],
    ])("formats an MMR delta of %i as %s", (ratingDelta, expected) => {
        const data = buildOverlayData({ sessionSummary: buildSummary({ ratingDelta }) });
        render(<StreamEndedScene data={data} />);
        expect(screen.getByTestId("mmr-delta").textContent).toBe(expected);
    });

    it("renders one chip per session match, oldest to newest, without inventing extra entries", () => {
        const matches = [
            buildMatch({ id: "m3", heroId: 3, result: "win" }),
            buildMatch({ id: "m2", heroId: 2, result: "loss" }),
            buildMatch({ id: "m1", heroId: 1, result: "win" }),
        ]; // backend order: newest (m3) first
        const data = buildOverlayData({
            sessionSummary: buildSummary({ matchCount: 3 }),
            matches,
        });
        render(<StreamEndedScene data={data} />);

        const strip = screen.getByLabelText("Матчи сессии");
        const chips = strip.querySelectorAll("[title]");
        expect(chips).toHaveLength(3);
        // Reversed to a chronological (oldest -> newest) left-to-right read.
        expect(chips[0].getAttribute("title")).toBe("Anti-Mage");
        expect(chips[1].getAttribute("title")).toBe("Axe");
        expect(chips[2].getAttribute("title")).toBe("Bane");
        expect(screen.queryByTestId("match-strip-more")).toBeNull();
    });

    it("shows an honest +N indicator when matchCount exceeds the capped session match list", () => {
        const matches = Array.from({ length: 5 }, (_, index) =>
            buildMatch({ id: `m${index}`, heroId: index + 1 })
        );
        const data = buildOverlayData({
            sessionSummary: buildSummary({ matchCount: 8 }),
            matches,
        });
        render(<StreamEndedScene data={data} />);

        expect(screen.getByTestId("match-strip-more").textContent).toBe("+3");
        // matchCount stays the honest total, independent of the capped strip.
        expect(screen.getByTestId("match-count").textContent).toBe("8");
    });

    it("never mixes in matches from a previous session (renders exactly what `data.matches` contains)", () => {
        // The backend already scopes `data.matches` to the ended session's
        // id (getRecentMatchesForSession) - this pins the frontend half:
        // StreamEndedScene must render exactly that list, nothing account-
        // wide/unfiltered added on top (unlike queue-scene-ui.tsx's
        // `recentMatches`, which is deliberately account-wide).
        const matches = [buildMatch({ id: "current-1", heroId: 5, streamSessionId: "session-current" })];
        const data = buildOverlayData({
            sessionSummary: buildSummary({ sessionId: "session-current", matchCount: 1 }),
            matches,
        });
        render(<StreamEndedScene data={data} />);

        const strip = screen.getByLabelText("Матчи сессии");
        expect(strip.querySelectorAll("[title]")).toHaveLength(1);
    });

    it("is a pure function of `data` - a late-finalize update on the same instance re-renders with no stale snapshot", () => {
        // WK-53 - a match already in flight when the streamer clicks End
        // finalizes afterward and updates the live (non-frozen) summary -
        // see stream-session-end-lifecycle.test.ts on the API side. Here we
        // pin the frontend half of that contract: OverlayPage re-renders
        // StreamEndedScene with fresh polled `data` on the same component
        // instance (see use-overlay-polling.ts), so this must never hold
        // onto the summary/matches it first received via internal state.
        const before = buildOverlayData({
            sessionSummary: buildSummary({ wins: 0, losses: 0, matchCount: 0 }),
            matches: [],
        });
        const { rerender } = render(<StreamEndedScene data={before} />);
        expect(screen.getByTestId("match-count").textContent).toBe("0");
        expect(screen.queryByLabelText("Матчи сессии")).toBeNull();

        const after = buildOverlayData({
            sessionSummary: buildSummary({ wins: 1, losses: 0, matchCount: 1 }),
            matches: [buildMatch({ id: "m1", heroId: 1, result: "win" })],
        });
        rerender(<StreamEndedScene data={after} />);

        expect(screen.getByTestId("match-count").textContent).toBe("1");
        expect(screen.getByLabelText("Матчи сессии")).toBeTruthy();
    });

    it("degrades to an empty shell instead of crashing if sessionSummary is unexpectedly null", () => {
        const data = buildOverlayData({ sessionSummary: null });
        const { getByTestId } = render(<StreamEndedScene data={data} />);
        expect(getByTestId("stream-ended-scene")).toBeTruthy();
    });
});
