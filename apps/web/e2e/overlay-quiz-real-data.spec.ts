import { expect, test } from "@playwright/test";

// WK-116 Phase 5 - the REAL production path (not the Phase 0 mock/
// ?quizVariant= regression harness): /overlay/:publicToken is the actual
// public OBS Browser Source route (see apps/web/src/components/pages/
// overlay/index.tsx), polling GET /api/stream/overlay/:token client-side
// (the SSR fetch fails harmlessly against no real backend during this test
// run - see overlay-server.ts's try/catch - and useOverlayPolling's client-
// side poll, intercepted below, is what actually renders). No query params
// here at all - this proves Variant C is the unconditional, permanent
// placement, not something that only appears when asked for.

const REALISTIC_QUIZ_QUESTION = {
    roundId: "999",
    phase: "question" as const,
    phaseEndsAt: new Date(Date.now() + 18_000).toISOString(),
    category: "ПРЕДМЕТ",
    interactionType: "single_choice_text" as const,
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

const REALISTIC_QUIZ_REVEAL = {
    ...REALISTIC_QUIZ_QUESTION,
    phase: "reveal" as const,
    correctOptionId: "1",
    distribution: { "1": 54, "2": 21, "3": 17, "4": 8 },
};

// Self-contained OverlayData fixture (not imported from src/ - e2e specs in
// this project run outside the Next.js module graph, and this keeps the
// route mock decoupled from that module's own internal shape changing).
// Populated enough for every pre-existing widget to render real content,
// same "populated, not empty-state" reasoning as the Phase 0 placement
// spike's own fixture.
const baseOverlayData = (quiz: unknown) => ({
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
    matches: [],
    recentMatches: [],
    companion: { isOnline: true, receivedAt: new Date().toISOString(), companionVersion: "0.6.0", payload: null },
    steam: { connected: false, profile: null },
    openDota: null,
    twitch: {
        connected: true,
        configured: true,
        login: "streamer",
        displayName: "Streamer",
        profileImageUrl: null,
        connectedAt: new Date().toISOString(),
        live: { title: "Ranked grind", viewerCount: 812, gameName: "Dota 2" },
        chat: {
            connected: true,
            messages: [{ id: "c1", author: "viewer_one", color: "#e08a63", text: "gl!", badges: [], receivedAt: new Date().toISOString() }],
        },
        recentSubscribers: [],
        recentFollowers: [],
    },
    donationAlerts: {
        connected: true,
        configured: true,
        displayName: "Streamer",
        avatarUrl: null,
        connectedAt: new Date().toISOString(),
        donations: [],
        topDonors: [{ username: "big_supporter", amount: 3200, currency: "RUB", donationCount: 6 }],
    },
    viewerEvents: [],
    quiz,
    viewerAlertsSettings: { enabled: true, types: {} },
    layout: { version: 1, aspectRatio: "16:9", draftProtection: { mode: "off", text: "" }, scenes: { draft: { widgets: {}, minimapCover: null }, gameplay: { widgets: {}, minimapCover: null, cameraZone: { enabled: false } } } },
    queueSettings: {
        version: 2,
        visibility: { playerProfile: true, streamProfile: true, featuredMatch: true, webcam: true, favoriteHeroes: true, recentGames: true, twitchChat: true, systemStatus: false },
        favoriteHeroIds: [1, 8, 5],
        webcamImageUrl: null,
        channelGoal: { type: "none", label: "", startValue: 0, targetValue: 0 },
        widgets: {
            titles: { playerProfile: "Player profile", streamProfile: "Channel transmission", featuredMatch: "Last match", webcam: "Live capture", favoriteHeroes: "Favorite heroes", recentGames: "Recent games", twitchChat: "Twitch chat", friends: "Friends" },
            recentGamesLimit: 15,
            chatMessagesLimit: 12,
            friends: { showDonaters: true, showSubscribers: true, showFollowers: true, socialLinks: [] },
            // WK-157 - "Viewer Quiz" defaults to OFF in production
            // (DEFAULT_QUEUE_SETTINGS); this fixture opts in so the existing
            // "quiz renders on the real path" tests below keep exercising
            // that path. The dedicated "disabled" test further down
            // overrides this back to false.
            viewerQuizEnabled: true,
        },
    },
});

// Same shape as queue-scene-quiz-placement.spec.ts's beforeEach: QueueSceneUi
// mounts several OTHER hooks (useStreamSession/useTwitchIntegration/etc)
// that fire their own authenticated /api/stream/* calls regardless of
// publicData being present - those must resolve to something other than a
// real network failure, or a global session-expired redirect fires and
// swallows the page before the overlay poll's own mocked response ever
// matters. Match the broad glob first (503, same as the existing spec) and
// only the overlay endpoint specifically gets the real populated payload.
const mockOverlayResponse = async (
    page: import("@playwright/test").Page,
    quiz: unknown,
    // WK-157 - lets the "disabled" test below flip queueSettings.widgets.
    // viewerQuizEnabled back to false without a second fixture function.
    overrideViewerQuizEnabled?: boolean
) => {
    await page.route("**/api/stream/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/api/stream/overlay/")) {
            const data = baseOverlayData(quiz);
            if (overrideViewerQuizEnabled !== undefined) {
                data.queueSettings.widgets.viewerQuizEnabled = overrideViewerQuizEnabled;
            }
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(data),
            });
        }
        await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "E2E backend unavailable" }),
        });
    });
};

