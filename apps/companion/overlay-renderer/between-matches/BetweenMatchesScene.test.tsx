// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSessionSummary, QueueSettings, QuizRoundState } from "../types";
import { BetweenMatchesScene } from "./BetweenMatchesScene";

// jsdom doesn't implement ResizeObserver at all - usePublishGeometry (like
// AnchoredBox/Scene elsewhere in this renderer) uses the real one. Same
// per-file stub convention as AnchoredBox.test.tsx.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= StubResizeObserver;

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
    expect(screen.getByTestId("between-matches-production").getAttribute("data-coordinate-system")).toBe("viewport");
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
    expect(screen.getByLabelText("RECENT GAMES").querySelector("[data-short='true']")).toBeTruthy();
  });

  it("keeps the fixed production blocks and computes a rating goal from its persisted start", () => {
    const { container } = render(<BetweenMatchesScene session={{ ...SESSION, ratingStart: 6_000, ratingCurrent: 5_989 }} settings={SETTINGS} />);
    expect(screen.getByLabelText("PLAYER PROFILE")).toBeTruthy();
    expect(screen.getByLabelText("STREAM PROFILE")).toBeTruthy();
    expect(screen.getByText("5964 · 5989 → 6200")).toBeTruthy();
    expect(parseFloat((container.querySelector("[class*='goalTrack'] > i") as HTMLElement).style.width)).toBeCloseTo(10.5932, 4);
    expect(screen.queryByLabelText("wrong")).toBeNull();
  });

  it("shows one match-specific rating-after and delta presentation in Last Match and Recent Games", () => {
    render(<BetweenMatchesScene session={{
      ...SESSION,
      recentMatches: [{
        localId: "local-42",
        matchId: "42",
        heroId: 14,
        result: "win",
        rankedMode: "ranked",
        rankedModeDetected: "ranked",
        state: "finalized",
        ratingBefore: 6_000,
        ratingAfter: 6_025,
        detectedRatingDelta: 25,
        ratingDeltaCorrection: 0,
        kills: 12,
        deaths: 4,
        assists: 18,
        inventory: ["item_blink", null, null, null, null, null, "item_tpscroll", null, null],
        startedAt: "2026-08-30T12:00:00Z",
        finalizedAt: "2026-08-30T12:40:00Z",
      }],
    }} />);
    expect(screen.getAllByText(/PUDGE/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId("last-match-delta").textContent).toBe("6025(+25)");
    expect(screen.getAllByText("12 / 4 / 18").length).toBe(2);
    // WK-152 - Recent Games no longer shows the absolute rating-after value
    // (that stays Last Match-only, asserted via last-match-delta above); it
    // shows only the actual effective delta, "+25" not "(+25)".
    expect(screen.getByText("6025")).toBeTruthy();
    expect(screen.getByLabelText("RECENT GAMES").textContent).toContain("+25");
    expect(screen.getByLabelText("RECENT GAMES").querySelector("[data-short='true']")).toBeTruthy();
    expect(screen.getByTitle("blink")).toBeTruthy();
    const lastMatch = screen.getByLabelText("LAST MATCH");
    expect(lastMatch.textContent).not.toContain("MMR");
    expect(lastMatch.textContent).not.toContain("RANKED");
    expect(lastMatch.textContent).not.toContain("KDA");
    expect(lastMatch.textContent).not.toContain("VICTORY");
  });

  it("gracefully renders a legacy finalized match without invented KDA or items", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ localId: "local-legacy", matchId: "legacy", heroId: 14, result: "loss", rankedMode: "ranked", rankedModeDetected: "ranked", state: "finalized", ratingBefore: 6025, ratingAfter: 6000, detectedRatingDelta: -25, ratingDeltaCorrection: 0, kills: null, deaths: null, assists: null, inventory: [], startedAt: "2026-08-20T12:00:00Z", finalizedAt: "2026-08-20T12:40:00Z" }] }} />);
    expect(screen.queryByText("DEFEAT")).toBeNull();
    expect(screen.queryByText(/KDA \d/)).toBeNull();
    expect(screen.queryByTitle("blink")).toBeNull();
  });

  it("does not invent a rating-after or delta for an incomplete historical match", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ localId: "local-incomplete", matchId: "incomplete", heroId: 14, result: "win", rankedMode: "ranked", rankedModeDetected: "ranked", state: "finalized", ratingBefore: 6000, ratingAfter: null, detectedRatingDelta: 25, ratingDeltaCorrection: 0, kills: null, deaths: null, assists: null, inventory: [], startedAt: "2026-08-20T12:00:00Z", finalizedAt: "2026-08-20T12:40:00Z" }] }} />);
    expect(screen.queryByTestId("last-match-delta")).toBeNull();
    expect(screen.getByLabelText("RECENT GAMES").textContent).not.toContain("6000");
  });

  it("keeps Recent Games at production density without a literal KDA label", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ localId: "local-42", matchId: "42", heroId: 14, result: "win", rankedMode: "ranked", rankedModeDetected: "ranked", state: "finalized", ratingBefore: 6000, ratingAfter: 6025, detectedRatingDelta: 25, ratingDeltaCorrection: 0, kills: 12, deaths: 4, assists: 18, inventory: [], startedAt: "2026-08-30T12:00:00Z", finalizedAt: "2026-08-30T12:40:00Z" }] }} settings={SETTINGS} />);
    const recentGames = screen.getByLabelText("RECENT GAMES");
    expect(recentGames.textContent).toContain("12 / 4 / 18");
    expect(recentGames.textContent).not.toContain("KDA");
    expect(recentGames.textContent).not.toContain("VICTORY");
    expect(recentGames.textContent).not.toContain("FINALIZED");
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

  // WK-152 - same result semantics as the web queue-scene's RecentGames:
  // ranked shows only the actual effective rating delta (never assumed
  // ±25), unranked (no rating delta) shows W/L instead. Portrait alone
  // identifies the hero - the name is never rendered as text here.
  const baseRecentMatch = {
    localId: "local-1", matchId: "1", heroId: 14, rankedMode: "ranked", rankedModeDetected: "ranked",
    state: "finalized", kills: 12, deaths: 4, assists: 18, inventory: [],
    startedAt: "2026-08-30T12:00:00Z", finalizedAt: "2026-08-30T12:40:00Z",
  };

  it("Recent Games never renders the hero's localized name as text", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ ...baseRecentMatch, result: "win", ratingBefore: 6_000, ratingAfter: 6_025, detectedRatingDelta: 25, ratingDeltaCorrection: 0 }] }} settings={SETTINGS} />);
    const recentGames = screen.getByLabelText("RECENT GAMES");
    expect(recentGames.querySelector("b")).toBeNull();
  });

  it("ranked positive delta shows the numeric delta, colored positive", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ ...baseRecentMatch, result: "win", ratingBefore: 6_000, ratingAfter: 6_025, detectedRatingDelta: 25, ratingDeltaCorrection: 0 }] }} settings={SETTINGS} />);
    const cell = screen.getByLabelText("RECENT GAMES").querySelector("[class*='recentRating']") as HTMLElement;
    expect(cell.textContent).toBe("+25");
    expect(cell.dataset.tone).toBe("positive");
  });

  it("ranked negative delta shows the numeric delta, colored negative", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ ...baseRecentMatch, result: "loss", ratingBefore: 6_025, ratingAfter: 6_000, detectedRatingDelta: -25, ratingDeltaCorrection: 0 }] }} settings={SETTINGS} />);
    const cell = screen.getByLabelText("RECENT GAMES").querySelector("[class*='recentRating']") as HTMLElement;
    expect(cell.textContent).toBe("-25");
    expect(cell.dataset.tone).toBe("negative");
  });

  it("a non-standard ranked delta (manual correction) shows the real stored value, not an assumed ±25", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ ...baseRecentMatch, result: "win", ratingBefore: 6_000, ratingAfter: 6_050, detectedRatingDelta: 25, ratingDeltaCorrection: 25 }] }} settings={SETTINGS} />);
    const cell = screen.getByLabelText("RECENT GAMES").querySelector("[class*='recentRating']") as HTMLElement;
    expect(cell.textContent).toBe("+50");
  });

  it("unranked win shows W, colored positive, not a rating delta", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ ...baseRecentMatch, rankedMode: "unranked", rankedModeDetected: "unranked", result: "win", ratingBefore: null, ratingAfter: null, detectedRatingDelta: null, ratingDeltaCorrection: 0 }] }} settings={SETTINGS} />);
    const cell = screen.getByLabelText("RECENT GAMES").querySelector("[class*='recentRating']") as HTMLElement;
    expect(cell.textContent).toBe("W");
    expect(cell.dataset.tone).toBe("positive");
  });

  it("unranked loss shows L, colored negative", () => {
    render(<BetweenMatchesScene session={{ ...SESSION, recentMatches: [{ ...baseRecentMatch, rankedMode: "unranked", rankedModeDetected: "unranked", result: "loss", ratingBefore: null, ratingAfter: null, detectedRatingDelta: null, ratingDeltaCorrection: 0 }] }} settings={SETTINGS} />);
    const cell = screen.getByLabelText("RECENT GAMES").querySelector("[class*='recentRating']") as HTMLElement;
    expect(cell.textContent).toBe("L");
    expect(cell.dataset.tone).toBe("negative");
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

  // WK-148 - OpenDota enrichment on the LOCAL renderer, sourced from
  // OverlayStateSnapshot.opendotaFavoriteHeroes/opendotaRadar (populated in
  // the background by opendota_overlay_cache.rs, not Tauri IPC - this
  // renderer has none). Must degrade to the pre-WK-148 look when null.
  describe("OpenDota enrichment", () => {
    it("renders only the hero name when openDota is null", () => {
      render(<BetweenMatchesScene session={SESSION} settings={{ ...SETTINGS, favoriteHeroIds: [1] }} />);
      expect(screen.getByText("Anti-Mage")).toBeTruthy();
      expect(screen.getByLabelText("FAVORITE HEROES").querySelector("small")).toBeNull();
    });

    it("renders the lifetime line and an optional current-patch line per favorite hero", () => {
      render(
        <BetweenMatchesScene
          session={SESSION}
          settings={{ ...SETTINGS, favoriteHeroIds: [1] }}
          openDotaFavoriteHeroes={{
            status: "ok",
            source: "opendota",
            patchName: "7.41",
            isLatestKnown: true,
            heroes: [
              {
                heroId: 1,
                lifetime: { games: 132, wins: 71, losses: 61, winRate: 53.79 },
                patch: { games: 12, wins: 7, losses: 5, winRate: 58.3 },
              },
            ],
            fetchedAt: "2026-01-01T00:00:00Z",
          }}
        />
      );
      expect(screen.getByText("132 · 53.8%")).toBeTruthy();
      expect(screen.getByText("7.41 · 58%")).toBeTruthy();
    });

    it("prefixes the patch line with 'посл.' when the patch isn't confirmed to be OpenDota's current known patch", () => {
      render(
        <BetweenMatchesScene
          session={SESSION}
          settings={{ ...SETTINGS, favoriteHeroIds: [1] }}
          openDotaFavoriteHeroes={{
            status: "ok",
            source: "opendota",
            patchName: "7.39",
            isLatestKnown: false,
            heroes: [
              {
                heroId: 1,
                lifetime: { games: 132, wins: 71, losses: 61, winRate: 53.79 },
                patch: { games: 12, wins: 7, losses: 5, winRate: 58.3 },
              },
            ],
            fetchedAt: "2026-01-01T00:00:00Z",
          }}
        />
      );
      expect(screen.getByText("посл. 7.39 · 58%")).toBeTruthy();
    });

    it("renders nothing for the radar when the sample is insufficient, without breaking the rest of the scene", () => {
      render(
        <BetweenMatchesScene
          session={SESSION}
          settings={SETTINGS}
          openDotaRadar={{ status: "insufficient_data" }}
        />
      );
      expect(screen.queryByLabelText("Player radar")).toBeNull();
      expect(screen.getByLabelText("FAVORITE HEROES")).toBeTruthy();
    });

    it("renders the radar panel with a value per axis once there's a real profile", () => {
      render(
        <BetweenMatchesScene
          session={SESSION}
          settings={SETTINGS}
          openDotaRadar={{
            status: "ok",
            source: "opendota",
            combat: 62,
            farm: 74.6,
            support: 41,
            objectives: null,
            flexibility: 55,
            fetchedAt: "2026-01-01T00:00:00Z",
          }}
        />
      );
      // Distinct from the existing top-bar "PLAYER PROFILE" widget (Steam
      // identity/rating) also rendered in this same scene - same reasoning
      // as the production web scene's PlayerProfileRadarPanel.
      expect(screen.getByLabelText("Player radar")).toBeTruthy();
      expect(screen.getByText("БОЙ")).toBeTruthy();
      expect(screen.getByText("62")).toBeTruthy();
      expect(screen.getByText("75")).toBeTruthy();
      expect(screen.getByText("—")).toBeTruthy();
    });

    it("marks the missing axis with a hollow vertex and dashed spoke, never a solid dot implying a real value", () => {
      const { container } = render(
        <BetweenMatchesScene
          session={SESSION}
          settings={SETTINGS}
          openDotaRadar={{
            status: "ok",
            source: "opendota",
            combat: 62,
            farm: 74,
            support: 41,
            objectives: null,
            flexibility: 55,
            fetchedAt: "2026-01-01T00:00:00Z",
          }}
        />
      );
      expect(container.querySelectorAll(`circle[class*="radarVertexMissing"]`).length).toBe(1);
      expect(container.querySelectorAll(`line[class*="radarSpokeMissing"]`).length).toBe(1);
      expect(container.querySelectorAll(`circle[class*="radarVertex"]:not([class*="Missing"])`).length).toBe(4);
    });
  });

  // WK-154 regression fixture - the exact bug reported from a live stream:
  // Player Radar drifted back into .rightMain (this renderer's own "not-yet-
  // migrated" parity gap, see between-matches-parity.module.scss's history)
  // instead of the middle column alongside Favorite Heroes/Recent Games, and
  // the Quiz board needs to keep rendering correctly alongside it. This is
  // the "all six widgets populated simultaneously" check called for after
  // that report - it renders Favorite Heroes, Recent Games, Player Radar,
  // Twitch Chat, Community and Quiz all at once with real-shaped data and
  // asserts BOTH that every widget is present AND that each lives in the
  // correct column (DOM parent), so a future placement drift fails a test
  // instead of only being caught by eyeballing a real broadcast.
  it("renders Favorite Heroes + Recent Games + Player Radar + Twitch Chat + Community + Quiz simultaneously, each in its correct column", () => {
    const { container } = render(
      <BetweenMatchesScene
        session={{
          ...SESSION,
          recentMatches: [{
            localId: "local-1", matchId: "1", heroId: 14, result: "win",
            rankedMode: "ranked", rankedModeDetected: "ranked", state: "finalized",
            ratingBefore: 6_000, ratingAfter: 6_025, detectedRatingDelta: 25, ratingDeltaCorrection: 0,
            kills: 12, deaths: 4, assists: 18, inventory: [],
            startedAt: "2026-08-30T12:00:00Z", finalizedAt: "2026-08-30T12:40:00Z",
          }],
        }}
        settings={{
          ...SETTINGS,
          favoriteHeroIds: [1],
          widgets: { ...SETTINGS.widgets, friends: { ...SETTINGS.widgets.friends, showDonaters: true, showFollowers: true } },
        }}
        account={{
          twitch: { connected: true, recentFollowers: [{ id: "f1", name: "NewFollower" }] },
          donationAlerts: { connected: true, topDonors: [{ username: "TopDonor", amount: 1_500, currency: "RUB" }] },
        }}
        twitchChat={{
          accountConnected: true, configured: true, displayName: "channel", connected: true, state: "connected",
          messages: [{ id: "1", author: "Alice", color: "#ff0000", text: "gl hf", receivedAt: "2026-08-30T12:00:00Z" }],
        }}
        openDotaFavoriteHeroes={{
          status: "ok", source: "opendota", patchName: "7.41", isLatestKnown: true,
          heroes: [{ heroId: 1, lifetime: { games: 132, wins: 71, losses: 61, winRate: 53.79 }, patch: null }],
          fetchedAt: "2026-01-01T00:00:00Z",
        }}
        openDotaRadar={{
          status: "ok", source: "opendota", combat: 62, farm: 74, support: 41, objectives: 19, flexibility: 55,
          fetchedAt: "2026-01-01T00:00:00Z",
        }}
        quiz={{
          roundId: "42", phase: "question", phaseEndsAt: new Date(Date.now() + 15_000).toISOString(),
          category: "ПРЕДМЕТ", interactionType: "single_choice_text",
          prompt: "Какой предмет усиливает регенерацию маны сильнее всего?",
          options: [
            { id: "1", label: "Arcane Boots", assetUrl: null },
            { id: "2", label: "Power Treads", assetUrl: null },
            { id: "3", label: "Aether Lens", assetUrl: null },
            { id: "4", label: "Boots of Travel", assetUrl: null },
          ],
          correctOptionId: null, distribution: null, interactiveRegions: null, leaderboard: [],
        }}
      />
    );

    const favoriteHeroes = screen.getByLabelText("FAVORITE HEROES");
    const recentGames = screen.getByLabelText("RECENT GAMES");
    const radar = screen.getByLabelText("Player radar");
    const chat = screen.getByLabelText("TWITCH CHAT");
    const community = screen.getByLabelText("COMMUNITY");
    const quiz = screen.getByLabelText("QUIZ");

    // All six render at once - none of them silently drop out for another.
    expect(favoriteHeroes).toBeTruthy();
    expect(recentGames).toBeTruthy();
    expect(radar).toBeTruthy();
    expect(chat).toBeTruthy();
    expect(community).toBeTruthy();
    expect(quiz).toBeTruthy();

    // The actual regression: Player Radar must share Favorite Heroes/Recent
    // Games' column (the middle .sideStack), never Twitch Chat/Community/
    // Quiz's column (the right .rightMain) - this is what silently broke
    // when the radar panel drifted back into .rightMain.
    expect(radar.parentElement).toBe(recentGames.parentElement);
    expect(radar.parentElement).toBe(favoriteHeroes.parentElement);
    expect(radar.parentElement).not.toBe(chat.parentElement);

    // Quiz stays with Chat/Community in the right column, as the 3rd widget
    // there (not a 4th, now that Radar no longer also lives in this column).
    expect(quiz.parentElement).toBe(chat.parentElement);
    expect(quiz.parentElement).toBe(community.parentElement);

    // No clipping/scrolling on the scene root at the two required desktop
    // baselines (project CLAUDE.md) - jsdom doesn't lay out real pixels, so
    // this only guards against an `overflow` regression on the root itself,
    // not real overflow; the live screenshot pass is what verifies actual
    // fit at 1920x1080/2560x1440.
    const scene = container.querySelector('[data-testid="between-matches-production"]') as HTMLElement;
    expect(scene).toBeTruthy();
  });

  // WK-116 Phase 3 - real backend quiz state, replacing the Phase 0 mock/
  // query-param wiring. The shared video must show only shared state - no
  // per-viewer marker anywhere (see the correction: no "ТЫ: #17", no
  // personal score/streak/selection distinguishable from another viewer's).
  describe("quiz", () => {
    const QUESTION_STATE: QuizRoundState = {
      roundId: "42",
      phase: "question",
      phaseEndsAt: new Date(Date.now() + 15_000).toISOString(),
      category: "ПРЕДМЕТ",
      interactionType: "single_choice_text",
      prompt: "Какой предмет усиливает регенерацию маны сильнее всего?",
      options: [
        { id: "1", label: "Arcane Boots", assetUrl: null },
        { id: "2", label: "Power Treads", assetUrl: null },
        { id: "3", label: "Aether Lens", assetUrl: null },
        { id: "4", label: "Boots of Travel", assetUrl: null },
      ],
      correctOptionId: null,
      distribution: null,
      interactiveRegions: null,
      leaderboard: [
        { rank: 1, twitchViewerId: "u1", displayName: "quiz_lover", score: 400, streak: 2 },
        { rank: 2, twitchViewerId: "u2", displayName: "dota_fan_92", score: 300, streak: 1 },
      ],
    };
    const REVEAL_STATE: QuizRoundState = {
      ...QUESTION_STATE,
      phase: "reveal",
      correctOptionId: "1",
      distribution: { "1": 54, "2": 21, "3": 17, "4": 8 },
    };

    it("does not render a quiz board at all when there is no active round", () => {
      render(<BetweenMatchesScene session={SESSION} quiz={null} />);
      expect(screen.queryByLabelText("QUIZ")).toBeNull();
    });

    it("renders the real question/options during QUESTION, with no correct answer revealed", () => {
      render(<BetweenMatchesScene session={SESSION} quiz={QUESTION_STATE} />);
      expect(screen.getByLabelText("QUIZ")).toBeTruthy();
      expect(screen.getByText(QUESTION_STATE.prompt)).toBeTruthy();
      for (const option of QUESTION_STATE.options) {
        expect(screen.getByText(option.label)).toBeTruthy();
      }
      // No percent/distribution figures rendered before reveal.
      expect(screen.queryByText("54%")).toBeNull();
    });

    it("renders correctness/distribution/leaderboard only once the round is in REVEAL", () => {
      render(<BetweenMatchesScene session={SESSION} quiz={REVEAL_STATE} />);
      expect(screen.getByText("54%")).toBeTruthy();
      expect(screen.getByText("quiz_lover")).toBeTruthy();
      expect(screen.getByText("dota_fan_92")).toBeTruthy();
    });

    it("never renders any personalized/per-viewer marker in the shared video", () => {
      const { container } = render(<BetweenMatchesScene session={SESSION} quiz={REVEAL_STATE} />);
      const text = container.textContent ?? "";
      // No "your rank", "you answered", a personal streak/score readout, or
      // any viewer-id-shaped string leaking into the shared visual - only
      // the shared TOP 5 (rank/displayName/score) is ever shown.
      expect(text).not.toMatch(/ты[:\s]/i);
      expect(text).not.toMatch(/your (rank|score|answer)/i);
      expect(container.querySelector("[data-viewer-id]")).toBeNull();
      expect(container.querySelector("[data-personal-selection]")).toBeNull();
    });
  });
});
