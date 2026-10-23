// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getTermsStatus: vi.fn(),
  acceptTerms: vi.fn(),
  openLegalDocument: vi.fn(),
}));
vi.mock("../services/dotaCompanionApi", () => api);

import { TermsBanner } from "./TermsBanner";
import { useTermsAcceptance } from "../hooks/useTermsAcceptance";

// WK-191 - Companion-only users see and accept the user agreement here.
const required = { currentVersion: "2026-11-01", acceptedVersion: null, acceptedAt: null, acceptanceRequired: true };
const accepted = { ...required, acceptedVersion: "2026-11-01", acceptanceRequired: false };

function Harness() {
  const terms = useTermsAcceptance();
  return <TermsBanner show={terms.required} version={terms.version} busy={terms.busy} error={terms.error} onAccept={() => void terms.accept()} />;
}

describe("TermsBanner", () => {
  beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()));
  afterEach(cleanup);

  it("asks to accept, opens both documents on the site, and records the edition in force", async () => {
    api.getTermsStatus.mockResolvedValue(required);
    api.acceptTerms.mockResolvedValue(accepted);
    render(<Harness />);

    expect(await screen.findByText(/С 1 ноября 2026 г\. действует пользовательское соглашение/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "соглашением" }));
    fireEvent.click(screen.getByRole("button", { name: "политикой обработки персональных данных" }));
    expect(api.openLegalDocument).toHaveBeenCalledWith("terms");
    expect(api.openLegalDocument).toHaveBeenCalledWith("privacy");

    fireEvent.click(screen.getByRole("button", { name: "Принимаю" }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull());
    expect(api.acceptTerms).toHaveBeenCalledWith("2026-11-01");
  });

  it("shows the server's reason when the edition changed and stays", async () => {
    api.getTermsStatus.mockResolvedValue(required);
    api.acceptTerms.mockRejectedValue("Соглашение обновилось. Откройте его ещё раз и примите действующую редакцию.");
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Принимаю" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Соглашение обновилось/);
    expect(screen.getByRole("button", { name: "Принимаю" })).toBeTruthy();
  });

  it("shows nothing when accepted, unpublished, signed out or offline", async () => {
    for (const result of [accepted, { ...required, currentVersion: null, acceptanceRequired: false }]) {
      api.getTermsStatus.mockResolvedValueOnce(result);
      render(<Harness />);
      await act(async () => {});
      expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull();
      cleanup();
    }
    api.getTermsStatus.mockRejectedValueOnce("Companion не подключён к аккаунту.");
    render(<Harness />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Принимаю" })).toBeNull();
  });
});
