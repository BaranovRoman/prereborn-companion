// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSessionSummary, QueueSettings } from "../types";
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

const SETTINGS = {
  version: 2,
  visibility: { playerProfile: false, streamProfile: false, featuredMatch: false, webcam: false, favoriteHeroes: false, recentGames: false, twitchChat: false, systemStatus: false },
  favoriteHeroIds: [], webcamImageUrl: null,
  channelGoal: { type: "rating", label: "RATING GOAL", startValue: 5_964, targetValue: 6_200 },
  widgets: { titles: { playerProfile: "wrong", streamProfile: "wrong", featuredMatch: "wrong", webcam: "wrong", favoriteHeroes: "wrong", recentGames: "wrong", twitchChat: "wrong", friends: "wrong" }, recentGamesLimit: 5, chatMessagesLimit: 5, friends: { showDonaters: false, showSubscribers: false, showFollowers: false, socialLinks: [] } },
} satisfies QueueSettings;

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
    expect(screen.getByLabelText("LIVE CAPTURE")).toBeTruthy();
    expect(screen.getByText("FALLBACK NOT SET")).toBeTruthy();
    expect(screen.getByLabelText("TWITCH CHAT")).toBeTruthy();
  });

  it("keeps a complete honest layout when recent matches are empty", () => {
    render(<BetweenMatchesScene session={SESSION} />);
    expect(screen.getByText("Match history is empty")).toBeTruthy();
    expect(screen.getAllByText("No completed matches").length).toBeGreaterThan(0);
    expect(screen.queryByText("VICTORY")).toBeNull();
  });

  it("keeps the fixed production blocks and computes a rating goal from its persisted start", () => {
    const { container } = render(<BetweenMatchesScene session={{ ...SESSION, ratingStart: 6_000, ratingCurrent: 5_989 }} settings={SETTINGS} />);
    expect(screen.getByLabelText("PLAYER PROFILE")).toBeTruthy();
    expect(screen.getByLabelText("STREAM PROFILE")).toBeTruthy();
    expect(screen.getByText("5964 · 5989 → 6200")).toBeTruthy();
    expect(parseFloat((container.querySelector("[class*='goalTrack'] > i") as HTMLElement).style.width)).toBeCloseTo(10.5932, 4);
    expect(screen.queryByLabelText("wrong")).toBeNull();
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
        kills: 12,
        deaths: 4,
        assists: 18,
        inventory: ["item_blink", null, null, null, null, null, "item_tpscroll", null, null],
        startedAt: "2026-08-30T12:00:00Z",
        finalizedAt: "2026-08-30T12:40:00Z",
      }],
    }} />);
    expect(screen.getAllByText(/PUDGE/i).length).toBeGreaterThan(0);
    expect(screen.getByText("+25 MMR")).toBeTruthy();
    expect(screen.getAllByText("VICTORY").length).toBeGreaterThan(0);
    expect(screen.getByText("12 / 4 / 18")).toBeTruthy();
    expect(screen.getByTitle("blink")).toBeTruthy();
  });

  it("gracefully renders a legacy finalized match without invented KDA or items", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ matchId: "legacy", heroId: 14, result: "loss", rankedMode: "ranked", state: "finalized", ratingBefore: 6025, ratingAfter: 6000, kills: null, deaths: null, assists: null, inventory: [], startedAt: "2026-08-20T12:00:00Z", finalizedAt: "2026-08-20T12:40:00Z" }] }} />);
    expect(screen.getAllByText("DEFEAT").length).toBeGreaterThan(0);
    expect(screen.queryByText(/KDA \d/)).toBeNull();
    expect(screen.queryByTitle("blink")).toBeNull();
  });

  it("renders the existing normalized Twitch chat state", () => {
    render(<BetweenMatchesScene session={SESSION} settings={SETTINGS} twitchChat={{
      accountConnected: true, configured: true, displayName: "channel", connected: true, state: "connected",
      messages: [
        { id: "1", author: "Alice", color: "#ff0000", text: "first", receivedAt: "2026-08-30T12:00:00Z" },
        { id: "2", author: "Bob", color: null, text: "second", receivedAt: "2026-08-30T12:00:01Z" },
      ],
    }} />);
    expect(screen.getByLabelText("TWITCH CHAT")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText(/first/)).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("updates authoritative SSE-driven values without remounting the scene", () => {
    const view = render(<BetweenMatchesScene session={SESSION} />);
    view.rerender(<BetweenMatchesScene session={{ ...SESSION, ratingCurrent: 5_975, sessionDelta: -25, wins: 1, losses: 1 }} />);
    expect(screen.getByText("5,975")).toBeTruthy();
    expect(screen.getByText(/6000 → 5975 \(-25\)/)).toBeTruthy();
    expect(screen.getByText("1–1")).toBeTruthy();
  });

  it("renders authenticated Steam and Twitch identity instead of local placeholders", () => {
    render(<BetweenMatchesScene session={SESSION} account={{
      steam: { connected: true, profile: { displayName: "Roman", avatarUrl: "https://example.com/steam.png", profileUrl: null } },
      twitch: { connected: true, login: "romaromych", displayName: "RomaRomych", profileImageUrl: "https://example.com/twitch.png", live: { title: "Ranked grind", viewerCount: 42, gameName: "Dota 2" } },
    }} />);
    expect(screen.getByText("Roman")).toBeTruthy();
    expect(screen.getByText("RomaRomych")).toBeTruthy();
    expect(screen.getByText("Ranked grind")).toBeTruthy();
    expect(screen.getByText("42 LIVE")).toBeTruthy();
    expect(screen.queryByText("LOCAL SESSION")).toBeNull();
  });

  it("binds existing Twitch followers and DonationAlerts donors to the legacy community block", () => {
    render(<BetweenMatchesScene session={SESSION} settings={{ ...SETTINGS, widgets: { ...SETTINGS.widgets, friends: { ...SETTINGS.widgets.friends, showDonaters: true, showFollowers: true } } }} account={{
      twitch: { connected: true, recentFollowers: [{ id: "f1", name: "NewFollower" }] },
      donationAlerts: { connected: true, topDonors: [{ username: "TopDonor", amount: 1500, currency: "RUB" }] },
    }} />);
    expect(screen.getByText("Recent followers")).toBeTruthy();
    expect(screen.getByText("NewFollower")).toBeTruthy();
    expect(screen.getByText("Donaters")).toBeTruthy();
    expect(screen.getByText("TopDonor")).toBeTruthy();
  });
});
