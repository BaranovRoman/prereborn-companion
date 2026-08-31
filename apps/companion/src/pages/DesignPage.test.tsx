// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getOverlayLayout: vi.fn(),
  saveOverlayLayout: vi.fn(),
  getQueueSettings: vi.fn(),
  saveQueueSettings: vi.fn(),
}));

// eslint-disable-next-line import/order
import { getOverlayLayout, getQueueSettings, saveOverlayLayout, saveQueueSettings } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { DesignPage } from "./DesignPage";
// eslint-disable-next-line import/order
import type { OverlayLayoutDoc } from "../types/status";

const mockedGet = vi.mocked(getOverlayLayout);
const mockedSave = vi.mocked(saveOverlayLayout);
const mockedGetQueue = vi.mocked(getQueueSettings);
const mockedSaveQueue = vi.mocked(saveQueueSettings);

const recentMatches = {
  xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" as const,
  recentMatches: { limit: 5, source: "current-stream" as const, direction: "newest-first" as const, compact: false },
};
const minimapCover = { enabled: true, preset: "clean" as const, anchor: "bottom-left" as const, x: 20, y: 20, size: 320 };

function buildLayout(overrides: Partial<OverlayLayoutDoc> = {}): OverlayLayoutDoc {
  const widget = { xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" as const };
  return {
    version: 4,
    scenes: {
      draft: { widgets: { session: { ...widget }, currentGame: { ...widget, visible: false }, recentMatches: { ...recentMatches }, companionStatus: { ...widget } }, minimapCover: { ...minimapCover } },
      gameplay: { widgets: { session: { ...widget }, currentGame: { ...widget }, recentMatches: { ...recentMatches }, companionStatus: { ...widget } }, minimapCover: { ...minimapCover } },
      // Untyped passthrough fields the editor must never touch/lose.
      cameraZoneMarker: "should-survive-a-save",
    },
    draftProtection: { mode: "cover", text: { ...widget, content: "Стрим скоро продолжится" } },
    aspectRatio: { preset: "16:9", widthRatio: 16, heightRatio: 9, width: 1920, height: 1080 },
    ...overrides,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  const settings = {
    version: 2, visibility: { playerProfile: true, streamProfile: true, featuredMatch: true, webcam: true, favoriteHeroes: true, recentGames: true, twitchChat: true, systemStatus: false },
    favoriteHeroIds: [], webcamImageUrl: null, channelGoal: { type: "none" as const, label: "", startValue: 0, targetValue: 0 },
    widgets: { titles: { playerProfile: "Player profile", streamProfile: "Channel transmission", featuredMatch: "Last match", webcam: "Live capture", favoriteHeroes: "Favorite heroes", recentGames: "Recent games", twitchChat: "Twitch chat", friends: "Friends" }, recentGamesLimit: 5, chatMessagesLimit: 12, friends: { showDonaters: true, showSubscribers: true, showFollowers: true, socialLinks: [] } },
  };
  mockedGetQueue.mockResolvedValue(settings);
  mockedSaveQueue.mockResolvedValue(settings);
});

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
    expect(screen.getAllByText("Показывать").length).toBe(4);
  });

  it("shows configurable Between Matches blocks", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    render(<DesignPage />);
    await waitFor(() => expect(screen.queryByText(/Загрузка/)).toBeNull());
    expect(await screen.findByText("Блоки Between Matches")).toBeTruthy();
    expect(screen.getByText("Канал и контент")).toBeTruthy();
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
    expect(sent.draftProtection.text.content).toBe("Стрим скоро продолжится");
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
