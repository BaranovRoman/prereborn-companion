// Phase 0 placement-spike fixture (WK-116). Populates every widget Between
// Matches renders with realistic content, so the quiz-board placement
// screenshots judge real layout pressure instead of the empty/placeholder
// state the existing e2e mock (503 + no publicData) produces. Dev/e2e only -
// read behind `?mock=1` in page.tsx, never reachable from the real
// /overlay/:token endpoint.
import { DEFAULT_OVERLAY_LAYOUT } from "@/entities/stream-overlay-layout/model/default-layout";
import { DEFAULT_VIEWER_ALERTS_SETTINGS } from "@/entities/twitch-viewer-alerts/model/types";
import { DEFAULT_QUEUE_SETTINGS } from "@/entities/stream-queue-settings/model/types";
import type { OverlayData, StreamMatch } from "@/entities/stream-session/model/types";

const mockMatch = (
    id: string,
    heroId: number,
    result: StreamMatch["result"],
    ratingBefore: number,
    ratingDelta: number | null
): StreamMatch => ({
    id,
    dotaMatchId: `789012${id}`,
    heroId,
    kills: 8,
    deaths: 3,
    assists: 14,
    inventory: [
        "item_boots",
        "item_magic_wand",
        "item_black_king_bar",
        "item_blink",
        null,
        null,
        "item_tpscroll",
        null,
        null,
    ],
    result,
    ratingBefore,
    ratingDelta,
    ratingAfter: ratingDelta === null ? null : ratingBefore + ratingDelta,
    gameMode: "ranked",
    endedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    streamSessionId: "mock-session",
});

const MOCK_MATCHES: StreamMatch[] = [
    mockMatch("m1", 1, "win", 5210, 24),
    mockMatch("m2", 8, "win", 5186, 21),
    mockMatch("m3", 5, "loss", 5210, -19),
    mockMatch("m4", 7, "win", 5178, 26),
    mockMatch("m5", 2, "loss", 5202, -18),
];

