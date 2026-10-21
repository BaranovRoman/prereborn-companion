import { expect, test, type Page } from "@playwright/test";

// WK-189 - public header session state, the minimal account page, legacy
// cabinet redirects and /admin, against a mocked API (the real guard is
// covered by apps/api/src/__tests__/account-admin-wk189.test.ts).
type Account = { id: string; email: string; isAdmin: boolean };

const plain: Account = { id: "7", email: "streamer@example.com", isAdmin: false };
const adminAccount: Account = { id: "1", email: "admin@example.com", isAdmin: true };
const shots = "test-results/wk189";

const mockApi = async (page: Page, account: Account) => {
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route("**/api/public/usage-stats", (route) =>
        route.fulfill(json({ registeredUsers: 10, activeUsers7d: 2, activeUsers30d: 2, trackingSince: "2026-10-21", generatedAt: new Date().toISOString() }))
    );
    await page.route("**/api/stream/**", async (route) => {
        const url = new URL(route.request().url());
        const auth = route.request().headers()["authorization"] ?? "";
        const signedIn = auth === "Bearer access-ok";
        switch (`${route.request().method()} ${url.pathname}`) {
            case "POST /api/stream/auth/login":
                return route.fulfill(json({ user: account, accessToken: "access-ok", refreshToken: "refresh-ok" }));
            case "POST /api/stream/auth/refresh":
                return route.fulfill(json({ error: "expired" }, 401));
            case "POST /api/stream/auth/logout":
                return route.fulfill({ status: 204 });
            case "GET /api/stream/account/me":
                return signedIn
                    ? route.fulfill(json({ ...account, createdAt: "2026-09-30T10:00:00Z", companionTokenConfigured: true, companionTokenCreatedAt: "2026-05-01T00:00:00Z" }))
                    : route.fulfill(json({ error: "unauthorized" }, 401));
            case "GET /api/stream/integrations/steam":
                return route.fulfill(json({ connected: true, steamId64: "76561198000000000", profile: { displayName: "streamer", avatarUrl: null, profileUrl: null } }));
            default:
                return route.fulfill(json({ error: "not mocked" }, 404));
        }
    });
    await page.route("**/api/admin/**", async (route) => {
        if (!account.isAdmin) return route.fulfill(json({ error: "Доступ запрещён" }, 403));
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/usage-stats")) {
            return route.fulfill(json({ registeredUsers: 10, dau: 1, wau: 2, mau: 2, trackingSince: "2026-10-21", generatedAt: new Date().toISOString() }));
        }
        const users = Array.from({ length: 10 }, (_, index) => {
            const id = String(10 - index);
            return {
                id,
                email: id === "1" ? "admin@example.com" : `user${id}@example.com`,
                createdAt: new Date(Date.UTC(2026, 8, 1 + Number(id) * 4)).toISOString(),
                onboardingCompletedAt: null,
                steamConnected: id === "1" || id === "4",
                twitchConnected: id === "1",
                twitchDisplayName: id === "1" ? "admin" : null,
                companionOnline: false,
                companionLastSeenAt: null,
                activeSessionStartedAt: null,
                lastCompanionActivityAt: id === "1" || id === "4" ? "2026-10-21T18:30:00Z" : null,
                activeDays30d: id === "1" || id === "4" ? 1 : 0,
                legacyTokenConfigured: id === "4",
                isAdmin: id === "1",
            };
        });
        return route.fulfill(json({ users, total: 10, page: 1, pageSize: 20 }));
    });
};

const signIn = async (page: Page) => {
    await page.goto("/stream/login");
    await page.getByLabel("Email").fill(plain.email);
    await page.getByLabel("Пароль").fill("password-123");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.waitForURL("**/account");
};

const header = (page: Page) => page.getByRole("banner");

