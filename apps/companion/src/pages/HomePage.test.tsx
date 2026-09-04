// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchCorrectionControls } from "./HomePage";
import type { LocalMatchSummary } from "../types/status";

afterEach(cleanup);

// WK-151 - -25/-1/+1/+25 granular correction buttons on a match-history row,
// all routed through the same onCorrectDelta callback (correctLocalMatchDelta
// -> correct_match_delta -> cascade_reanchor) as the pre-existing ±25/×2
// controls - no new backend plumbing, only different step multipliers.
const rankedMatch = (overrides: Partial<LocalMatchSummary> = {}): LocalMatchSummary => ({
  localId: "m1",
  matchId: "123",
  heroId: 1,
  result: "win",
  rankedMode: "ranked",
  rankedModeDetected: "ranked",
  state: "finalized",
  ratingBefore: 6_000,
  ratingAfter: 6_025,
  detectedRatingDelta: 25,
  ratingDeltaCorrection: 0,
  kills: 5,
  deaths: 2,
  assists: 10,
  inventory: [],
  startedAt: new Date(0).toISOString(),
  finalizedAt: new Date(0).toISOString(),
  ...overrides,
});

describe("MatchCorrectionControls", () => {
  it("decreases the effective delta by 25 via -25", () => {
    const onCorrectDelta = vi.fn();
    render(
      <MatchCorrectionControls match={rankedMatch()} onCorrectDelta={onCorrectDelta} onCorrectRanked={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Уменьшить дельту на 25" }));
    expect(onCorrectDelta).toHaveBeenCalledWith("m1", 0);
  });

  it("increases the effective delta by 25 via +25", () => {
    const onCorrectDelta = vi.fn();
    render(
      <MatchCorrectionControls match={rankedMatch()} onCorrectDelta={onCorrectDelta} onCorrectRanked={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Увеличить дельту на 25" }));
    expect(onCorrectDelta).toHaveBeenCalledWith("m1", 50);
  });

  it("decreases the effective delta by 1 via -1", () => {
    const onCorrectDelta = vi.fn();
    render(
      <MatchCorrectionControls match={rankedMatch()} onCorrectDelta={onCorrectDelta} onCorrectRanked={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Уменьшить дельту на 1" }));
    expect(onCorrectDelta).toHaveBeenCalledWith("m1", 24);
  });

  it("increases the effective delta by 1 via +1", () => {
    const onCorrectDelta = vi.fn();
    render(
      <MatchCorrectionControls match={rankedMatch()} onCorrectDelta={onCorrectDelta} onCorrectRanked={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Увеличить дельту на 1" }));
    expect(onCorrectDelta).toHaveBeenCalledWith("m1", 26);
  });

  it("×2 still doubles the detected delta and toggles back on a second click", () => {
    const onCorrectDelta = vi.fn();
    const { rerender } = render(
      <MatchCorrectionControls match={rankedMatch()} onCorrectDelta={onCorrectDelta} onCorrectRanked={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "×2" }));
    expect(onCorrectDelta).toHaveBeenCalledWith("m1", 50);

    // simulate the store applying the correction (ratingDeltaCorrection === detected => doubled)
    rerender(
      <MatchCorrectionControls
        match={rankedMatch({ ratingDeltaCorrection: 25 })}
        onCorrectDelta={onCorrectDelta}
        onCorrectRanked={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "×2" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "×2" }));
    expect(onCorrectDelta).toHaveBeenLastCalledWith("m1", 25);
  });

  it("does not render delta controls for an unranked match", () => {
    render(
      <MatchCorrectionControls
        match={rankedMatch({ rankedMode: "unranked", rankedModeDetected: "unranked", detectedRatingDelta: null })}
        onCorrectDelta={vi.fn()}
        onCorrectRanked={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Уменьшить дельту на 25" })).toBeNull();
    expect(screen.queryByRole("button", { name: "×2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Отметить Ranked" })).toBeTruthy();
  });
});
