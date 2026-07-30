import { expect, test } from "@playwright/test";

test.describe("queue anti-stream-sniping scene", () => {
    test.beforeEach(async ({ page }) => {
        await page.route("**/api/stream/**", async (route) => {
            await route.fulfill({
                status: 401,
                contentType: "application/json",
                body: JSON.stringify({ error: "E2E unauthenticated" }),
            });
        });
    });

    test("renders a fullscreen WebGL2 scene without scroll", async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto("/stream/queue?quality=medium&debug=1&seed=123");

        await expect(page.getByRole("heading", { name: "Поиск матча" })).toBeVisible();
        await expect(page.getByText("Стрим защищён от снайпинга")).toBeVisible();
        await expect(page.getByTestId("queue-fog-canvas")).toHaveAttribute(
            "data-renderer",
            "webgl2"
        );
        await expect(page.getByTestId("queue-tree-far")).toBeVisible();
        await expect(
            page.getByTestId("queue-tree-distant-silhouette")
        ).toBeVisible();
        await expect(page.getByTestId("queue-tree-middle")).toBeVisible();
        await expect(page.getByTestId("queue-tree-near")).toBeVisible();
        await expect(page.getByTestId("queue-debug")).toContainText(
            "Resolution: 1920×1080"
        );

        const hasScroll = await page.evaluate(
            () =>
                document.documentElement.scrollWidth >
                    document.documentElement.clientWidth ||
                document.documentElement.scrollHeight >
                    document.documentElement.clientHeight
        );
        expect(hasScroll).toBe(false);

        await page.goto("/stream/queue?quality=medium&seed=123");
        await expect(page.getByTestId("queue-fog-canvas")).toHaveAttribute(
            "data-renderer",
            "webgl2"
        );
        await page.screenshot({
            path: "test-results/diagnostics/queue-medium-1920x1080.png",
        });
    });

    test("medium and low quality keep the requested viewport aspect ratio", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 2560, height: 1440 });
        await page.goto("/stream/queue?quality=medium&debug=1&seed=123");
        await expect(page.getByTestId("queue-debug")).toContainText(
            "Resolution: 2560×1440"
        );
        await page.screenshot({
            path: "test-results/diagnostics/queue-medium-2560x1440.png",
        });

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto("/stream/queue?quality=low&debug=1&seed=123");
        await expect(page.getByTestId("queue-debug")).toContainText(
            "Resolution: 1088×612"
        );
        await page.screenshot({
            path: "test-results/diagnostics/queue-low-1280x720.png",
        });
    });

    test("compact desktop layout fits 1440x783 and keeps inventory groups distinct", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1440, height: 783 });
        await page.goto("/stream/queue?quality=low&forceFallback=1");

        for (const title of [
            "Last match // Featured hero",
            "Live capture",
            "Favorite heroes",
            "Recent games",
            "Twitch chat",
        ]) {
            const panel = page.getByRole("region", { name: title });
            await expect(panel).toBeVisible();
            const bounds = await panel.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(783);
        }

        await expect(
            page.getByLabel("Main inventory").locator("span")
        ).toHaveCount(6);
        await expect(page.getByLabel("Backpack").locator("span")).toHaveCount(3);

        for (const testId of [
            "queue-tree-far",
            "queue-tree-distant-silhouette",
            "queue-tree-middle",
            "queue-tree-near",
        ]) {
            await expect(page.getByTestId(testId).locator("img")).toHaveAttribute(
                "draggable",
                "false"
            );
        }
    });

    test("forceFallback keeps content and debug information visible", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto("/stream/queue?quality=low&debug=1&forceFallback=1");

        await expect(page.getByRole("heading", { name: "Поиск матча" })).toBeVisible();
        await expect(page.getByTestId("queue-fog-canvas")).toHaveAttribute(
            "data-renderer",
            "fallback"
        );
        await expect(page.getByTestId("queue-debug")).toContainText(
            "Shader: fallback"
        );
        await page.screenshot({
            path: "test-results/diagnostics/queue-fallback-1280x720.png",
        });
    });

    test("reduced motion renders a static shader frame", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/stream/queue?debug=1");

        await expect(page.getByTestId("queue-debug")).toContainText(
            "Target FPS: 0"
        );
        await expect(page.getByTestId("queue-debug")).toContainText(
            "Reduced motion: yes"
        );
        for (const testId of [
            "queue-tree-far",
            "queue-tree-middle",
            "queue-tree-near",
        ]) {
            await expect(page.getByTestId(testId)).toHaveCSS(
                "animation-name",
                "none"
            );
        }
        await page.screenshot({
            path: "test-results/diagnostics/queue-reduced-motion.png",
        });
    });

    test("recovers after a WebGL context loss", async ({ page }) => {
        await page.goto("/stream/queue?debug=1");
        const debugPanel = page.getByTestId("queue-debug");
        await expect(debugPanel).toContainText("Shader: compiled");

        const extensionAvailable = await page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '[data-testid="queue-fog-canvas"]'
            );
            const gl = canvas?.getContext("webgl2");
            const extension = gl?.getExtension("WEBGL_lose_context");
            (
                window as Window & {
                    __queueWebglLossExtension?: {
                        restoreContext: () => void;
                    };
                }
            ).__queueWebglLossExtension = extension ?? undefined;
            extension?.loseContext();
            return Boolean(extension);
        });

        test.skip(!extensionAvailable, "WEBGL_lose_context is unavailable");
        await expect(debugPanel).toContainText("Shader: context-lost");

        await page.evaluate(() => {
            (
                window as Window & {
                    __queueWebglLossExtension?: {
                        restoreContext: () => void;
                    };
                }
            ).__queueWebglLossExtension?.restoreContext();
        });
        await expect(debugPanel).toContainText("Shader: compiled");
    });
});