export const MOCK_OVERLAY_DATA: OverlayData = {
    sessionState: "active",
    sessionSummary: null,
    rating: 5234,
    sessionRatingDelta: 34,
    wins: 3,
    losses: 2,
    lastHeroId: 1,
    updatedAt: new Date().toISOString(),
    gameMode: "ranked",
    sceneOverride: null,
    draftProtectionModeOverride: null,
    matches: MOCK_MATCHES,
    recentMatches: MOCK_MATCHES,
    companion: {
        isOnline: true,
        receivedAt: new Date().toISOString(),
        companionVersion: "0.6.0",
        payload: null,
    },
    steam: {
        connected: true,
        profile: {
            displayName: "Streamer",
            avatarUrl: null,
            profileUrl: null,
        },
    },
    openDota: {
        favoriteHeroes: {
            patchName: "7.38",
            isLatestKnown: true,
            perHero: {
                1: { lifetime: { games: 142, wins: 79, losses: 63, winRate: 55.6 }, patch: { games: 18, wins: 11, losses: 7, winRate: 61.1 } },
                8: { lifetime: { games: 96, wins: 48, losses: 48, winRate: 50 }, patch: { games: 9, wins: 5, losses: 4, winRate: 55.6 } },
                5: { lifetime: { games: 210, wins: 118, losses: 92, winRate: 56.2 }, patch: { games: 22, wins: 14, losses: 8, winRate: 63.6 } },
            },
        },
        radar: {
            combat: 72,
            farm: 61,
            support: 44,
            objectives: 58,
            flexibility: 67,
            insufficientSample: false,
        },
        playerSummary: {
            lifetime: { games: 1284, wins: 683, losses: 601, winRate: 53.2 },
            recentForm: { sample: 20, wins: 12, losses: 8, winRate: 60 },
            mainRole: { code: 1, label: "Carry", games: 512 },
            heroesPlayed: 96,
        },
    },
    twitch: {
        connected: true,
        configured: true,
        login: "streamer",
        displayName: "Streamer",
        profileImageUrl: null,
        connectedAt: new Date().toISOString(),
        live: { title: "Ranked grind — climbing back to Divine", viewerCount: 812, gameName: "Dota 2" },
        chat: {
            connected: true,
            messages: [
                { id: "c1", author: "viewer_one", color: "#e08a63", text: "gl streamer!", badges: [], receivedAt: new Date().toISOString() },
                { id: "c2", author: "dota_fan_92", color: "#7fb3d5", text: "that was such a clean gank", badges: [], receivedAt: new Date().toISOString() },
                { id: "c3", author: "quiz_lover", color: "#9bbb76", text: "quiz time already?? 👀", badges: [], receivedAt: new Date().toISOString() },
                { id: "c4", author: "mmr_watcher", color: "#c9a15a", text: "rating looking good today", badges: [], receivedAt: new Date().toISOString() },
                { id: "c5", author: "another_viewer", color: null, text: "pick invoker next pls", badges: [], receivedAt: new Date().toISOString() },
                { id: "c6", author: "regular_chatter", color: "#b06fc4", text: "gg that scepter timing was perfect", badges: [], receivedAt: new Date().toISOString() },
            ],
        },
        recentSubscribers: [
            { id: "s1", name: "loyal_sub_42", tier: "1000", isGift: false, receivedAt: new Date().toISOString() },
            { id: "s2", name: "gifted_friend", tier: "2000", isGift: true, receivedAt: new Date().toISOString() },
        ],
        recentFollowers: [
            { id: "f1", name: "new_follower_1", followedAt: new Date().toISOString() },
            { id: "f2", name: "new_follower_2", followedAt: new Date().toISOString() },
        ],
    },
    donationAlerts: {
        connected: true,
        configured: true,
        displayName: "Streamer",
        avatarUrl: null,
        connectedAt: new Date().toISOString(),
        donations: [],
        topDonors: [
            { username: "big_supporter", amount: 3200, currency: "RUB", donationCount: 6 },
            { username: "regular_donor", amount: 1540, currency: "RUB", donationCount: 3 },
            { username: "first_timer", amount: 500, currency: "RUB", donationCount: 1 },
        ],
    },
    viewerEvents: [],
    // WK-157 - item 4 (editor/preview parity) needs the REAL quiz render
    // path (renderRealQuizBoard in queue-scene-ui.tsx) to have something to
    // show under `?mock=1`, not just the separate Phase 0 placement-spike
    // mock board (mock-quiz-content.ts, still independent of this field).
    // `correctOptionId`/`distribution` are populated even though `phase`
    // defaults to "question" - QuizBoard only ever surfaces them once
    // `phase === "reveal"`, so this is harmless at rest and lets
    // queue-scene-ui.tsx's `?quizPhase=reveal` override switch straight to
    // a populated reveal state without a second fixture. `phaseEndsAt` is
    // computed fresh below (not a fixed string) so it never reads as
    // already-expired no matter how long the dev server has been running.
    quiz: {
        roundId: "mock-preview-round",
        phase: "question",
        phaseEndsAt: new Date(Date.now() + 30_000).toISOString(),
        category: "ABILITIES",
        interactionType: "single_choice_text",
        prompt: "Какая способность показана на этой иконке?",
        options: [
            { id: "a", label: "Chaos Bolt", assetUrl: null },
            { id: "b", label: "Berserker's Call", assetUrl: null },
            { id: "c", label: "Sunder", assetUrl: null },
            { id: "d", label: "Reincarnation", assetUrl: null },
        ],
        correctOptionId: "b",
        distribution: { a: 12, b: 61, c: 9, d: 18 },
        interactiveRegions: null,
        leaderboard: [
            { rank: 1, twitchViewerId: "mock-1", displayName: "quiz_lover", score: 420, streak: 3 },
            { rank: 2, twitchViewerId: "mock-2", displayName: "dota_fan_92", score: 380, streak: 1 },
            { rank: 3, twitchViewerId: "mock-3", displayName: "another_viewer", score: 310, streak: 0 },
            { rank: 4, twitchViewerId: "mock-4", displayName: "mmr_watcher", score: 260, streak: 2 },
            { rank: 5, twitchViewerId: "mock-5", displayName: "regular_chatter", score: 190, streak: 0 },
        ],
    },
    viewerAlertsSettings: DEFAULT_VIEWER_ALERTS_SETTINGS,
    layout: DEFAULT_OVERLAY_LAYOUT,
    queueSettings: {
        ...DEFAULT_QUEUE_SETTINGS,
        favoriteHeroIds: [1, 8, 5],
        widgets: {
            ...DEFAULT_QUEUE_SETTINGS.widgets,
            friends: {
                ...DEFAULT_QUEUE_SETTINGS.widgets.friends,
                showDonaters: true,
                showSubscribers: true,
                showFollowers: true,
            },
            // Preview parity (item 4) needs the quiz actually visible by
            // default under `?mock=1` - real streamers still default to OFF
            // (DEFAULT_QUEUE_SETTINGS above), this mock fixture is the one
            // deliberate exception so `?mock=1` alone (no extra query
            // params) already shows the full production layout.
            viewerQuizEnabled: true,
        },
    },
};
