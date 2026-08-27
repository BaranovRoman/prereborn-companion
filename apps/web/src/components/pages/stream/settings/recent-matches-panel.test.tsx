import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStreamMatch, StreamMatch } from "@/entities/stream-session/model/types";
import { RecentMatchesPanel } from "./recent-matches-panel";
import styles from "./recent-matches-panel.module.scss";

afterEach(cleanup);

// WK-84 regression coverage for the dashboard's "Полная история" list - the
// account-wide Recent Games list WK-83 kept unfiltered across stream
// sessions. Only the previous-session opacity marker is asserted here, not
// literal CSS, per the task's own guidance (test the semantics via
// isMatchFromCurrentSession, keep UI tests minimal).
const accountMatch = (id: string, streamSessionId: string | null): AccountStreamMatch => ({
    id,
    dotaMatchId: id,
    heroId: 1,
    kills: 1,
    deaths: 2,
    assists: 3,
    inventory: [],
    result: "win",
    ratingBefore: 1000,
    ratingDelta: 25,
    ratingAfter: 1025,
    gameMode: "ranked",
    endedAt: new Date(0).toISOString(),
    isRanked: true,
    streamSessionId,
    resultSource: "gsi",
    ratingSource: "default",
    detectedRatingDelta: 25,
    ratingDeltaCorrection: 0,
    correctedAt: null,
    state: "finalized",
});

const compactMatches: StreamMatch[] = [];

// "Полная история" starts collapsed (defaultActiveKey={[]}, see
// recent-matches-panel.tsx) - expand it so the MatchRow list mounts/opens
// before asserting on it.
const expandHistory = () => {
    fireEvent.click(screen.getByText(/Полная история/));
};

describe("RecentMatchesPanel - Полная история opacity", () => {
    it("marks a current-session match with data-session=current (no previous-session class)", () => {
        const { container } = render(
            <RecentMatchesPanel
                recentMatches={compactMatches}
                matches={[accountMatch("d", "session-2")]}
                activeSessionId="session-2"
                onUpdated={() => {}}
            />
        );
        expandHistory();
        const row = container.querySelector(`.${styles.row}`) as HTMLElement;
        expect(row.dataset.session).toBe("current");
        expect(row.className).not.toContain(styles.rowPreviousSession);
    });

    it("marks a previous-session match with data-session=previous and the dimming class", () => {
        const { container } = render(
            <RecentMatchesPanel
                recentMatches={compactMatches}
                matches={[accountMatch("a", "session-1")]}
                activeSessionId="session-2"
                onUpdated={() => {}}
            />
        );
        expandHistory();
        const row = container.querySelector(`.${styles.row}`) as HTMLElement;
        expect(row.dataset.session).toBe("previous");
        expect(row.className).toContain(styles.rowPreviousSession);
    });

    it("renders a mixed current + previous list with only the previous rows dimmed", () => {
        const { container } = render(
            <RecentMatchesPanel
                recentMatches={compactMatches}
                matches={[
                    accountMatch("d", "session-2"),
                    accountMatch("a", "session-1"),
                    accountMatch("b", "session-1"),
                    accountMatch("c", "session-1"),
                ]}
                activeSessionId="session-2"
                onUpdated={() => {}}
            />
        );
        expandHistory();
        const rows = Array.from(container.querySelectorAll(`.${styles.row}`)) as HTMLElement[];
        expect(rows.map((row) => row.dataset.session)).toEqual([
            "current",
            "previous",
            "previous",
            "previous",
        ]);
    });

    it("a new session with no matches yet still shows the previous session's history, all dimmed", () => {
        const { container } = render(
            <RecentMatchesPanel
                recentMatches={[]}
                matches={[accountMatch("a", "session-1"), accountMatch("b", "session-1")]}
                activeSessionId="session-2"
                onUpdated={() => {}}
            />
        );
        expandHistory();
        const rows = Array.from(container.querySelectorAll(`.${styles.row}`)) as HTMLElement[];
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.dataset.session === "previous")).toBe(true);
    });

    it("a new match right after reset is current while the pre-reset matches stay previous", () => {
        const { container } = render(
            <RecentMatchesPanel
                recentMatches={compactMatches}
                matches={[
                    accountMatch("d", "session-2"),
                    accountMatch("a", "session-1"),
                    accountMatch("b", "session-1"),
                    accountMatch("c", "session-1"),
                ]}
                activeSessionId="session-2"
                onUpdated={() => {}}
            />
        );
        expandHistory();
        const rows = Array.from(container.querySelectorAll(`.${styles.row}`)) as HTMLElement[];
        expect(rows[0].dataset.session).toBe("current");
        expect(rows.slice(1).every((row) => row.dataset.session === "previous")).toBe(true);
    });

    it("does not error and defaults matches to current when session data is missing/incomplete", () => {
        const { container } = render(
            <RecentMatchesPanel
                recentMatches={compactMatches}
                matches={[accountMatch("a", null)]}
                activeSessionId={null}
                onUpdated={() => {}}
            />
        );
        expandHistory();
        const row = container.querySelector(`.${styles.row}`) as HTMLElement;
        expect(row.dataset.session).toBe("current");
    });
});
