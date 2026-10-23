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

  it("states that the button accepts the agreement, links both documents, no consent checkbox", () => {
    render(<StreamRegisterPage />);
    expect(screen.getByText(/Нажимая «Создать аккаунт», вы принимаете/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "пользовательское соглашение" }).getAttribute("href")).toBe("/terms");
    const link = screen.getByRole("link", { name: /политике обработки персональных данных/ });
    expect(link.getAttribute("href")).toBe("/privacy");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: /Создать аккаунт/ })).toBeTruthy();
  });
});