test.describe("public header follows the session", () => {
    test("guest → sign in → landing shows the cabinet, survives reload, sign out", async ({ page }) => {
        await mockApi(page, plain);
        await page.goto("/");
        await expect(header(page).getByRole("link", { name: "Войти" })).toBeVisible();

        await signIn(page);
        await expect(page.getByRole("heading", { name: "Личный кабинет" })).toBeVisible();

        await page.goto("/");
        await expect(header(page).getByRole("link", { name: "Личный кабинет" })).toBeVisible();
        await expect(header(page).getByRole("link", { name: "Войти" })).toHaveCount(0);
        await expect(header(page).getByRole("link", { name: "Администрирование" })).toHaveCount(0);

        await page.reload();
        await expect(header(page).getByRole("link", { name: "Личный кабинет" })).toBeVisible();
        await expect(header(page).getByRole("link", { name: "Войти" })).toHaveCount(0);

        await page.goto("/changelog");
        await expect(header(page).getByRole("link", { name: "Личный кабинет" })).toBeVisible();

        await header(page).getByRole("button", { name: "Выйти" }).click();
        await expect(header(page).getByRole("link", { name: "Войти" })).toBeVisible();
        await page.reload();
        await expect(header(page).getByRole("link", { name: "Войти" })).toBeVisible();
    });

    test("an expired session turns the landing back into a guest, without leaving it", async ({ page }) => {
        await mockApi(page, plain);
        await page.goto("/");
        await page.evaluate(() => {
            localStorage.setItem("stream_access_token", "expired");
            localStorage.setItem("stream_refresh_token", "expired");
        });
        await page.reload();
        await expect(header(page).getByRole("link", { name: "Войти" })).toBeVisible();
        expect(new URL(page.url()).pathname).toBe("/");
    });

    test("an administrator gets the /admin link", async ({ page }) => {
        await mockApi(page, adminAccount);
        await signIn(page);
        await page.goto("/");
        await expect(header(page).getByRole("link", { name: "Администрирование" })).toBeVisible();
    });
});

test.describe("account page and legacy routes", () => {
    test("guest opening /account is sent to login and comes back", async ({ page }) => {
        await mockApi(page, plain);
        await page.goto("/account");
        await expect(page).toHaveURL(/\/stream\/login\?next=\/account$/);
        await page.getByLabel("Email").fill(plain.email);
        await page.getByLabel("Пароль").fill("password-123");
        await page.getByRole("button", { name: "Войти" }).click();
        await page.waitForURL("**/account");
    });

    test("/stream and /stream/overlay-editor redirect to /account, keeping callback results", async ({ page }) => {
        await mockApi(page, plain);
        await page.goto("/stream?steam=connected");
        await expect(page).toHaveURL(/\/account\?steam=connected$/);
        await expect(page.getByText("Steam подключён.", { exact: false })).toBeVisible();

        await page.goto("/stream/overlay-editor");
        await expect(page).toHaveURL(/\/account$/);
    });

    for (const [width, height] of [[1920, 1080], [2560, 1440]] as const) {
        test(`account page at ${width}×${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mockApi(page, adminAccount);
            await signIn(page);
            await expect(page.getByText("admin@example.com").first()).toBeVisible();
            await expect(page.getByRole("button", { name: "Отвязать Steam" })).toBeVisible();
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
            expect(overflow).toBe(false);
            await page.screenshot({ path: `${shots}/account-${width}x${height}.png`, fullPage: true });
        });
    }
});

test.describe("/admin", () => {
    test("an ordinary user is refused", async ({ page }) => {
        await mockApi(page, plain);
        await signIn(page);
        await page.goto("/admin");
        await expect(page.getByRole("heading", { name: "Доступ запрещён" })).toBeVisible();
        await expect(page.getByRole("table")).toHaveCount(0);
    });

    for (const [width, height] of [[1920, 1080], [2560, 1440]] as const) {
        test(`administrator sees users at ${width}×${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await mockApi(page, adminAccount);
            await signIn(page);
            await page.goto("/admin");
            await expect(page.getByRole("heading", { name: "Пользователи" })).toBeVisible();
            await expect(page.getByLabel("Сводка")).toContainText("Всего зарегистрировано10");
            await expect(page.getByRole("table").getByRole("link", { name: "admin@example.com" })).toBeVisible();
            await expect(page.getByText("Всего: 10")).toBeVisible();
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
            expect(overflow).toBe(false);
            await page.screenshot({ path: `${shots}/admin-users-${width}x${height}.png`, fullPage: true });
        });
    }
});
