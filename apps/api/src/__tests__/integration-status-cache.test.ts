import { beforeEach, describe, expect, it, vi } from "vitest";

const getTwitchStatus = vi.fn();
const getDonationAlertsStatus = vi.fn();

vi.mock("../services/twitch-integration-service.js", () => ({ getTwitchStatus }));
vi.mock("../services/donation-alerts-integration-service.js", () => ({
    getDonationAlertsStatus,
}));
vi.mock("../utils/logger.js", () => ({
    logger: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe("overlay integration status cache", () => {
    beforeEach(() => {
        vi.resetModules();
        getTwitchStatus.mockReset();
        getDonationAlertsStatus.mockReset();
    });

    it("coalesces a 20-way overlay burst and reuses the short-lived result", async () => {
        getTwitchStatus.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { connected: true, live: null };
        });
        getDonationAlertsStatus.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { connected: true, donations: [] };
        });

        const { loadIntegrationStatus } = await import(
            "../controllers/stream/overlay.js"
        );
        const startedAt = performance.now();
        const results = await Promise.all(
            Array.from({ length: 20 }, () => loadIntegrationStatus("42"))
        );
        const burstMs = Math.round(performance.now() - startedAt);

        expect(results).toHaveLength(20);
        expect(getTwitchStatus).toHaveBeenCalledTimes(1);
        expect(getDonationAlertsStatus).toHaveBeenCalledTimes(1);

        await loadIntegrationStatus("42");
        expect(getTwitchStatus).toHaveBeenCalledTimes(1);
        expect(getDonationAlertsStatus).toHaveBeenCalledTimes(1);
        console.info("Overlay integrations 20-way burst ms", burstMs);
    });
});
