// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioSettings } from "./AudioSettings";
import { DEFAULT_CHAT_SETTINGS } from "../../chat/chat-model";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { AudioOutputDeviceState } from "../../hooks/useAudioOutputDevice";
import type { GameSoundSettings } from "../../services/dotaCompanionApi";
import type { useGameSoundEngine } from "../../sounds/useGameSoundEngine";

function buildChatSession(overrides: Partial<TwitchChatSession> = {}): TwitchChatSession {
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

function buildGameSoundSettings(overrides: Partial<GameSoundSettings> = {}): GameSoundSettings {
  return { schemaVersion: 1, enabled: true, masterVolume: 70, bindings: [], assets: [], ...overrides };
}

function buildEngine(overrides: Partial<ReturnType<typeof useGameSoundEngine>> = {}): ReturnType<typeof useGameSoundEngine> {
  return {
    catalog: null,
    settings: buildGameSoundSettings(),
    error: null,
    setMaster: vi.fn().mockResolvedValue(undefined),
    setBinding: vi.fn().mockResolvedValue(undefined),
    removeBinding: vi.fn().mockResolvedValue(undefined),
    chooseAndBindFile: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue(undefined),
    stopPreview: vi.fn(),
    ...overrides,
  };
}

function buildAudioOutputDevice(overrides: Partial<AudioOutputDeviceState> = {}): AudioOutputDeviceState {
  return {
    devices: [],
    selection: { mode: "system-default" },
    setSelection: vi.fn(),
    selectedDeviceMissing: false,
    selectedDeviceLabel: null,
    defaultDeviceChangedNotice: null,
    dismissDefaultDeviceChangedNotice: vi.fn(),
    switchPrompt: null,
    onSwitchToNewDefault: vi.fn(),
    onKeepCurrentDevice: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

// WK-135 - Audio Settings consolidation: Общий/Кастомные звуки/TTS in one
// place, writing through the exact same setters (setMaster/updateSetting)
// the old scattered sliders (ChatTtsSettings/SoundsPage) always used - see
// those files' own tests for confirmation the old sliders are gone.
describe("AudioSettings", () => {
  it("reflects the current overall/custom/TTS volumes", () => {
    render(
      <AudioSettings
        overallVolume={80}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true, speechVolume: 42 } })}
        gameSoundEngine={buildEngine({ settings: buildGameSoundSettings({ masterVolume: 55 }) })}
        audioOutputDevice={buildAudioOutputDevice()}
      />
    );
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("55%")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("changing Общий calls onOverallVolumeChange", () => {
    const onOverallVolumeChange = vi.fn();
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={onOverallVolumeChange}
        chatSession={buildChatSession()}
        gameSoundEngine={buildEngine()}
        audioOutputDevice={buildAudioOutputDevice()}
      />
    );
    fireEvent.change(screen.getByLabelText("Общий"), { target: { value: "65" } });
    expect(onOverallVolumeChange).toHaveBeenCalledWith(65);
  });

  it("changing Кастомные звуки calls setMaster with the existing enabled flag", () => {
    const engine = buildEngine({ settings: buildGameSoundSettings({ enabled: true, masterVolume: 70 }) });
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession()}
        gameSoundEngine={engine}
        audioOutputDevice={buildAudioOutputDevice()}
      />
    );
    fireEvent.change(screen.getByLabelText("Кастомные звуки"), { target: { value: "20" } });
    expect(engine.setMaster).toHaveBeenCalledWith(true, 20);
  });

  it("changing TTS calls updateSetting('speechVolume', ...)", () => {
    const chatSession = buildChatSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true } });
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={chatSession}
        gameSoundEngine={buildEngine()}
        audioOutputDevice={buildAudioOutputDevice()}
      />
    );
    fireEvent.change(screen.getByLabelText("TTS"), { target: { value: "33" } });
    expect(chatSession.updateSetting).toHaveBeenCalledWith("speechVolume", 33);
  });

  it("disables the Custom Sounds slider while Custom Sounds is off, and the TTS slider while TTS is off", () => {
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession({ settings: { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: false } })}
        gameSoundEngine={buildEngine({ settings: buildGameSoundSettings({ enabled: false }) })}
        audioOutputDevice={buildAudioOutputDevice()}
      />
    );
    expect((screen.getByLabelText("Кастомные звуки") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("TTS") as HTMLInputElement).disabled).toBe(true);
    // Общий has no enable/disable concept of its own - always usable.
    expect((screen.getByLabelText("Общий") as HTMLInputElement).disabled).toBe(false);
  });

  it("renders nothing for Custom Sounds while its settings haven't loaded yet", () => {
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession()}
        gameSoundEngine={buildEngine({ settings: null })}
        audioOutputDevice={buildAudioOutputDevice()}
      />
    );
    expect(screen.queryByLabelText("Кастомные звуки")).toBeNull();
    expect(screen.getByLabelText("TTS")).toBeTruthy();
  });

  it("lists explicit devices alongside System Default and selecting one calls setSelection", () => {
    const setSelection = vi.fn();
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession()}
        gameSoundEngine={buildEngine()}
        audioOutputDevice={buildAudioOutputDevice({
          devices: [{ deviceId: "dev-1", label: "Speakers (Realtek)" }],
          setSelection,
        })}
      />
    );
    const select = screen.getByText("Устройство вывода").closest("label")!.querySelector("select")!;
    expect(select.value).toBe("system-default");
    fireEvent.change(select, { target: { value: "dev-1" } });
    expect(setSelection).toHaveBeenCalledWith({ mode: "explicit", deviceId: "dev-1", label: "Speakers (Realtek)" });
  });

  it("selecting System Default calls setSelection with system-default mode", () => {
    const setSelection = vi.fn();
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession()}
        gameSoundEngine={buildEngine()}
        audioOutputDevice={buildAudioOutputDevice({
          devices: [{ deviceId: "dev-1", label: "Speakers" }],
          selection: { mode: "explicit", deviceId: "dev-1", label: "Speakers" },
          setSelection,
        })}
      />
    );
    const select = screen.getByText("Устройство вывода").closest("label")!.querySelector("select")!;
    fireEvent.change(select, { target: { value: "system-default" } });
    expect(setSelection).toHaveBeenCalledWith({ mode: "system-default" });
  });

  it("shows a warning when the selected explicit device is missing, without hiding it from the select", () => {
    const { container } = render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession()}
        gameSoundEngine={buildEngine()}
        audioOutputDevice={buildAudioOutputDevice({
          devices: [],
          selection: { mode: "explicit", deviceId: "gone-device", label: "USB Headset" },
          selectedDeviceMissing: true,
          selectedDeviceLabel: "USB Headset",
        })}
      />
    );
    const warning = container.querySelector(".audio-settings__device-warning");
    expect(warning?.textContent).toMatch(/USB Headset.*недоступно/);
    const select = screen.getByText("Устройство вывода").closest("label")!.querySelector("select")! as HTMLSelectElement;
    expect(select.value).toBe("gone-device");
  });

  it("renders no missing-device warning when the explicit selection is present in the device list", () => {
    render(
      <AudioSettings
        overallVolume={100}
        onOverallVolumeChange={vi.fn()}
        chatSession={buildChatSession()}
        gameSoundEngine={buildEngine()}
        audioOutputDevice={buildAudioOutputDevice({
          devices: [{ deviceId: "dev-1", label: "Speakers" }],
          selection: { mode: "explicit", deviceId: "dev-1", label: "Speakers" },
          selectedDeviceMissing: false,
          selectedDeviceLabel: "Speakers",
        })}
      />
    );
    expect(screen.queryByText(/недоступно/)).toBeNull();
  });
});
