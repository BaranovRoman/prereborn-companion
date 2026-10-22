import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivacyOperatorDetails } from "@/shared/config/legal";

vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { PrivacyPage } from ".";
import { isPrivacyPolicyComplete, PRIVACY_OPERATOR } from "@/shared/config/legal";

const empty: PrivacyOperatorDetails = {
  operatorName: null,
  postalAddress: null,
  contactEmail: null,
  effectiveDate: null,
  serverLogRetention: null,
};

const filled: PrivacyOperatorDetails = {
  operatorName: "Тестовый Оператор",
  postalAddress: "000000, Тестовый адрес",
  contactEmail: "privacy@example.com",
  effectiveDate: "2026-11-01",
  serverLogRetention: "30 дней",
};

describe("PrivacyPage", () => {
  afterEach(cleanup);

  it("has every section the ticket requires", () => {
    render(<PrivacyPage operator={filled} />);
    for (const heading of [
      /Общие положения/,
      /Оператор/,
      /Какие данные и зачем/,
      /Правовые основания/,
      /собираются, хранятся и удаляются/,
      /Передача третьим лицам/,
      /Трансграничная передача/,
      /Меры защиты/,
      /Ваши права/,
      /Изменение политики/,
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeTruthy();
    }
  });

  it("marks missing operator details instead of guessing them and flags the draft", () => {
    render(<PrivacyPage operator={empty} />);
    expect(screen.getByRole("note").textContent).toMatch(/Черновик/);
    // name, address, email (twice: operator + rights), date, log retention
    expect(screen.getAllByText("не заполнено").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByRole("link", { name: /@/ })).toBeNull();
  });

  it("shows the confirmed details and no draft banner once complete", () => {
    render(<PrivacyPage operator={filled} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("не заполнено")).toBeNull();
    expect(screen.getByText(/Тестовый Оператор/)).toBeTruthy();
    expect(screen.getByText(/1 ноября 2026/)).toBeTruthy();
    for (const link of screen.getAllByRole("link", { name: "privacy@example.com" })) {
      expect(link.getAttribute("href")).toBe("mailto:privacy@example.com");
    }
  });

  it("is linked from the public site footer", () => {
    render(<PrivacyPage operator={filled} />);
    const footer = screen.getByRole("navigation", { name: "Ссылки в подвале" });
    expect(within(footer).getByRole("link", { name: "Политика обработки данных" }).getAttribute("href")).toBe("/privacy");
  });
});

describe("isPrivacyPolicyComplete", () => {
  it("requires every detail to be a non-blank string", () => {
    expect(isPrivacyPolicyComplete(filled)).toBe(true);
    expect(isPrivacyPolicyComplete({ ...filled, contactEmail: "  " })).toBe(false);
    expect(isPrivacyPolicyComplete(empty)).toBe(false);
  });

  it("keeps the shipped config a draft until the owner confirms the details", () => {
    // Flip this expectation together with filling shared/config/legal.ts.
    expect(isPrivacyPolicyComplete(PRIVACY_OPERATOR)).toBe(false);
  });
});
