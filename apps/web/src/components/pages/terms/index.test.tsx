import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { TermsPage } from ".";
import { LEGAL_OPERATOR } from "@/shared/config/legal";

describe("TermsPage", () => {
  afterEach(cleanup);

  it("is accepted by the registration button and links the policy", () => {
    render(<TermsPage />);
    expect(screen.getByText(/Нажимая «Создать аккаунт» на странице регистрации/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /политике обработки персональных данных|политика обработки/i })[0].getAttribute("href")).toBe("/privacy");
  });

  it("rests account data on the contract and asks no consent inside it", () => {
    render(<TermsPage />);
    expect(screen.getByText(/п\. 5 ч\. 1 ст\. 6/)).toBeTruthy();
    expect(screen.queryByText(/даёте согласие|даю согласие/)).toBeNull();
  });

  it("shows the confirmed operator and no address", () => {
    render(<TermsPage />);
    expect(screen.getAllByText(/Баранов Роман Валерьевич/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "baranov.react@gmail.com" }).getAttribute("href")).toBe("mailto:baranov.react@gmail.com");
    expect(screen.queryByText(/адрес регистрации|Почтовый адрес/)).toBeNull();
  });

  it("is a draft until published, then dated", () => {
    render(<TermsPage />);
    expect(screen.getByRole("note").textContent).toMatch(/Черновик/);
    cleanup();
    render(<TermsPage operator={{ ...LEGAL_OPERATOR, effectiveDate: "2026-11-01" }} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText(/1 ноября 2026/)).toBeTruthy();
  });

  it("describes the real product: free, third-party dependent, self-service deletion", () => {
    render(<TermsPage />);
    expect(screen.getByText(/бесплатное приложение-компаньон для стримеров/)).toBeTruthy();
    expect(screen.queryByText(/подписк[аиу] (на|за) сервис|тариф|оплат[аы] услуг/i)).toBeNull();
    expect(screen.getByText(/зависят от Twitch, DonationAlerts/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "личном кабинете" }).getAttribute("href")).toBe("/account");
    // Liability limits must not override mandatory rights.
    expect(screen.getByText(/не ограничивают права, которые предоставлены вам законом/)).toBeTruthy();
  });

  it("tells accounts created earlier that they will be asked to accept, without blocking exit", () => {
    render(<TermsPage />);
    expect(screen.getByText(/попросят вас принять её кнопкой «Принимаю»/).textContent).toMatch(/выйти из учётной записи или удалить её/);
  });
});
