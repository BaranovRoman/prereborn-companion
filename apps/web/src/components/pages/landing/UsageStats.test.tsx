import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageStats, parsePublicUsageStats } from "./UsageStats";

const ready = { registeredUsers: 1234, activeUsers7d: 56, activeUsers30d: 789, ready: true, generatedAt: "2026-11-21T00:00:00.000Z" };
const mockFetch = (impl: () => Promise<unknown>) => { const fn = vi.fn(impl); vi.stubGlobal("fetch", fn); return fn; };
const respond = (status: number, body: unknown) => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

afterEach(() => { vi.unstubAllGlobals(); });

describe("UsageStats", () => {
  it("shows the three public aggregates from the API", async () => {
    const fetch = mockFetch(respond(200, ready));
    render(<UsageStats />);
    expect(await screen.findByText("Зарегистрировано пользователей")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/public/usage-stats", expect.anything());
    const values = screen.getAllByRole("definition").map((node) => node.textContent);
    expect(values).toEqual([new Intl.NumberFormat("ru-RU").format(1234), "56", "789"]);
  });

  it.each([
    ["not ready yet", respond(200, { ...ready, ready: false })],
    ["API error", respond(503, { error: "Статистика временно недоступна" })],
    ["network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("renders nothing (never zeros) on %s", async (_label, impl) => {
    const fetch = mockFetch(impl);
    const { container } = render(<UsageStats />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
  });
});

describe("parsePublicUsageStats", () => {
  it("rejects malformed or empty payloads", () => {
    expect(parsePublicUsageStats(ready)).toMatchObject({ registeredUsers: 1234 });
    expect(parsePublicUsageStats(null)).toBeNull();
    expect(parsePublicUsageStats({ ...ready, activeUsers7d: "56" })).toBeNull();
    expect(parsePublicUsageStats({ ...ready, activeUsers30d: -1 })).toBeNull();
    expect(parsePublicUsageStats({ ...ready, registeredUsers: 0 })).toBeNull();
  });
});
