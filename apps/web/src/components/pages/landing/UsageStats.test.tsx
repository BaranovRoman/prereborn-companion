import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageStats, collectionCaption, parsePublicUsageStats } from "./UsageStats";

const full = { registeredUsers: 1234, activeUsers7d: 56, activeUsers30d: 789, trackingSince: "2026-09-01", generatedAt: "2026-11-21T00:00:00.000Z" };
const mockFetch = (impl: () => Promise<unknown>) => { const fn = vi.fn(impl); vi.stubGlobal("fetch", fn); return fn; };
const respond = (status: number, body: unknown) => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const region = () => screen.findByRole("region", { name: "Статистика Companion" });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("UsageStats", () => {
  it("shows the three public aggregates from the API", async () => {
    const fetch = mockFetch(respond(200, full));
    render(<UsageStats />);
    expect(await screen.findByText("56")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/public/usage-stats", expect.anything());
    const values = screen.getAllByRole("definition").map((node) => node.textContent);
    expect(values).toEqual([new Intl.NumberFormat("ru-RU").format(1234), "56", "789"]);
    expect((await region()).textContent).not.toContain("собирается");
  });

  it("shows real values immediately while history is short, with the collection start date", async () => {
    mockFetch(respond(200, { ...full, activeUsers7d: 3, activeUsers30d: 3, trackingSince: "2026-10-21", generatedAt: "2026-10-22T09:00:00.000Z" }));
    render(<UsageStats />);
    expect(await screen.findByText(/Статистика собирается с 21 октября 2026 г\./)).toBeTruthy();
    expect(screen.getAllByRole("definition").map((node) => node.textContent)).toEqual([new Intl.NumberFormat("ru-RU").format(1234), "3", "3"]);
  });

  it.each([
    ["API error", respond(503, { error: "Статистика временно недоступна" })],
    ["malformed payload", respond(200, { registeredUsers: 5 })],
    ["network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("says the stats are unavailable (never zeros) on %s", async (_label, impl) => {
    mockFetch(impl);
    render(<UsageStats />);
    expect(await screen.findByText("Статистика Companion сейчас недоступна.")).toBeTruthy();
    expect(screen.queryAllByRole("definition").map((node) => node.textContent?.trim()).filter(Boolean)).toEqual([]);
    expect((await region()).textContent).toBe("Статистика Companion сейчас недоступна.");
  });

  it("shows no numbers while loading", () => {
    mockFetch(() => new Promise(() => {}));
    const { container } = render(<UsageStats />);
    expect(screen.getByRole("region", { name: "Статистика Companion" }).getAttribute("aria-busy")).toBe("true");
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toEqual(["", "", ""]);
  });
});

describe("collectionCaption", () => {
  it("names the start date until 30 days are covered, then disappears", () => {
    expect(collectionCaption({ ...full, trackingSince: "2026-10-21", generatedAt: "2026-11-19T23:59:59.000Z" })).toBe("Статистика собирается с 21 октября 2026 г.");
    expect(collectionCaption({ ...full, trackingSince: "2026-10-21", generatedAt: "2026-11-20T00:00:00.000Z" })).toBeNull();
    expect(collectionCaption({ ...full, trackingSince: null })).toBe("Статистика активности только начала собираться.");
  });
});

describe("parsePublicUsageStats", () => {
  it("rejects malformed payloads", () => {
    expect(parsePublicUsageStats(full)).toMatchObject({ registeredUsers: 1234 });
    expect(parsePublicUsageStats({ ...full, trackingSince: null })).toMatchObject({ trackingSince: null });
    expect(parsePublicUsageStats(null)).toBeNull();
    expect(parsePublicUsageStats({ ...full, activeUsers7d: "56" })).toBeNull();
    expect(parsePublicUsageStats({ ...full, activeUsers30d: -1 })).toBeNull();
    expect(parsePublicUsageStats({ ...full, trackingSince: "yesterday" })).toBeNull();
    expect(parsePublicUsageStats({ ...full, generatedAt: undefined })).toBeNull();
  });
});
