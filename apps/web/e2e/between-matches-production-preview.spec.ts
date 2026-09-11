import { expect, test } from "@playwright/test";

// WK-157 - Between Matches follow-up (WK-116 real-stream feedback). Unlike
// queue-scene-quiz-placement.spec.ts (Phase 0 scaffolding, exercises the
// separate `?quizVariant=` mock-content harness), this spec exercises the
// REAL production render path (`renderRealQuizBoard` in queue-scene-ui.tsx)
// under `?mock=1` with the populated MOCK_OVERLAY_DATA.quiz fixture and the
// `?quizPhase=` forced-preview override added for item 4 (editor/preview
// parity) - the same mechanism a streamer's own preview relies on, so this
// doubles as its verification. Required baselines per project CLAUDE.md:
// 1920x1080 primary, 2560x1440 required large-desktop check.

const RESOLUTIONS = [
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
] as const;

test.describe("WK-157 - Between Matches production layout preview (?mock=1, real quiz path)", () => {
    test.describe.configure({ timeout: 60_000 });

    // Same reasoning as queue-scene-quiz-placement.spec.ts's beforeEach:
    // QueueSceneUi mounts several OTHER hooks (useStreamSession/
    // useTwitchIntegration/etc) that fire their own authenticated
    // /api/stream/* calls regardless of publicData being present - without
    // stubbing them to something other than a real network failure, a
    // global session-expired redirect fires and the mock overlay data never
    // gets a chance to render.
    test.beforeEach(async ({ page }) => {
        await page.route("**/api/stream/**", async (route) => {
            await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: "E2E backend unavailable" }),
            });
        });
    });

    for (const resolution of RESOLUTIONS) {
        for (const phase of ["question", "reveal"] as const) {
            test(`${resolution.width}x${resolution.height} (${phase}) - full production layout fits without scroll`, async ({ page }) => {
                await page.setViewportSize(resolution);
                await page.goto(`/stream/queue?quality=low&forceFallback=1&mock=1&quizPhase=${phase}`);

                // Left/middle/right columns per the authoritative layout -
                // all eight widgets simultaneously, Radar included (WK-155/
                // WK-157 item 1: no longer conditionally absent), Quiz
                // included (real path, not the mock-content harness).
                for (const title of [
                    "Last match",
                    "Live capture",
                    "Favorite heroes",
                    "Recent games",
                    "Twitch chat",
                    "Friends",
                ]) {
                    await expect(page.getByRole("region", { name: title })).toBeVisible();
                }
                await expect(page.getByLabel("Player radar")).toBeVisible();
                await expect(page.getByLabel("QUIZ")).toBeVisible();

                const quizPanel = page.getByLabel("QUIZ");
                if (phase === "question") {
                    await expect(quizPanel.getByText("61%")).toHaveCount(0);
                } else {
                    await expect(quizPanel.getByText("61%")).toBeVisible();
                    await expect(quizPanel.getByText("quiz_lover")).toBeVisible();
                }

                // WK-157 item 2 - Quiz must sit between Chat and Community,
                // not after both.
                const order = await page.evaluate(() => {
                    const quiz = document.querySelector("[data-quiz-root]");
                    const rightMain = quiz?.parentElement;
                    if (!rightMain) return null;
                    return Array.from(rightMain.children).map((child) => child.getAttribute("aria-label"));
                });
                expect(order).not.toBeNull();
                const chatIndex = order!.indexOf("Twitch chat");
                const quizIndex = order!.indexOf("QUIZ");
                const communityIndex = order!.indexOf("Friends");
                expect(quizIndex).toBeGreaterThan(chatIndex);
                expect(communityIndex).toBeGreaterThan(quizIndex);

                const hasScroll = await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth > document.documentElement.clientWidth ||
                        document.documentElement.scrollHeight > document.documentElement.clientHeight
                );
                expect(hasScroll).toBe(false);

                await page.screenshot({
                    path: `test-results/wk-157-between-matches/${resolution.width}x${resolution.height}-${phase}.png`,
                });
            });
        }
    }

    // WK-157 item 3 - "Viewer Quiz" disabled must behave exactly like "no
    // active round": no board, no reserved space, Chat/Community expand
    // into the freed space. `?quizEnabled=0` (mock-only, see
    // queue-scene-ui.tsx) overrides the mock fixture's own opted-in default
    // so this can be verified without a real backend settings write.
    for (const resolution of RESOLUTIONS) {
        test(`${resolution.width}x${resolution.height} - Viewer Quiz disabled removes the panel and expands Chat/Community cleanly`, async ({ page }) => {
            await page.setViewportSize(resolution);
            await page.goto("/stream/queue?quality=low&forceFallback=1&mock=1&quizEnabled=0");

            await expect(page.getByRole("region", { name: "Twitch chat" })).toBeVisible();
            await expect(page.getByRole("region", { name: "Friends" })).toBeVisible();
            await expect(page.getByLabel("QUIZ")).toHaveCount(0);
            await expect(page.locator("[data-quiz-root]")).toHaveCount(0);

            const hasScroll = await page.evaluate(
                () =>
                    document.documentElement.scrollWidth > document.documentElement.clientWidth ||
                    document.documentElement.scrollHeight > document.documentElement.clientHeight
            );
            expect(hasScroll).toBe(false);

            await page.screenshot({
                path: `test-results/wk-157-between-matches/${resolution.width}x${resolution.height}-quiz-disabled.png`,
            });
        });
    }
});
