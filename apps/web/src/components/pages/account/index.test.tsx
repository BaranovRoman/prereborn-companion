import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/entities/stream-user/api/stream-client", () => ({ streamApiClient: http }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => search.params }));
vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter" }) }));

import { AccountPage } from ".";
import { callbackNotice } from "./callback-notice";
import { toAccountUrl } from "./legacy-redirect";
import { setStreamTokens } from "@/entities/stream-user/lib/tokens";
import { safeNextPath } from "@/entities/stream-user/lib/session-events";

const me = (overrides = {}) => ({
  id: "42", email: "streamer@example.com", isAdmin: false, createdAt: "2026-09-30T10:00:00Z",
  companionTokenConfigured: false, companionTokenCreatedAt: null, publicToken: "public-uuid", ...overrides,
});

const routeGet = (account: object, steam: object = { connected: false }) =>
  http.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/account/me" ? account : url === "/integrations/steam" ? steam : {} })
  );

describe("AccountPage", () => {
  beforeEach(() => {
    localStorage.clear();
    search.params = new URLSearchParams();
    Object.values(http).forEach((fn) => fn.mockReset());
    Object.values(router).forEach((fn) => fn.mockReset());
  });
  afterEach(cleanup);

  it("sends a guest to the login form and back", async () => {
    render(<AccountPage />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/stream/login?next=/account"));
  });

  it("shows only account info, Companion sign-in, Steam and sign out", async () => {
    setStreamTokens("a", "r");
    routeGet(me());
    render(<AccountPage />);
    expect(await screen.findByText("streamer@example.com")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Подключение Companion" })).toBeTruthy();
    expect(screen.getByText(/Настройки → Аккаунт → Войти/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Привязать Steam" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Выйти из аккаунта" })).toBeTruthy();
    expect(screen.getByText("Старых токенов подключения нет.")).toBeTruthy();

    // The old cabinet's stream/OBS/widget settings and raw secrets are gone.
    const text = document.body.textContent ?? "";
    for (const removed of ["OBS URL", "Режим матчей", "Начать новый стрим", "Виджеты", "public-uuid"]) {
      expect(text).not.toContain(removed);
    }
    expect(screen.queryByRole("link", { name: "Администрирование" })).toBeNull();
  });

  it("links an administrator to /admin", async () => {
    setStreamTokens("a", "r");
    routeGet(me({ isAdmin: true }));
    render(<AccountPage />);
    expect((await screen.findByRole("link", { name: "Администрирование" })).getAttribute("href")).toBe("/admin");
  });

  it("revokes a legacy Companion token only after confirmation", async () => {
    setStreamTokens("a", "r");
    routeGet(me({ companionTokenConfigured: true, companionTokenCreatedAt: "2026-05-01T00:00:00Z" }));
    http.delete.mockResolvedValue({ data: me() });
    render(<AccountPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Отозвать токен" }));
    expect(http.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/сразу отключится/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отозвать" }));

    expect(await screen.findByText("Старый токен подключения отозван.")).toBeTruthy();
    expect(http.delete).toHaveBeenCalledWith("/account/me/companion-token");
  });

  it("deletes the account only after a warning and the password", async () => {
    setStreamTokens("a", "r");
    routeGet(me());
    http.delete.mockRejectedValueOnce({ response: { status: 403 } }).mockResolvedValueOnce({ data: undefined });
    render(<AccountPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Удалить аккаунт" }));
    expect(http.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/Это действие необратимо/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Удалить навсегда" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Пароль от аккаунта"), { target: { value: "wrong" } });
    fireEvent.click(confirm);
    expect(await screen.findByText("Неверный пароль.")).toBeTruthy();
    expect(localStorage.getItem("stream_access_token")).toBe("a");

    fireEvent.change(screen.getByLabelText("Пароль от аккаунта"), { target: { value: "right" } });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(http.delete).toHaveBeenLastCalledWith("/account/me", { data: { password: "right" } });
    expect(localStorage.getItem("stream_access_token")).toBeNull();
  });

  it("signs out to the landing page", async () => {
    setStreamTokens("a", "r");
    routeGet(me());
    http.post.mockResolvedValue({ data: {} });
    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Выйти из аккаунта" }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(localStorage.getItem("stream_access_token")).toBeNull();
  });

  it("shows an OAuth callback result to a browser that is not signed in", async () => {
    search.params = new URLSearchParams("twitch=connected");
    render(<AccountPage />);
    expect(await screen.findByText(/Twitch подключён/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Войдите" })).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("legacy cabinet routes", () => {
  it("/stream goes to /account keeping callback parameters", () => {
    expect(toAccountUrl({})).toBe("/account");
    expect(toAccountUrl({ steam: "error", reason: "already_linked" })).toBe("/account?steam=error&reason=already_linked");
    expect(toAccountUrl({ twitch: ["connected"], empty: undefined })).toBe("/account?twitch=connected");
  });

  it("callback notices cover Steam, Twitch and DonationAlerts", () => {
    expect(callbackNotice(new URLSearchParams("steam=connected"))?.tone).toBe("success");
    expect(callbackNotice(new URLSearchParams("steam=error&reason=already_linked"))?.text).toMatch(/уже привязан/);
    expect(callbackNotice(new URLSearchParams("donationAlerts=error"))?.tone).toBe("error");
    expect(callbackNotice(new URLSearchParams(""))).toBeNull();
  });

  it("login only returns to protected site pages", () => {
    expect(safeNextPath(null)).toBe("/account");
    expect(safeNextPath("/admin")).toBe("/admin");
    expect(safeNextPath("/stream")).toBe("/stream");
    expect(safeNextPath("//evil.example")).toBe("/account");
    expect(safeNextPath("https://evil.example/account")).toBe("/account");
    expect(safeNextPath("/changelog")).toBe("/account");
  });
});
