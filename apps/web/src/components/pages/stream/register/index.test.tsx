import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { StreamRegisterPage } from ".";

beforeAll(() => {
  // antd's form grid needs matchMedia, which jsdom lacks.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe("StreamRegisterPage", () => {
  afterEach(cleanup);

  it("tells what the account data is for and links the policy, without a consent checkbox", () => {
    render(<StreamRegisterPage />);
    const link = screen.getByRole("link", { name: /политике обработки персональных данных/ });
    expect(link.getAttribute("href")).toBe("/privacy");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: /Создать аккаунт/ })).toBeTruthy();
  });
});