test.describe("WK-116 Phase 5 - real quiz data on the production /overlay/:publicToken route", () => {
    test("renders the quiz unconditionally between Twitch Chat and Community, no query param needed", async ({ page }) => {
        await mockOverlayResponse(page, REALISTIC_QUIZ_QUESTION);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto("/overlay/e2e-fake-token");

        await expect(page.getByLabel("QUIZ")).toBeVisible();
        await expect(page.getByText(REALISTIC_QUIZ_QUESTION.prompt)).toBeVisible();
        for (const option of REALISTIC_QUIZ_QUESTION.options) {
            await expect(page.getByText(option.label)).toBeVisible();
        }
        // Every pre-existing widget must still be present alongside it.
        for (const title of ["Last match", "Live capture", "Favorite heroes", "Recent games", "Twitch chat", "Friends"]) {
            await expect(page.getByRole("region", { name: title })).toBeVisible();
        }
        // No correctness revealed during QUESTION.
        await expect(page.getByText("54%")).toHaveCount(0);

        const hasScroll = await page.evaluate(
            () =>
                document.documentElement.scrollWidth > document.documentElement.clientWidth ||
                document.documentElement.scrollHeight > document.documentElement.clientHeight
        );
        expect(hasScroll).toBe(false);
    });

    // WK-157 item 2 - Quiz's approved position is between Chat and
    // Community, not after both: at the bottom of the right column it sat
    // too close to Twitch's own player chrome/progress bar on a real
    // stream. This page is OUR OWN overlay HTML (composited into OBS, no
    // real Twitch player chrome present here), so the actual chrome-overlap
    // check needs a real stream - this only verifies the structural DOM
    // order that fix depends on.
    test("Quiz sits between Twitch Chat and Community in DOM order, not after both", async ({ page }) => {
        await mockOverlayResponse(page, REALISTIC_QUIZ_QUESTION);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto("/overlay/e2e-fake-token");

        const order = await page.evaluate(() => {
            const quiz = document.querySelector('[data-quiz-root]');
            const rightMain = quiz?.parentElement;
            if (!rightMain) return null;
            return Array.from(rightMain.children).map((child) => child.getAttribute("aria-label"));
        });
        expect(order).not.toBeNull();
        const chatIndex = order!.indexOf("Twitch chat");
        const quizIndex = order!.indexOf("QUIZ");
        const communityIndex = order!.indexOf("Friends");
        expect(chatIndex).toBeGreaterThanOrEqual(0);
        expect(quizIndex).toBeGreaterThan(chatIndex);
        expect(communityIndex).toBeGreaterThan(quizIndex);
    });

    // WK-157 item 3 - "Viewer Quiz" setting (default OFF). Disabled must
    // behave exactly like "no active round": no board, no reserved space,
    // regardless of an active round server-side.
    test("does not render the quiz board when Viewer Quiz is disabled, even with an active round", async ({ page }) => {
        await mockOverlayResponse(page, REALISTIC_QUIZ_QUESTION, false);
        await page.goto("/overlay/e2e-fake-token");

        await expect(page.getByRole("region", { name: "Twitch chat" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Friends" })).toBeVisible();
        await expect(page.getByLabel("QUIZ")).toHaveCount(0);
    });

    test("reveals correctness/distribution/leaderboard only once phase is reveal", async ({ page }) => {
        await mockOverlayResponse(page, REALISTIC_QUIZ_REVEAL);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto("/overlay/e2e-fake-token");

        await expect(page.getByText("54%")).toBeVisible();
        await expect(page.getByText("quiz_lover")).toBeVisible();
        await expect(page.getByText("dota_fan_92")).toBeVisible();
    });

    test("renders no quiz board at all when there is no active round", async ({ page }) => {
        await mockOverlayResponse(page, null);
        await page.goto("/overlay/e2e-fake-token");
        await expect(page.getByRole("region", { name: "Twitch chat" })).toBeVisible();
        await expect(page.getByLabel("QUIZ")).toHaveCount(0);
    });

    test("never renders a personalized/per-viewer marker in the shared video", async ({ page }) => {
        await mockOverlayResponse(page, REALISTIC_QUIZ_REVEAL);
        await page.goto("/overlay/e2e-fake-token");
        await expect(page.getByLabel("QUIZ")).toBeVisible();

        const bodyText = await page.evaluate(() => document.body.textContent ?? "");
        expect(bodyText).not.toMatch(/ты[:\s]#?\d/i);
        expect(bodyText).not.toMatch(/your (rank|score|answer)/i);
        expect(await page.locator("[data-viewer-id]").count()).toBe(0);
        expect(await page.locator("[data-personal-selection]").count()).toBe(0);
    });

    test("fits cleanly at 2560x1440 as well", async ({ page }) => {
        await mockOverlayResponse(page, REALISTIC_QUIZ_QUESTION);
        await page.setViewportSize({ width: 2560, height: 1440 });
        await page.goto("/overlay/e2e-fake-token");

        await expect(page.getByLabel("QUIZ")).toBeVisible();
        const hasScroll = await page.evaluate(
            () =>
                document.documentElement.scrollWidth > document.documentElement.clientWidth ||
                document.documentElement.scrollHeight > document.documentElement.clientHeight
        );
        expect(hasScroll).toBe(false);
    });
});
