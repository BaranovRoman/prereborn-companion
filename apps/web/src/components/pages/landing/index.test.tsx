import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/shared/ui/route-transition/usePageReady", () => ({ usePageReady: () => ({ ready: vi.fn() }) }));
import { LandingPage } from ".";
describe("landing CTA", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline")))); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("routes new and existing users into supported auth", () => {
    render(<LandingPage />);
    const register = screen.getAllByRole("link", { name: /Настроить свой стрим|Создать аккаунт/ })[0];
    const login = screen.getByRole("link", { name: "У меня есть аккаунт" });
    expect(register.getAttribute("href")).toBe("/stream/register");
    expect(login.getAttribute("href")).toBe("/stream/login");
  });
});
