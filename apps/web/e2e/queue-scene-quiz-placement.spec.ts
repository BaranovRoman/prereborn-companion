import { expect, test } from "@playwright/test";

// Phase 0 placement spike (WK-116) - screenshots the 3 quiz-board placement
// candidates at both required resolutions (see project CLAUDE.md), with
// realistic populated widget content (`?mock=1`, see mock-overlay-data.ts),
// in both the QUESTION and REVEAL phases, and proves the answer-button
// geometry contract (Phase 2 of the plan) computes sane normalized rects
// relative to the full video canvas. This spec - and the `?quizVariant=`/
// `?quizPhase=`/`?mock=` params it exercises - is Phase 0 scaffolding: once
// a variant is picked, Phase 3 removes the scaffolding and this spec is
// replaced by a permanent test of the single chosen layout.

const VARIANTS = ["a", "b", "c"] as const;
const RESOLUTIONS = [
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
] as const;
const PHASES = ["question", "reveal"] as const;

interface AnswerGeometry {
    id: number;
    // Normalized 0..1 against the full video canvas (the scene's outer
    // `[data-testid="queue-scene"]` root, which is the OBS Browser Source's
    // entire viewport) - see the plan's Phase 2 geometry contract.
    x: number;
    y: number;
    width: number;
    height: number;
}

const measureAnswerGeometry = async (page: import("@playwright/test").Page): Promise<AnswerGeometry[]> =>
    page.evaluate(() => {
        const root = document.querySelector('[data-testid="queue-scene"]');
        if (!root) return [];
        const rootRect = root.getBoundingClientRect();
        return Array.from(document.querySelectorAll("[data-quiz-answer]")).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                id: Number(element.getAttribute("data-quiz-answer")),
                x: (rect.left - rootRect.left) / rootRect.width,
                y: (rect.top - rootRect.top) / rootRect.height,
                width: rect.width / rootRect.width,
                height: rect.height / rootRect.height,
            };
        });
    });

test.describe("WK-116 Phase 0 - quiz placement spike", () => {
    test.describe.configure({ timeout: 60_000 });

    test.beforeEach(async ({ page }) => {
        await page.route("**/api/stream/**", async (route) => {
            await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: "E2E backend unavailable" }),
            });
        });
    });

    for (const variant of VARIANTS) {
        for (const resolution of RESOLUTIONS) {
            for (const phase of PHASES) {
                test(`variant ${variant} @ ${resolution.width}x${resolution.height} (${phase})`, async ({ page }) => {
                    await page.setViewportSize(resolution);
                    await page.goto(
                        `/stream/queue?quality=low&forceFallback=1&mock=1&quizVariant=${variant}&quizPhase=${phase}`
                    );

                    // Every existing widget must still be present - the
                    // correction is explicit that the quiz must not displace
                    // Community/Chat/Favorite Heroes/Recent Games/Radar/Last
                    // Match/Live Capture.
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
                    await expect(page.locator("[data-quiz-answer]")).toHaveCount(4);

                    const hasScroll = await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth > document.documentElement.clientWidth ||
                            document.documentElement.scrollHeight > document.documentElement.clientHeight
                    );
                    expect(hasScroll).toBe(false);

                    const geometry = await measureAnswerGeometry(page);
                    expect(geometry).toHaveLength(4);
                    for (const rect of geometry) {
                        // Buttons must stay fully inside the video canvas -
                        // the whole point of normalizing against it.
                        expect(rect.x).toBeGreaterThanOrEqual(0);
                        expect(rect.y).toBeGreaterThanOrEqual(0);
                        expect(rect.x + rect.width).toBeLessThanOrEqual(1.001);
                        expect(rect.y + rect.height).toBeLessThanOrEqual(1.001);
                        expect(rect.width).toBeGreaterThan(0);
                        expect(rect.height).toBeGreaterThan(0);
                    }
                    // eslint-disable-next-line no-console
                    console.log(
                        `[WK-116 geometry] variant=${variant} ${resolution.width}x${resolution.height} phase=${phase}`,
                        JSON.stringify(geometry)
                    );

                    await page.screenshot({
                        path: `test-results/wk-116-placement/variant-${variant}-${resolution.width}x${resolution.height}-${phase}.png`,
                    });
                });
            }
        }
    }
});
