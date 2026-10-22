import { expect, test } from "@playwright/test";

// WK-191 - /privacy is public (no session, no API), reachable from the footer,
// registration and login, and fits phones without horizontal scroll.
const shots = "test-results/wk191";

test.describe("privacy policy", () => {
    test.beforeEach(async ({ page }) => {
        // Pages render without the API; anything the shell asks for just fails.
        await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
    });

    test("opens without signing in and stays out of search while a draft", async ({ page }) => {
        const response = await page.goto("/privacy");
        expect(response?.status()).toBe(200);
        await expect(page.getByRole("heading", { level: 1, name: "Политика обработки персональных данных" })).toBeVisible();
        await expect(page).toHaveURL(/\/privacy$/);
        await expect(page.getByRole("note")).toContainText("Черновик");
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    });

    test("is linked from the footer, registration and login", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("navigation", { name: "Ссылки в подвале" }).getByRole("link", { name: "Политика обработки данных" }).click();
        await expect(page).toHaveURL(/\/privacy$/);

        await page.goto("/stream/register");
        await expect(page.getByRole("link", { name: /политике обработки персональных данных/ })).toHaveAttribute("href", "/privacy");
        await expect(page.getByRole("checkbox")).toHaveCount(0);

        await page.goto("/stream/login");
        await expect(page.getByRole("link", { name: "Политика обработки персональных данных" })).toHaveAttribute("href", "/privacy");
    });

    for (const [width, height] of [[1920, 1080], [2560, 1440], [390, 844]] as const) {
        test(`fits ${width}×${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await page.goto("/privacy");
            await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
            await page.screenshot({ path: `${shots}/privacy-${width}x${height}.png`, fullPage: true });
        });
    }

    test("registration form with the notice fits a phone", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/stream/register");
        await expect(page.getByRole("button", { name: /Создать аккаунт/ })).toBeVisible();
        await page.screenshot({ path: `${shots}/register-390x844.png`, fullPage: true });
    });
});
