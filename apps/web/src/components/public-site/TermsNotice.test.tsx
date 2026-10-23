import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/entities/stream-user/api/stream-client", () => ({ streamApiClient: http }));
const legal = vi.hoisted(() => ({ effectiveDate: "2026-11-01" as string | null }));
vi.mock("@/shared/config/legal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/config/legal")>();
  return {
    ...actual,
    get LEGAL_OPERATOR() {
      return { ...actual.LEGAL_OPERATOR, effectiveDate: legal.effectiveDate };
    },
  };
});

import { TermsNotice } from "./TermsNotice";
import { setStreamTokens } from "@/entities/stream-user/lib/tokens";

// WK-191 - the acceptance banner for accounts created before the agreement.
const terms = (acceptanceRequired: boolean) => ({
  currentVersion: "2026-11-01", acceptedVersion: acceptanceRequired ? null : "2026-11-01", acceptedAt: null, acceptanceRequired,
});
let account: object;

describe("TermsNotice", () => {
  beforeEach(() => {
    localStorage.clear();
    legal.effectiveDate = "2026-11-01";
    Object.values(http).forEach((fn) => fn.mockReset());
    account = { id: "42", email: "streamer@example.com", isAdmin: false, terms: terms(true) };
    http.get.mockImplementation(() => Promise.resolve({ data: account }));
    setStreamTokens("access", "refresh");
  });
  afterEach(cleanup);

  it("asks an account that hasn't accepted, with both documents and a way out", async () => {
    render(<TermsNotice />);
    await screen.findByRole("button", { name: "Принимаю" });
    expect(screen.getByRole("link", { name: "пользовательское соглашение" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: "политика обработки персональных данных" }).getAttribute("href")).toBe("/privacy");
    expect(screen.getByRole("link", { name: "удалить аккаунт" }).getAttribute("href")).toBe("/account#delete-account");
    expect(screen.getByText(/С 1 ноября 2026/)).toBeTruthy();
  });

  it("records the edition the site shows and disappears", async () => {
    http.post.mockImplementation(() => {
      account = { ...account, terms: terms(false) };
      return Promise.resolve({ data: terms(false) });
    });
    render(<TermsNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "Принимаю" }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull());
    expect(http.post).toHaveBeenCalledWith("/account/me/terms/accept", { version: "2026-11-01" });
  });

  it("asks to reload when the server has a newer edition", async () => {
    http.post.mockRejectedValue({ response: { status: 409 } });
    render(<TermsNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "Принимаю" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Соглашение обновилось/);
  });

  it("stays hidden once accepted, for guests, and while the agreement is unpublished", async () => {
    account = { ...account, terms: terms(false) };
    const { unmount } = render(<TermsNotice />);
    await vi.waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull();
    unmount();

    account = { ...account, terms: terms(true) };
    legal.effectiveDate = null;
    render(<TermsNotice />);
    await vi.waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull();
    cleanup();

    localStorage.clear();
    legal.effectiveDate = "2026-11-01";
    render(<TermsNotice />);
    expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull();
  });
});
