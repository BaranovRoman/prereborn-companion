import { defineConfig, devices } from "@playwright/test";

// Порт 5000 занят AirPlay Receiver на macOS (ControlCenter) - используем
// отдельный порт только для запуска Playwright-сервера, не трогая
// package.json#scripts.start (production по-прежнему стартует на 5000).
const PORT = 5099;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["html", { open: "never" }], ["list"]],
    outputDir: "./test-results",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    // Требует, чтобы `pnpm build` уже был выполнен - здесь только поднимаем
    // уже собранный production-сервер (next start), не пересобираем на
    // каждый прогон.
    webServer: {
        command: `pnpm exec next start -p ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
