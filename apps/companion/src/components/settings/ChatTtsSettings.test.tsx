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
    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true } })} />);
    expect((screen.getByLabelText("Озвучивать сообщения (TTS)") as HTMLInputElement).checked).toBe(true);
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

  // WK-135 - the "Громкость речи" slider moved into Settings → Чат и TTS →
  // Аудио (AudioSettings.tsx, see that component's own test) - ChatTtsSettings
  // no longer renders a volume control at all.
  it("no longer renders a speech-volume slider (moved to AudioSettings)", () => {
    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true } })} />);
    expect(screen.queryByLabelText("Громкость речи")).toBeNull();
  });

  it("only shows Silero voice picker when TTS is enabled and engine is silero", () => {
    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: false } })} />);
    expect(screen.queryByText("Голос")).toBeNull();

    render(<ChatTtsSettings session={buildSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true, ttsEngine: "silero" } })} />);
    expect(screen.getByText("Голос")).toBeTruthy();
  });
});
