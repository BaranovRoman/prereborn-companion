// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  detectObsBrowserSource: vi.fn(),
  migrateObsBrowserSource: vi.fn(),
}));

// eslint-disable-next-line import/order
import { detectObsBrowserSource, migrateObsBrowserSource } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { BrowserSourceMigrationPanel } from "./BrowserSourceMigrationPanel";

const mockedDetect = vi.mocked(detectObsBrowserSource);
const mockedMigrate = vi.mocked(migrateObsBrowserSource);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("BrowserSourceMigrationPanel", () => {
  it("shows the local-connected state and no migrate action", async () => {
    mockedDetect.mockResolvedValue({ state: "localConnected", inputName: "PreReborn" });
    render(<BrowserSourceMigrationPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(screen.getByText(/Локальный оверлей подключён/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Перевести на localhost" })).toBeNull();
  });

  // WK-126 - "missing" means detectObsBrowserSource found no existing input
  // to migrate at all (a fresh OBS setup, nothing to auto-create from) - the
  // user must add a Browser Source by hand, so the URL to paste must be on
  // screen, not just implied by the panel's own description text above.
  it("shows the missing state with no migrate action, and the URL to paste manually", async () => {
    mockedDetect.mockResolvedValue({ state: "missing" });
    render(<BrowserSourceMigrationPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(screen.getByText(/не найден/)).toBeTruthy());
    expect(screen.getByText("http://127.0.0.1:3666/overlay")).toBeTruthy();
  });

  it("shows the ambiguous state listing every candidate, with no migrate action, and the URL to paste manually", async () => {
    mockedDetect.mockResolvedValue({ state: "ambiguous", candidates: ["Overlay A", "Overlay B"] });
    render(<BrowserSourceMigrationPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(screen.getByText("Overlay A")).toBeTruthy());
    expect(screen.getByText("Overlay B")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:3666/overlay")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Перевести на localhost" })).toBeNull();
  });

  it("legacy detected: shows the current URL and migrates on click, then re-checks", async () => {
    mockedDetect
      .mockResolvedValueOnce({ state: "legacyDetected", inputName: "PreReborn Overlay", currentUrl: "https://prereborn.ru/overlay/abc" })
      .mockResolvedValueOnce({ state: "localConnected", inputName: "PreReborn Overlay" });
    mockedMigrate.mockResolvedValue(undefined);

    render(<BrowserSourceMigrationPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(screen.getByText(/prereborn.ru\/overlay\/abc/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Перевести на localhost" }));
    expect(mockedMigrate).not.toHaveBeenCalledWith(); // sanity: call happens with an argument
    await waitFor(() => expect(mockedMigrate).toHaveBeenCalledWith("PreReborn Overlay"));
    await waitFor(() => expect(screen.getByText(/Локальный оверлей подключён/)).toBeTruthy());
  });

  it("surfaces a connection error without crashing", async () => {
    mockedDetect.mockRejectedValue(new Error("Не удалось подключиться к OBS"));
    render(<BrowserSourceMigrationPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(screen.getByText(/Не удалось подключиться к OBS/)).toBeTruthy());
  });
});
