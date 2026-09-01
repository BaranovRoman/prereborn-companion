// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecentMatchesWidget } from "./RecentMatchesWidget";
import type { LocalMatchSummary } from "../types";

function match(overrides: Partial<LocalMatchSummary> = {}): LocalMatchSummary {
  return {
    matchId: "123",
    heroId: 14, // Pudge
    result: "win",
    rankedMode: "ranked",
    state: "finalized",
    ratingBefore: 4200,
    ratingAfter: 4225,
    kills: 10,
    deaths: 2,
    assists: 15,
    inventory: [],
    startedAt: "2026-08-30T10:00:00Z",
    finalizedAt: "2026-08-30T10:40:00Z",
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("RecentMatchesWidget", () => {
  it("renders nothing when there are no finalized matches", () => {
    const { container } = render(<RecentMatchesWidget matches={[]} />);
    expect(container.firstChild).toBeNull();
  });

  // An in-progress match (result: null) must never reach this widget in
  // practice - local_runtime::summary already excludes it from
  // recentMatches - but the widget itself must not render a broken/blank
  // entry for one if it ever did.
  it("excludes an in-progress match (no result yet) from the rendered list", () => {
    const { container } = render(
      <RecentMatchesWidget matches={[match({ result: null, ratingAfter: null })]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a win with a positive MMR delta", () => {
    render(<RecentMatchesWidget matches={[match({ result: "win", ratingBefore: 4200, ratingAfter: 4225 })]} />);
    expect(screen.getByText("+25")).toBeTruthy();
  });

  it("shows a loss with a negative MMR delta", () => {
    render(<RecentMatchesWidget matches={[match({ result: "loss", ratingBefore: 4200, ratingAfter: 4170 })]} />);
    expect(screen.getByText("-30")).toBeTruthy();
  });

  it("omits the delta for a match with no rating data, without crashing", () => {
    render(<RecentMatchesWidget matches={[match({ ratingBefore: null, ratingAfter: null })]} />);
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it("renders one entry per finalized match, in the given order", () => {
    render(
      <RecentMatchesWidget
        matches={[
          match({ matchId: "1", heroId: 14, result: "win", ratingBefore: 4200, ratingAfter: 4225 }),
          match({ matchId: "2", heroId: 1, result: "loss", ratingBefore: 4225, ratingAfter: 4195 }),
        ]}
      />
    );
    expect(screen.getByText("+25")).toBeTruthy();
    expect(screen.getByText("-30")).toBeTruthy();
  });
});
