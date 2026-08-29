// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getOverlayLayout: vi.fn(),
  saveOverlayLayout: vi.fn(),
}));

// eslint-disable-next-line import/order
import { getOverlayLayout, saveOverlayLayout } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { DesignPage } from "./DesignPage";
// eslint-disable-next-line import/order
import type { OverlayLayoutDoc } from "../types/status";

const mockedGet = vi.mocked(getOverlayLayout);
const mockedSave = vi.mocked(saveOverlayLayout);

function buildLayout(overrides: Partial<OverlayLayoutDoc> = {}): OverlayLayoutDoc {
  const widget = { xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" as const };
  return {
    version: 4,
    scenes: {
      draft: { widgets: { session: { ...widget }, currentGame: { ...widget, visible: false } } },
      gameplay: { widgets: { session: { ...widget }, currentGame: { ...widget } } },
      // Untyped passthrough fields the editor must never touch/lose.
      cameraZoneMarker: "should-survive-a-save",
    },
    draftProtectionMarker: "should-also-survive",
    ...overrides,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// The page opens on "Между матчами" (a read-only scene) by default -
// every test that needs the widget-settings inspector switches to "Игра"
// first, matching how a real user would.
async function openGameplayTab() {
  await waitFor(() => expect(screen.queryByText(/Загрузка/)).toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Игра" }));
}

describe("DesignPage", () => {
  it("shows widget settings for Игра (an editable scene)", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Сессия")).toBeTruthy();
    expect(screen.getByText("Текущая игра")).toBeTruthy();
    expect(screen.getAllByText("Показывать").length).toBe(2);
  });

  it("shows a read-only note for Между матчами (no per-widget layout in the real data model)", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    render(<DesignPage />);
    await waitFor(() => expect(screen.queryByText(/Загрузка/)).toBeNull());
    expect(screen.getByText(/нет отдельных виджетов положения/)).toBeTruthy();
    expect(screen.queryByText("Сессия")).toBeNull();
  });

  it("saves the FULL layout on Сохранить, preserving fields this editor doesn't understand", async () => {
    const layout = buildLayout();
    mockedGet.mockResolvedValue(layout);
    mockedSave.mockResolvedValue(layout);
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Сессия")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());

    const sent = mockedSave.mock.calls[0][0];
    expect(sent.scenes.cameraZoneMarker).toBe("should-survive-a-save");
    expect(sent.draftProtectionMarker).toBe("should-also-survive");
    await waitFor(() => expect(screen.getByText("Сохранено ✓")).toBeTruthy());
  });

  it("toggling a widget's visibility checkbox updates local state without touching the other widget", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    mockedSave.mockImplementation(async (layout) => layout);
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Сессия")).toBeTruthy();

    const [currentGameVisible] = screen.getAllByText("Показывать");
    fireEvent.click(currentGameVisible.closest("label")!.querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(mockedSave).toHaveBeenCalled());
    const sent = mockedSave.mock.calls[0][0];
    expect(sent.scenes.gameplay.widgets.currentGame.visible).toBe(false); // was true in fixture, toggled off
    expect(sent.scenes.gameplay.widgets.session.visible).toBe(true); // untouched
  });

  it("surfaces a save error without losing the unsaved edits", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    mockedSave.mockRejectedValue(new Error("Backend недоступен"));
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Сессия")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(screen.getByText(/Backend недоступен/)).toBeTruthy());
    expect(screen.getByText("Текущая игра")).toBeTruthy();
  });
});
