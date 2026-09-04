// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getOverlayLayout: vi.fn(),
  saveOverlayLayout: vi.fn(),
  getQueueSettings: vi.fn(),
  saveQueueSettings: vi.fn(),
  getLocalSessionSummary: vi.fn().mockResolvedValue({ ratingCurrent: 6000 }),
  chooseQueueWebcamFallback: vi.fn(),
  removeQueueWebcamFallback: vi.fn(),
  getGameplayReference: vi.fn().mockResolvedValue(null),
  chooseGameplayReference: vi.fn(),
  removeGameplayReference: vi.fn(),
}));

// WK-152 - the preview iframe now gates on a real readiness probe (see
// useLocalOverlayPreviewReady's own dedicated test) - mocked here as
// immediately-ready so the rest of DesignPage's tests, which predate and
// are unrelated to that fix, keep exercising the same "preview is up"
// state they always assumed, without a real fetch to a nonexistent local
// server on every render.
vi.mock("../hooks/useLocalOverlayPreviewReady", () => ({
  useLocalOverlayPreviewReady: () => ({ ready: true, error: null, retry: vi.fn() }),
}));

// eslint-disable-next-line import/order
import { chooseGameplayReference, getOverlayLayout, getQueueSettings, removeGameplayReference, saveOverlayLayout, saveQueueSettings } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { DesignPage } from "./DesignPage";
// eslint-disable-next-line import/order
import type { OverlayLayoutDoc } from "../types/status";

const mockedGet = vi.mocked(getOverlayLayout);
const mockedSave = vi.mocked(saveOverlayLayout);
const mockedGetQueue = vi.mocked(getQueueSettings);
const mockedSaveQueue = vi.mocked(saveQueueSettings);
const mockedChooseReference = vi.mocked(chooseGameplayReference);
const mockedRemoveReference = vi.mocked(removeGameplayReference);

const recentMatches = {
  xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" as const,
  recentMatches: { limit: 5, source: "current-stream" as const, direction: "newest-first" as const, compact: false },
};
const minimapCover = { enabled: true, preset: "clean" as const, anchor: "bottom-left" as const, x: 20, y: 20, size: 320 };

function buildLayout(overrides: Partial<OverlayLayoutDoc> = {}): OverlayLayoutDoc {
  const widget = { xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" as const };
  return {
    version: 5,
    scenes: {
      draft: { widgets: { session: { ...widget }, recentMatches: { ...recentMatches }, companionStatus: { ...widget } }, cameraZone: { enabled: true, anchor: "bottom-left", x: 60, y: 1013, width: 400, height: 300 }, minimapCover: { ...minimapCover } },
      gameplay: { widgets: { session: { ...widget }, recentMatches: { ...recentMatches }, companionStatus: { ...widget } }, cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 }, minimapCover: { ...minimapCover } },
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
    expect(screen.getByText("Текущий MMR")).toBeTruthy();
    expect(screen.getByText("История матчей")).toBeTruthy();
    expect(screen.queryByText("Текущая игра")).toBeNull();
  });

  it("uploads and removes the local editor-only Gameplay reference", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    mockedChooseReference.mockResolvedValue("http://127.0.0.1:3666/overlay/assets/gameplay-reference?v=1");
    mockedRemoveReference.mockResolvedValue();
    render(<DesignPage />);
    await openGameplayTab();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить" }));
    await waitFor(() => expect(screen.getByAltText("Подложка Gameplay editor")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(screen.queryByAltText("Подложка Gameplay editor")).toBeNull());
  });

  it("shows only supported Between Matches controls", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    render(<DesignPage />);
    await waitFor(() => expect(screen.queryByText(/Загрузка/)).toBeNull());
    expect(screen.queryByText("Блоки Between Matches")).toBeNull();
    expect(screen.getByText("Канал и контент")).toBeTruthy();
    expect(screen.queryByText("Заголовок канала")).toBeNull();
    expect(screen.queryByText("Twitch chat")).toBeNull();
    expect(screen.getByText(/Recent Followers и DonationAlerts/)).toBeTruthy();
  });

  it("keeps Draft limited to protection text editing without camera or scale controls", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    render(<DesignPage />);
    await waitFor(() => expect(screen.queryByText(/Загрузка/)).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Драфт" }));
    expect(screen.getByText("Защита драфта")).toBeTruthy();
    expect(screen.queryByText("Камера в OBS")).toBeNull();
    expect(screen.queryByText(/Точный масштаб/)).toBeNull();
  });

  it("saves the FULL layout on Сохранить, preserving fields this editor doesn't understand", async () => {
    const layout = buildLayout();
    mockedGet.mockResolvedValue(layout);
    mockedSave.mockResolvedValue(layout);
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Текущий MMR")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());

    const sent = mockedSave.mock.calls[0][0];
    expect(sent.scenes.cameraZoneMarker).toBe("should-survive-a-save");
    expect(sent.draftProtection.text.content).toBe("Стрим скоро продолжится");
    await waitFor(() => expect(screen.getByText("Сохранено ✓")).toBeTruthy());
  });

  it("toggling the MMR widget does not touch match history", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    mockedSave.mockImplementation(async (layout) => layout);
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Текущий MMR")).toBeTruthy();

    const [mmrVisible] = screen.getAllByText("Показывать");
    fireEvent.click(mmrVisible.closest("label")!.querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(mockedSave).toHaveBeenCalled());
    const sent = mockedSave.mock.calls[0][0];
    expect(sent.scenes.gameplay.widgets.session.visible).toBe(false);
    expect(sent.scenes.gameplay.widgets.recentMatches.visible).toBe(true);
  });

  it("surfaces a save error without losing the unsaved edits", async () => {
    mockedGet.mockResolvedValue(buildLayout());
    mockedSave.mockRejectedValue(new Error("Backend недоступен"));
    render(<DesignPage />);
    await openGameplayTab();
    expect(screen.getByText("Текущий MMR")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(screen.getByText(/Backend недоступен/)).toBeTruthy());
    expect(screen.getByText("История матчей")).toBeTruthy();
  });
});
