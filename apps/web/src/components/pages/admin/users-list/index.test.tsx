import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/entities/stream-user/api/stream-client", () => ({ streamApiClient: http }));
const admin = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/entities/admin/api/admin-client", () => ({ adminApiClient: admin }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { AdminUsersListPage } from ".";
import { setStreamTokens } from "@/entities/stream-user/lib/tokens";

const row = (id: string, email: string, extra = {}) => ({
  id, email, createdAt: "2026-09-01T10:00:00Z", onboardingCompletedAt: null, steamConnected: false,
  twitchConnected: false, twitchDisplayName: null, companionOnline: false, companionLastSeenAt: null,
  activeSessionStartedAt: null, lastCompanionActivityAt: null, activeDays30d: 0, legacyTokenConfigured: false,
  isAdmin: false, ...extra,
});

beforeAll(() => {
  // antd's responsive table needs matchMedia, which jsdom lacks.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("/admin users screen", () => {
  beforeEach(() => {
    localStorage.clear();
    http.get.mockReset();
    admin.get.mockReset();
    router.replace.mockReset();
  });
  afterEach(cleanup);

  it("sends a guest to the login form", async () => {
    admin.get.mockRejectedValue({ response: { status: 401 } });
    render(<AdminUsersListPage />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/stream/login?next=/admin"));
  });

  it("an ordinary user gets the backend's 403 as «Доступ запрещён», with no user data", async () => {
    setStreamTokens("a", "r");
    http.get.mockResolvedValue({ data: { id: "2", email: "plain@example.com", isAdmin: false } });
    admin.get.mockRejectedValue({ response: { status: 403 } });
    render(<AdminUsersListPage />);
    expect(await screen.findByRole("heading", { name: "Доступ запрещён" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("an administrator sees the summary and the user table", async () => {
    setStreamTokens("a", "r");
    http.get.mockResolvedValue({ data: { id: "1", email: "admin@example.com", isAdmin: true } });
    admin.get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === "/usage-stats"
            ? { registeredUsers: 10, dau: 1, wau: 2, mau: 2, trackingSince: "2026-10-21", generatedAt: "2026-10-22T00:00:00Z" }
            : {
                users: [
                  row("1", "admin@example.com", { isAdmin: true, lastCompanionActivityAt: "2026-10-21T12:00:00Z", activeDays30d: 1 }),
                  row("9", "other@example.com", { steamConnected: true }),
                ],
                total: 10, page: 1, pageSize: 20,
              },
      })
    );
    render(<AdminUsersListPage />);

    const summary = await screen.findByLabelText("Сводка");
    await vi.waitFor(() => expect(within(summary).getByText("10")).toBeTruthy());
    expect(within(summary).getByText("Активны за 7 дней").nextSibling?.textContent).toBe("2");

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "admin@example.com" }).getAttribute("href")).toBe("/admin/1");
    expect(within(table).getByText("админ")).toBeTruthy();
    expect(within(table).getByText("не запускал")).toBeTruthy();
    expect(within(table).getByText("Steam")).toBeTruthy();
    expect(admin.get).toHaveBeenCalledWith("/users", expect.objectContaining({ params: expect.objectContaining({ sort: "created_desc" }) }));
    // No failed post-deletion cleanups -> no warning.
    expect(screen.queryByText(/Не завершены очистки/)).toBeNull();
  });

  it("warns about post-deletion cleanups that were given up (WK-192)", async () => {
    setStreamTokens("a", "r");
    http.get.mockResolvedValue({ data: { id: "1", email: "admin@example.com", isAdmin: true } });
    admin.get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === "/usage-stats"
            ? { registeredUsers: 1, dau: 0, wau: 0, mau: 0, trackingSince: null, generatedAt: "2026-10-22T00:00:00Z",
                dataCleanups: { pending: 1, failed: 2 } }
            : { users: [], total: 0, page: 1, pageSize: 20 },
      })
    );
    render(<AdminUsersListPage />);
    expect((await screen.findByText(/Не завершены очистки после удаления данных: 2/)).getAttribute("role")).toBe("alert");
  });
});
