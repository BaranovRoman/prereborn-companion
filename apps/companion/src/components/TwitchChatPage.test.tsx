// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwitchChatPage } from "./TwitchChatPage";
import { DEFAULT_CHAT_SETTINGS } from "../chat/chat-model";
import type { TwitchChatSession } from "../chat/useTwitchChatSession";

function buildSession(overrides: Partial<TwitchChatSession> = {}): TwitchChatSession {
  return {
    status: { accountConnected: true, configured: true, displayName: "streamer", connected: true, state: "connected", messages: [] },
    error: null,
    unread: 0,
    settings: DEFAULT_CHAT_SETTINGS,
    sileroStatus: null,
    sileroBusy: false,
    previewBusy: false,
    previewError: null,
    previewSileroVoice: vi.fn(),
    updateSetting: vi.fn(),
    stopTts: vi.fn(),
    isSpeaking: () => false,
    setViewerAtBottom: vi.fn(),
    markRead: vi.fn(),
    skipTts: vi.fn(),
    lastSkipAt: null,
    skipHotkeyStatus: null,
    skipHotkeyBusy: false,
    updateSkipHotkey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// jsdom doesn't implement Element.scrollTo - TwitchChatPage calls it to
// keep the message list pinned to the bottom, unrelated to what this file
// tests (Settings ownership), so it's stubbed rather than worked around.
beforeEach(() => { window.HTMLElement.prototype.scrollTo = vi.fn(); });
afterEach(() => cleanup());

// WK-121 - Settings ownership: Chat is a runtime screen only. Permanent TTS
// preferences (enable/engine/voice/volume/etc.) must NOT be editable here
// anymore - they live in Settings → "Чат и TTS" (ChatTtsSettings.test.tsx).
describe("TwitchChatPage - runtime screen only, no permanent settings", () => {
  it("does not render any TTS preference controls", () => {
    render(<TwitchChatPage session={buildSession()} onOpenChatSettings={vi.fn()} />);
    expect(screen.queryByText("Озвучивать сообщения")).toBeNull();
    expect(screen.queryByText(/Silero \(локальный/)).toBeNull();
    expect(screen.queryByText("Произносить имя автора")).toBeNull();
    expect(screen.queryByLabelText("Громкость речи")).toBeNull();
  });

  it("renders skip/stop TTS runtime actions and a link into Settings", () => {
    const onOpenChatSettings = vi.fn();
    render(<TwitchChatPage session={buildSession()} onOpenChatSettings={onOpenChatSettings} />);
    expect(screen.getByRole("button", { name: "Пропустить текущую озвучку" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Остановить и выключить TTS" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Настройки чата и TTS →" }));
    expect(onOpenChatSettings).toHaveBeenCalled();
  });

  it("shows TTS runtime status: disabled, speaking, or waiting", () => {
    const { rerender } = render(
      <TwitchChatPage session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: false } })} onOpenChatSettings={vi.fn()} />
    );
    expect(screen.getByText("Озвучка выключена")).toBeTruthy();

    rerender(
      <TwitchChatPage
        session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true }, isSpeaking: () => true })}
        onOpenChatSettings={vi.fn()}
      />
    );
    expect(screen.getByText("Озвучивает…")).toBeTruthy();
  });

  it("skip is disabled unless currently speaking", () => {
    render(
      <TwitchChatPage
        session={buildSession({ isSpeaking: () => false })}
        onOpenChatSettings={vi.fn()}
      />
    );
    expect((screen.getByRole("button", { name: "Пропустить текущую озвучку" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
