// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSessionSummary } from "../types";
import { BetweenMatchesScene } from "./BetweenMatchesScene";

const SESSION: LocalSessionSummary = {
  hasSession: true,
  startedAt: "2026-08-30T12:00:00Z",
  ratingStart: 6_000,
  ratingCurrent: 6_025,
  ratingAdjustment: 0,
  sessionDelta: 25,
  wins: 1,
  losses: 0,
  currentMatch: null,
  recentMatches: [],
};

afterEach(() => cleanup());

describe("BetweenMatchesScene", () => {
  it("renders authoritative current MMR and match-only session delta", () => {
    render(<BetweenMatchesScene session={SESSION} />);
    expect(screen.getByText("6,025")).toBeTruthy();
    expect(screen.getByText(/6000 → 6025 \(\+25\)/)).toBeTruthy();
    expect(screen.getByText("1–0")).toBeTruthy();
    expect(screen.getByLabelText("LAST MATCH")).toBeTruthy();
    expect(screen.getByLabelText("FAVORITE HEROES")).toBeTruthy();
    expect(screen.getByLabelText("RECENT GAMES")).toBeTruthy();
    expect(screen.queryByLabelText("LIVE CAPTURE")).toBeNull();
    expect(screen.queryByLabelText("TWITCH CHAT")).toBeNull();
  });

  it("keeps a complete honest layout when recent matches are empty", () => {
    render(<BetweenMatchesScene session={SESSION} />);
    expect(screen.getByText("Match history is empty")).toBeTruthy();
    expect(screen.getAllByText("No completed matches").length).toBeGreaterThan(0);
    expect(screen.queryByText("VICTORY")).toBeNull();
  });

  it("shows a finalized recent match with its real hero, result and MMR delta", () => {
    render(<BetweenMatchesScene session={{
      ...SESSION,
      recentMatches: [{
        matchId: "42",
        heroId: 14,
        result: "win",
        rankedMode: "ranked",
        state: "finalized",
        ratingBefore: 6_000,
        ratingAfter: 6_025,
        startedAt: "2026-08-30T12:00:00Z",
        finalizedAt: "2026-08-30T12:40:00Z",
      }],
    }} />);
    expect(screen.getAllByText(/PUDGE/i).length).toBeGreaterThan(0);
    expect(screen.getByText("+25 MMR")).toBeTruthy();
    expect(screen.getAllByText("VICTORY").length).toBeGreaterThan(0);
  });

  it("updates authoritative SSE-driven values without remounting the scene", () => {
    const view = render(<BetweenMatchesScene session={SESSION} />);
    view.rerender(<BetweenMatchesScene session={{ ...SESSION, ratingCurrent: 5_975, sessionDelta: -25, wins: 1, losses: 1 }} />);
    expect(screen.getByText("5,975")).toBeTruthy();
    expect(screen.getByText(/6000 → 5975 \(-25\)/)).toBeTruthy();
    expect(screen.getByText("1–1")).toBeTruthy();
  });
});
