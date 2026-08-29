// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTtsSettings } from "./ChatTtsSettings";
import { DEFAULT_CHAT_SETTINGS } from "../../chat/chat-model";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";

function buildSession(overrides: Partial<TwitchChatSession> = {}): TwitchChatSession {
  return {
    status: null,
    error: null,
    unread: 0,
    settings: DEFAULT_CHAT_SETTINGS,
    sileroStatus: { state: "ready", resourcesReady: true, lastError: null },
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

afterEach(() => cleanup());

// WK-121 - "Чат и TTS" is the one owner of every permanent chat/TTS
// preference; verifies each control writes through the SAME session
// instance's updateSetting (no parallel/local state).
describe("ChatTtsSettings", () => {
  it("reflects current settings", () => {
    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true, speechVolume: 42 } })} />);
    expect((screen.getByLabelText("Озвучивать сообщения (TTS)") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("toggling TTS enabled calls updateSetting('ttsEnabled', ...)", () => {
    const session = buildSession();
    render(<ChatTtsSettings session={session} />);
    fireEvent.click(screen.getByLabelText("Озвучивать сообщения (TTS)"));
    expect(session.updateSetting).toHaveBeenCalledWith("ttsEnabled", true);
  });

  it("toggling notification sound calls updateSetting('soundEnabled', ...)", () => {
    const session = buildSession();
    render(<ChatTtsSettings session={session} />);
    fireEvent.click(screen.getByLabelText("Звук нового сообщения"));
    expect(session.updateSetting).toHaveBeenCalledWith("soundEnabled", true);
  });

  it("changing the speech volume slider calls updateSetting('speechVolume', ...)", () => {
    const session = buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true } });
    render(<ChatTtsSettings session={session} />);
    fireEvent.change(screen.getByLabelText("Громкость речи"), { target: { value: "33" } });
    expect(session.updateSetting).toHaveBeenCalledWith("speechVolume", 33);
  });

  it("only shows Silero voice picker when TTS is enabled and engine is silero", () => {
    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: false } })} />);
    expect(screen.queryByText("Голос")).toBeNull();

    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true, ttsEngine: "silero" } })} />);
    expect(screen.getByText("Голос")).toBeTruthy();
  });
});
