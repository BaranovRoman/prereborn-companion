import { DEFAULT_OVERLAY_LAYOUT } from "@/entities/stream-overlay-layout/model/default-layout";
import { DEFAULT_QUEUE_SETTINGS } from "@/entities/stream-queue-settings/model/types";
import { DEFAULT_VIEWER_ALERTS_SETTINGS } from "@/entities/twitch-viewer-alerts/model/types";
import type { OverlayData, SessionSummary, StreamMatch } from "@/entities/stream-session/model/types";

// WK-98 - shared minimal-but-fully-typed OverlayData fixture for
// StreamEndedScene/OverlayPage tests, so each test only overrides the
// fields it actually cares about instead of hand-rolling the whole payload.
export const buildMatch = (overrides: Partial<StreamMatch> & { id: string; heroId: number }): StreamMatch => ({
    dotaMatchId: overrides.id,
    kills: 6,
    deaths: 2,
    assists: 10,
    inventory: [],
    result: "win",
    ratingBefore: 1000,
    ratingDelta: 25,
    ratingAfter: 1025,
    gameMode: "ranked",
    endedAt: new Date(0).toISOString(),
    streamSessionId: "session-1",
    ...overrides,
});

export const buildSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    sessionId: "session-1",
    wins: 2,
    losses: 4,
    matchCount: 6,
    gameMode: "ranked",
    ratingStart: 5986,
    ratingEnd: 5936,
    ratingDelta: -50,
    ratingAdjustment: 0,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(6_000_000).toISOString(),
    durationMs: 6_000_000,
    ...overrides,
});

export const buildOverlayData = (overrides: Partial<OverlayData> = {}): OverlayData => ({
    sessionState: "ended",
    sessionSummary: buildSummary(),
    rating: 5936,
    sessionRatingDelta: -50,
    wins: 2,
    losses: 4,
    lastHeroId: null,
    updatedAt: new Date(0).toISOString(),
    gameMode: "ranked",
    sceneOverride: null,
    draftProtectionModeOverride: null,
    matches: [],
    recentMatches: [],
    companion: { isOnline: false, receivedAt: null, companionVersion: null, payload: null },
    steam: { connected: false, profile: null },
    openDota: null,
    twitch: {
        connected: false,
        configured: false,
        live: null,
        chat: { connected: false, messages: [] },
        recentSubscribers: [],
        recentFollowers: [],
    },
    donationAlerts: null,
    viewerEvents: [],
    viewerAlertsSettings: DEFAULT_VIEWER_ALERTS_SETTINGS,
    layout: DEFAULT_OVERLAY_LAYOUT,
    queueSettings: DEFAULT_QUEUE_SETTINGS,
    ...overrides,
});
