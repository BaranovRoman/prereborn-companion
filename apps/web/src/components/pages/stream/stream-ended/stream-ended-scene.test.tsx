import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StreamEndedScene } from "./stream-ended-scene";
import { buildMatch, buildOverlayData, buildSummary } from "./stream-ended-scene.fixtures";

afterEach(cleanup);

// WK-98 - regression coverage for the real post-stream final scene that
// replaces WK-53's StreamEndedBanner (small ribbon over an otherwise fully
// live Between Matches dashboard), and its follow-up visual refinement:
// wide landscape match-history entries (not a square-icon inventory strip),
// adaptive density so up to 20 matches still fit a 1920x1080 canvas without
// scrolling, and stricter "never show a placeholder MMR" edge-case handling.
// These tests pin: the scene is a structurally separate composition (no
// Between Matches widgets), it never invents data the backend didn't send,
// and it stays honest when the session-scoped match list is capped shorter
// than the true match count.
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

    it("hides MMR for a ranked session with no meaningful rating data yet (never renders a bare '— MMR')", () => {
        // Distinct from the "unranked" case above: gameMode IS ranked, but
        // ratingDelta is null (no rating was ever recorded this session) -
        // per the task, this must omit the block entirely, not show a dash
        // that reads like a broken/missing value.
        const data = buildOverlayData({
            sessionSummary: buildSummary({
                gameMode: "ranked",
                ratingStart: null,
                ratingEnd: null,
                ratingDelta: null,
            }),
        });
        render(<StreamEndedScene data={data} />);

        expect(screen.queryByTestId("mmr-delta")).toBeNull();
        expect(screen.queryByText(/— MMR/)).toBeNull();
    });

    it("renders a zero-match ended session cleanly, with no match history section", () => {
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
        expect(screen.queryByLabelText("История стрима")).toBeNull();
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

    it("renders one entry per session match, oldest to newest, without inventing extra entries", () => {
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

        const grid = screen.getByLabelText("История стрима");
        const entries = grid.querySelectorAll("[title]");
        expect(entries).toHaveLength(3);
        // Reversed to a chronological (oldest -> newest) read.
        expect(entries[0].getAttribute("title")).toBe("Anti-Mage");
        expect(entries[1].getAttribute("title")).toBe("Axe");
        expect(entries[2].getAttribute("title")).toBe("Bane");
        expect(screen.queryByTestId("match-strip-more")).toBeNull();
        // Real StreamMatch fields only - hero, result, K/D/A, MMR delta.
        expect(grid.textContent).toContain("VICTORY");
        expect(grid.textContent).toContain("DEFEAT");
        expect(grid.textContent).toContain("6 / 2 / 10"); // fixture default kills/deaths/assists
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

        expect(screen.getByTestId("match-strip-more").textContent).toContain("3");
        // matchCount stays the honest total, independent of the capped grid.
        expect(screen.getByTestId("match-count").textContent).toBe("8");
        // The "+N" note must not look like another match entry (no hero
        // title/portrait of its own).
        const more = screen.getByTestId("match-strip-more");
        expect(more.getAttribute("title")).not.toMatch(/^(Anti-Mage|Axe|Bane)$/);
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

        const grid = screen.getByLabelText("История стрима");
        expect(grid.querySelectorAll("[title]")).toHaveLength(1);
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
        expect(screen.queryByLabelText("История стрима")).toBeNull();

        const after = buildOverlayData({
            sessionSummary: buildSummary({ wins: 1, losses: 0, matchCount: 1 }),
            matches: [buildMatch({ id: "m1", heroId: 1, result: "win" })],
        });
        rerender(<StreamEndedScene data={after} />);

        expect(screen.getByTestId("match-count").textContent).toBe("1");
        expect(screen.getByLabelText("История стрима")).toBeTruthy();
    });

    it("degrades to an empty shell instead of crashing if sessionSummary is unexpectedly null", () => {
        const data = buildOverlayData({ sessionSummary: null });
        const { getByTestId } = render(<StreamEndedScene data={data} />);
        expect(getByTestId("stream-ended-scene")).toBeTruthy();
    });

    // WK-98 follow-up: adaptive density tiers so 1-20 matches all fit a
    // 1920x1080 canvas without scrolling, per the task's own bands.
    describe("adaptive history density", () => {
        const matchesOf = (count: number) =>
            Array.from({ length: count }, (_, index) => buildMatch({ id: `m${index}`, heroId: (index % 24) + 1 }));

        it.each([
            [1, "spacious"],
            [4, "spacious"],
            [5, "cozy"],
            [8, "cozy"],
            [9, "dense"],
            [14, "dense"],
            [15, "compact"],
            [20, "compact"],
        ])("uses density=%s for %s matches", (count, density) => {
            const data = buildOverlayData({
                sessionSummary: buildSummary({ matchCount: count as number }),
                matches: matchesOf(count as number),
            });
            render(<StreamEndedScene data={data} />);
            expect(screen.getByLabelText("История стрима").getAttribute("data-density")).toBe(density);
        });

        it("caps rendered entries at 20 even when more are available, with the excess as +N", () => {
            const data = buildOverlayData({
                sessionSummary: buildSummary({ matchCount: 23 }),
                matches: matchesOf(23),
            });
            render(<StreamEndedScene data={data} />);

            const grid = screen.getByLabelText("История стрима");
            expect(grid.querySelectorAll("[title]")).toHaveLength(23);
            expect(grid.getAttribute("data-density")).toBe("compact");
        });

        it("does not autoplay hero video at higher densities (perf guard for OBS Browser Source)", () => {
            const spacious = buildOverlayData({
                sessionSummary: buildSummary({ matchCount: 2 }),
                matches: matchesOf(2),
            });
            const { container: spaciousContainer, unmount } = render(<StreamEndedScene data={spacious} />);
            expect(spaciousContainer.querySelectorAll("video").length).toBe(2);
            unmount();

            const compact = buildOverlayData({
                sessionSummary: buildSummary({ matchCount: 15 }),
                matches: matchesOf(15),
            });
            const { container: compactContainer } = render(<StreamEndedScene data={compact} />);
            expect(compactContainer.querySelectorAll("video").length).toBe(0);
            expect(compactContainer.querySelectorAll("img[alt='']").length).toBeGreaterThanOrEqual(15);
        });
    });
});
