import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { PrivacyPage } from ".";
import { isLegalDocumentPublished, LEGAL_OPERATOR, type LegalOperatorDetails } from "@/shared/config/legal";

const published: LegalOperatorDetails = { ...LEGAL_OPERATOR, effectiveDate: "2026-11-01" };

describe("PrivacyPage", () => {
  afterEach(cleanup);

  it("has every section the ticket requires", () => {
    render(<PrivacyPage operator={published} />);
    for (const heading of [
      /Общие положения/,
      /Оператор/,
      /Какие данные и зачем/,
      /Правовые основания/,
      /собираются и хранятся/,
      /Отключение сервисов и удаление учётной записи/,
      /Передача третьим лицам/,
      /Трансграничная передача/,
      /Меры защиты/,
      /Ваши права/,
      /Изменение политики/,
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeTruthy();
    }
  });

  it("names the confirmed operator and contact, and publishes no address", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/Баранов Роман Валерьевич/)).toBeTruthy();
    for (const link of screen.getAllByRole("link", { name: "baranov.react@gmail.com" })) {
      expect(link.getAttribute("href")).toBe("mailto:baranov.react@gmail.com");
    }
    expect(screen.queryByText("не заполнено")).toBeNull();
    expect(screen.queryByText(/Почтовый адрес/)).toBeNull();
    expect(screen.queryByText(/письменный запрос по почтовому адресу/)).toBeNull();
  });

  it("stays a draft dated by publication until the effective date is set", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("note").textContent).toMatch(/Черновик/);
    expect(screen.getByText(/Действует с: даты публикации/)).toBeTruthy();
  });

  it("shows the effective date and no draft banner once published", () => {
    render(<PrivacyPage operator={published} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText(/1 ноября 2026/)).toBeTruthy();
  });

  it("claims only implemented retention: 14-day logs, 90-day activity, no unconfigured-log caveat", () => {
    render(<PrivacyPage operator={published} />);
    expect(screen.getByText(/Не более 14 дней/)).toBeTruthy();
    expect(screen.getByText(/хранение не более 14 дней/).textContent).toMatch(/до 22 октября 2026 года, удаляются/);
    expect(screen.queryByText(/Автоматическое удаление этих журналов ещё не настроено/)).toBeNull();
    expect(screen.queryByText(/90 дней/, { selector: "dd" })?.textContent).toMatch(/днях использования/);
  });

  it("describes self-service deletion as WK-192 implements it", () => {
    render(<PrivacyPage operator={published} />);
    const section = screen.getByRole("heading", { level: 2, name: /удаление учётной записи/ }).closest("section")!;
    const text = section.textContent ?? "";
    expect(text).toMatch(/«Удалить аккаунт» и подтвердите удаление паролем/);
    expect(within(section).getAllByRole("link", { name: "личном кабинете" })[0].getAttribute("href")).toBe("/account");
    expect(within(section).getByRole("link", { name: "baranov.react@gmail.com" })).toBeTruthy();
    // Twitch tokens are revoked through the retried cleanup queue; DonationAlerts has no revoke API.
    expect(text).toMatch(/в Twitch направляется запрос на отзыв токенов/);
    expect(text).toMatch(/повторяется автоматически в течение 7 дней/);
    expect(text).toMatch(/DonationAlerts не даёт способа отозвать токен/);
    // What stays after deletion is named, not promised away.
    expect(text).toMatch(/не более 14 дней/);
    expect(text).not.toMatch(/по запросу оператору/);
    expect(text).not.toMatch(/мгновенно|безвозвратно уничтож/);
  });

  it("links the user agreement and is linked from the footer", () => {
    render(<PrivacyPage operator={published} />);
    const footer = screen.getByRole("navigation", { name: "Ссылки в подвале" });
    expect(within(footer).getByRole("link", { name: "Политика обработки данных" }).getAttribute("href")).toBe("/privacy");
    expect(within(footer).getByRole("link", { name: "Пользовательское соглашение" }).getAttribute("href")).toBe("/terms");
    expect(screen.getAllByRole("link", { name: /пользовательского соглашения|пользовательском соглашении/ })[0].getAttribute("href")).toBe("/terms");
  });
});

describe("isLegalDocumentPublished", () => {
  it("requires name, contact email and the effective date, not an address", () => {
    expect(isLegalDocumentPublished(published)).toBe(true);
    expect(isLegalDocumentPublished({ ...published, contactEmail: "  " })).toBe(false);
    expect(isLegalDocumentPublished({ ...published, effectiveDate: null })).toBe(false);
    expect(isLegalDocumentPublished({ ...published, postalAddress: null })).toBe(true);
  });

  it("keeps the shipped config unpublished until the owner approves publication", () => {
    // Set LEGAL_OPERATOR.effectiveDate to the deploy date and flip this in the publication commit.
    expect(isLegalDocumentPublished(LEGAL_OPERATOR)).toBe(false);
  });
});
