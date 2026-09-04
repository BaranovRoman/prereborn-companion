import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamMatch } from "@/entities/stream-session/model/types";
import { RecentGames } from "./queue-scene-ui";
import styles from "./queue-scene.module.scss";

afterEach(cleanup);

// WK-84 regression coverage for the "Between Matches" Recent Games widget
// (the account-wide history fallback path, see isMatchFromCurrentSession) -
// deliberately not asserting literal CSS values here, only the data-session
// marker the stylesheet keys off (см. queue-scene.module.scss
// .gameRow[data-session="previous"]).
const match = (id: string, streamSessionId: string | null): StreamMatch => ({
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
    streamSessionId,
});

const baseProps = {
    email: null,
    gameMode: null,
    rating: null,
    wins: 0,
    losses: 0,
    steamConnected: false,
    steamId: undefined,
    steamSyncStatus: null,
    steamProfile: undefined,
    twitch: null,
    donationAlerts: null,
    webcamImageUrl: null,
    channelGoal: { type: "none" as const, label: "", startValue: 0, targetValue: 0 },
    openDota: null,
};

describe("RecentGames (Between Matches)", () => {
    it("renders a current-session match at full opacity (no previous-session marker)", () => {
        const { container } = render(
            <RecentGames
                {...baseProps}
                matches={[match("d", "session-2")]}
                activeSessionId="session-2"
                title="Recent Games"
                limit={5}
            />
        );
        const row = container.querySelector(`.${styles.gameRow}`) as HTMLElement;
        expect(row.dataset.session).toBe("current");
    });

    it("renders a previous-session match with the previous-session marker", () => {
        const { container } = render(
            <RecentGames
                {...baseProps}
                matches={[match("a", "session-1")]}
                activeSessionId="session-2"
                title="Recent Games"
                limit={5}
            />
        );
        const row = container.querySelector(`.${styles.gameRow}`) as HTMLElement;
        expect(row.dataset.session).toBe("previous");
    });

    it("renders a mixed list with only the previous-session rows marked", () => {
        const { container } = render(
            <RecentGames
                {...baseProps}
                matches={[
                    match("d", "session-2"),
                    match("a", "session-1"),
                    match("b", "session-1"),
                    match("c", "session-1"),
                ]}
                activeSessionId="session-2"
                title="Recent Games"
                limit={5}
            />
        );
        const rows = Array.from(container.querySelectorAll(`.${styles.gameRow}`)) as HTMLElement[];
        expect(rows.map((row) => row.dataset.session)).toEqual([
            "current",
            "previous",
            "previous",
            "previous",
        ]);
    });

    it("a new empty session still shows the previous session's matches, all marked previous", () => {
        const { container } = render(
            <RecentGames
                {...baseProps}
                matches={[match("a", "session-1"), match("b", "session-1")]}
                activeSessionId="session-2"
                title="Recent Games"
                limit={5}
            />
        );
        const rows = Array.from(container.querySelectorAll(`.${styles.gameRow}`)) as HTMLElement[];
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.dataset.session === "previous")).toBe(true);
    });

    it("does not error and defaults to current when session data is missing/incomplete", () => {
        const { container } = render(
            <RecentGames
                {...baseProps}
                matches={[match("a", null)]}
                activeSessionId={null}
                title="Recent Games"
                limit={5}
            />
        );
        const row = container.querySelector(`.${styles.gameRow}`) as HTMLElement;
        expect(row.dataset.session).toBe("current");
    });

    // WK-152 - result semantics: ranked shows only the actual effective
    // rating delta (never assumed ±25), unranked (no rating delta) shows W/L
    // instead. Portrait alone identifies the hero - the name is never
    // rendered as text.
    describe("result cell semantics (WK-152)", () => {
        it("ranked positive delta shows the numeric delta, colored positive", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[match("a", "s1")]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const strong = container.querySelector(`.${styles.gameRow} > strong`) as HTMLElement;
            expect(strong.textContent).toBe("+25");
            expect(strong.dataset.positive).toBe("true");
        });

        it("ranked negative delta shows the numeric delta, colored negative", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[{ ...match("a", "s1"), result: "loss", ratingDelta: -25, ratingAfter: 975 }]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const strong = container.querySelector(`.${styles.gameRow} > strong`) as HTMLElement;
            expect(strong.textContent).toBe("-25");
            expect(strong.dataset.positive).toBe("false");
        });

        it("a non-standard ranked delta (manual correction) shows the real stored value, not an assumed ±25", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[{ ...match("a", "s1"), ratingDelta: 50, ratingAfter: 1050 }]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const strong = container.querySelector(`.${styles.gameRow} > strong`) as HTMLElement;
            expect(strong.textContent).toBe("+50");
        });

        it("unranked win shows W, colored positive, not a rating delta", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[{ ...match("a", "s1"), gameMode: "unranked", ratingDelta: null, ratingBefore: null, ratingAfter: null }]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const strong = container.querySelector(`.${styles.gameRow} > strong`) as HTMLElement;
            expect(strong.textContent).toBe("W");
            expect(strong.dataset.positive).toBe("true");
        });

        it("unranked loss shows L, colored negative", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[{ ...match("a", "s1"), gameMode: "unranked", result: "loss", ratingDelta: null, ratingBefore: null, ratingAfter: null }]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const strong = container.querySelector(`.${styles.gameRow} > strong`) as HTMLElement;
            expect(strong.textContent).toBe("L");
            expect(strong.dataset.positive).toBe("false");
        });

        // Caught in visual QA: without spaces "8/3/14" reads like a date, not
        // a K/D/A triple - especially now the "KDA " label is gone.
        it("renders K/D/A with spaces around the slashes, not run together", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[{ ...match("a", "s1"), kills: 8, deaths: 3, assists: 14 }]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const kda = container.querySelector(`.${styles.gameKda}`) as HTMLElement;
            expect(kda.textContent).toBe("8 / 3 / 14");
        });

        it("never renders the hero's localized name as text - the portrait is the only hero identifier", () => {
            const { container } = render(
                <RecentGames
                    {...baseProps}
                    matches={[match("a", "s1")]}
                    activeSessionId="s1"
                    title="Recent Games"
                    limit={5}
                />
            );
            const row = container.querySelector(`.${styles.gameRow}`) as HTMLElement;
            expect(row.querySelector("b")).toBeNull();
            expect(row.querySelector(`.${styles.gameHeroImage}`)).toBeTruthy();
        });
    });
});
