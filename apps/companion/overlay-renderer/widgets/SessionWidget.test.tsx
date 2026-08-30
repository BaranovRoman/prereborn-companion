// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWidget } from "./SessionWidget";
import type { LocalSessionSummary } from "../types";

const BASE: LocalSessionSummary = {
  hasSession: false,
  startedAt: null,
  ratingStart: null,
  ratingCurrent: null,
  ratingAdjustment: 0,
  sessionDelta: null,
  wins: 0,
  losses: 0,
  currentMatch: null,
  recentMatches: [],
};

afterEach(() => cleanup());

describe("SessionWidget", () => {
  it("renders nothing when no local session is open", () => {
    const { container } = render(<SessionWidget session={BASE} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the win/loss record when a session is open", () => {
    render(<SessionWidget session={{ ...BASE, hasSession: true, wins: 4, losses: 2 }} />);
    expect(screen.getByText("4W")).toBeTruthy();
    expect(screen.getByText("2L")).toBeTruthy();
  });

  it("shows a positive MMR delta with a + sign", () => {
    render(<SessionWidget session={{ ...BASE, hasSession: true, ratingStart: 4200, ratingCurrent: 4260, sessionDelta: 60 }} />);
    expect(screen.getByText("+60 MMR")).toBeTruthy();
  });

  it("shows a negative MMR delta without a double sign", () => {
    render(<SessionWidget session={{ ...BASE, hasSession: true, ratingStart: 4200, ratingCurrent: 4140, sessionDelta: -60 }} />);
    expect(screen.getByText("-60 MMR")).toBeTruthy();
  });

  it("omits the delta line entirely when rating data is unavailable", () => {
    render(<SessionWidget session={{ ...BASE, hasSession: true }} />);
    expect(screen.queryByText(/MMR/)).toBeNull();
  });
});
