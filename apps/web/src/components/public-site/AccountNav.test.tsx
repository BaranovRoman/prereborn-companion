import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WK-189 - the public header follows the real session: the auth client and
// token storage are real, only the HTTP layer underneath is faked.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/entities/stream-user/api/stream-client", () => ({ streamApiClient: http }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { AccountNav } from "./AccountNav";
import { setStreamTokens, getStreamAccessToken, getStreamRefreshToken } from "@/entities/stream-user/lib/tokens";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";

const user = (isAdmin = false) => ({
  id: "7", email: "streamer@example.com", isAdmin, createdAt: "2026-10-01T00:00:00Z",
  companionTokenConfigured: false, companionTokenCreatedAt: null,
});
const unauthorized = Object.assign(new Error("401"), { response: { status: 401 } });

describe("AccountNav", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(http).forEach((fn) => fn.mockReset());
  });
  afterEach(cleanup);

  it("shows Войти and Регистрация to a guest without calling the API", async () => {
    render(<AccountNav placement="header" />);
    expect((await screen.findByRole("link", { name: "Войти" })).getAttribute("href")).toBe("/stream/login");
    expect(screen.getByRole("link", { name: "Регистрация" }).getAttribute("href")).toBe("/stream/register");
    expect(http.get).not.toHaveBeenCalled();
  });

  it("never shows Войти to a signed-in user, even before the check finishes", async () => {
    setStreamTokens("access", "refresh");
    let resolve!: (value: unknown) => void;
    http.get.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<AccountNav placement="header" />);
    expect(screen.getByTestId("account-nav-pending")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Войти" })).toBeNull();

    await act(async () => resolve({ data: user() }));
    expect(screen.getByRole("link", { name: "Личный кабинет" }).getAttribute("href")).toBe("/account");
    expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Администрирование" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Войти" })).toBeNull();
  });

  it("adds the admin link for an administrator", async () => {
    setStreamTokens("access", "refresh");
    http.get.mockResolvedValue({ data: user(true) });
    render(<AccountNav placement="header" />);
    expect((await screen.findByRole("link", { name: "Администрирование" })).getAttribute("href")).toBe("/admin");
  });

  it("signs out: revokes the refresh token, clears storage, shows Войти", async () => {
    setStreamTokens("access", "refresh-token");
    http.get.mockResolvedValue({ data: user() });
    http.post.mockResolvedValue({ data: {} });
    render(<AccountNav placement="header" />);
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }));

    expect(await screen.findByRole("link", { name: "Войти" })).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith("/auth/logout", { refreshToken: "refresh-token" });
    expect(getStreamAccessToken()).toBeNull();
    expect(getStreamRefreshToken()).toBeNull();
  });

  it("an expired session with a dead refresh token becomes a guest", async () => {
    setStreamTokens("expired-access", "dead-refresh");
    http.get.mockRejectedValue(unauthorized);
    http.post.mockRejectedValue(unauthorized);
    render(<AccountNav placement="header" />);
    expect(await screen.findByRole("link", { name: "Войти" })).toBeTruthy();
    expect(getStreamRefreshToken()).toBeNull();
  });

  it("an expired access token is refreshed and the user stays signed in", async () => {
    setStreamTokens("expired-access", "live-refresh");
    http.get.mockRejectedValueOnce(unauthorized).mockResolvedValue({ data: user() });
    http.post.mockResolvedValue({ data: { accessToken: "new-access", refreshToken: "new-refresh" } });
    render(<AccountNav placement="header" />);
    expect(await screen.findByRole("link", { name: "Личный кабинет" })).toBeTruthy();
    expect(getStreamAccessToken()).toBe("new-access");
  });

  it("picks up a login that happens after the page loaded (same tab or another tab)", async () => {
    render(<AccountNav placement="footer" />);
    await screen.findByRole("link", { name: "Войти" });

    http.post.mockResolvedValue({ data: { user: user(), accessToken: "a", refreshToken: "r" } });
    http.get.mockResolvedValue({ data: user() });
    await act(async () => {
      await streamAuthApi.login("streamer@example.com", "pw");
    });
    expect(await screen.findByRole("link", { name: "Личный кабинет" })).toBeTruthy();

    localStorage.clear();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "stream_access_token" })));
    await waitFor(() => expect(screen.getByRole("link", { name: "Войти" })).toBeTruthy());
  });
});
