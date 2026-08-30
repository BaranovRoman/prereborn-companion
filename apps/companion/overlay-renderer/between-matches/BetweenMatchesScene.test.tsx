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
    expect(screen.getByText(/6025 MMR/)).toBeTruthy();
    expect(screen.getByText("(+25)")).toBeTruthy();
    expect(screen.getByText("1W")).toBeTruthy();
  });

  it("keeps a complete honest layout when recent matches are empty", () => {
    render(<BetweenMatchesScene session={SESSION} />);
    expect(screen.getByLabelText("Нет завершённых матчей")).toBeTruthy();
    expect(screen.queryByText("ПОСЛЕДНИЕ МАТЧИ")).toBeNull();
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
    expect(screen.getByAltText("Pudge")).toBeTruthy();
    expect(screen.getByText("+25 MMR")).toBeTruthy();
    expect(screen.getByText("W")).toBeTruthy();
  });
});
