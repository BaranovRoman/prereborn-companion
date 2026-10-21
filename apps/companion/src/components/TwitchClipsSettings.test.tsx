// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipsAccess, ClipsStatus } from "../core/contracts";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock("../core/api", () => ({
  CLIPS_STATE_EVENT: "clips://state",
  getClipsStatus: vi.fn(),
  getClipsAccess: vi.fn(),
  setClipsHotkey: vi.fn(),
  setClipDuration: vi.fn(),
  createClipNow: vi.fn(),
  openClip: vi.fn(),
  clearClipsHistory: vi.fn(),
  connectTwitch: vi.fn(),
}));

// eslint-disable-next-line import/order
import * as api from "../core/api";
// eslint-disable-next-line import/order
import { TwitchClipsSettings } from "./TwitchClipsSettings";

const clip = {
  id: "Clip1",
  url: "https://clips.twitch.tv/Clip1",
  editUrl: null,
  title: "Rampage",
  durationSeconds: 30,
  createdAt: "2026-10-21T10:00:00Z",
};
const baseStatus: ClipsStatus = {
  enabled: true,
  shortcut: "F8",
  registered: true,
  lastError: null,
  durationSeconds: 30,
  phase: { kind: "idle" },
  history: [],
};
const grantedAccess: ClipsAccess = {
  configured: true,
  accountConnected: true,
  scopeGranted: true,
  duration: { min: 5, max: 60, default: 30 },
};

beforeEach(() => {
  vi.mocked(api.getClipsStatus).mockResolvedValue(baseStatus);
  vi.mocked(api.getClipsAccess).mockResolvedValue(grantedAccess);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  listeners.clear();
});

describe("TwitchClipsSettings (WK-178)", () => {
  it("shows the F8 default, 30 s duration and an empty history", async () => {
    render(<TwitchClipsSettings />);
    expect(await screen.findByText("F8")).toBeTruthy();
    expect((screen.getByLabelText("Длительность клипа") as HTMLSelectElement).value).toBe("30");
    expect(screen.getByText(/Клипов пока нет/)).toBeTruthy();
  });

  it("persists a new duration through the native command", async () => {
    vi.mocked(api.setClipDuration).mockResolvedValue({ ...baseStatus, durationSeconds: 45 });
    render(<TwitchClipsSettings />);
    await screen.findByText("F8");
    fireEvent.change(screen.getByLabelText("Длительность клипа"), { target: { value: "45" } });
    expect(api.setClipDuration).toHaveBeenCalledWith(45);
    await waitFor(() => expect((screen.getByLabelText("Длительность клипа") as HTMLSelectElement).value).toBe("45"));
  });

  it("toggling the hotkey off calls set_clips_hotkey with the current combo", async () => {
    vi.mocked(api.setClipsHotkey).mockResolvedValue({ ...baseStatus, enabled: false, registered: false });
    render(<TwitchClipsSettings />);
    await screen.findByText("F8");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(api.setClipsHotkey).toHaveBeenCalledWith(false, "F8");
  });

  it("surfaces a registration failure (combo taken by another app)", async () => {
    vi.mocked(api.getClipsStatus).mockResolvedValue({
      ...baseStatus,
      registered: false,
      lastError: "Не удалось зарегистрировать «F8»: комбинация занята другим приложением",
    });
    render(<TwitchClipsSettings />);
    expect(await screen.findByText(/занята другим приложением/)).toBeTruthy();
    expect(screen.getByText(/не удалось зарегистрировать$/i)).toBeTruthy();
  });

  it("follows creating → succeeded pushed from the native side and lists the clip", async () => {
    render(<TwitchClipsSettings />);
    await screen.findByText("F8");
    await waitFor(() => expect(listeners.has("clips://state")).toBe(true));
    act(() => listeners.get("clips://state")!({ payload: { ...baseStatus, phase: { kind: "creating", startedAt: "t" } } }));
    expect(screen.getByRole("button", { name: "Создаю клип…" })).toHaveProperty("disabled", true);
    act(() => listeners.get("clips://state")!({ payload: { ...baseStatus, phase: { kind: "succeeded", clip }, history: [clip] } }));
    expect(screen.getByText(/Клип создан: Rampage/)).toBeTruthy();
    expect(screen.getByText(clip.url)).toBeTruthy();
  });

  it("shows a failure message and offers re-auth for reauth_required", async () => {
    vi.mocked(api.getClipsStatus).mockResolvedValue({
      ...baseStatus,
      phase: { kind: "failed", code: "reauth_required", message: "Недостаточно разрешений Twitch" },
    });
    vi.mocked(api.connectTwitch).mockResolvedValue(undefined);
    render(<TwitchClipsSettings />);
    expect(await screen.findByText("Недостаточно разрешений Twitch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Переподключить Twitch" }));
    expect(api.connectTwitch).toHaveBeenCalled();
  });

  it("warns up front when the linked token lacks clips:edit", async () => {
    vi.mocked(api.getClipsAccess).mockResolvedValue({ ...grantedAccess, scopeGranted: false });
    render(<TwitchClipsSettings />);
    expect(await screen.findByText(/Нет разрешения Twitch на создание клипов/)).toBeTruthy();
  });

  it("opens a history clip by id and copies its link", async () => {
    vi.mocked(api.getClipsStatus).mockResolvedValue({ ...baseStatus, history: [clip] });
    vi.mocked(api.openClip).mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<TwitchClipsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(api.openClip).toHaveBeenCalledWith("Clip1");
    fireEvent.click(screen.getByRole("button", { name: "Копировать ссылку" }));
    expect(writeText).toHaveBeenCalledWith(clip.url);
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeTruthy();
  });

  it("starts a clip manually through the same native path as the hotkey", async () => {
    vi.mocked(api.createClipNow).mockResolvedValue(true);
    render(<TwitchClipsSettings />);
    await screen.findByText("F8");
    fireEvent.click(screen.getByRole("button", { name: "Создать клип сейчас" }));
    expect(api.createClipNow).toHaveBeenCalled();
  });
});
