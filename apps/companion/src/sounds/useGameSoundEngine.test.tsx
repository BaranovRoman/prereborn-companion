// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getGameSoundCatalog: vi.fn().mockResolvedValue({ items: [], heroes: [] }),
  getGameSoundSettings: vi.fn(),
  updateGameSoundMaster: vi.fn(),
  setGameSoundBinding: vi.fn(),
  removeGameSoundBinding: vi.fn(),
  importAndBindGameSound: vi.fn(),
  previewGameSound: vi.fn(),
  logGameSoundTiming: vi.fn().mockResolvedValue(undefined),
}));

// Captured so tests can simulate the Rust-emitted "game-sound-play" event by
// calling whatever handler useGameSoundEngine.ts registered for it, instead
// of needing a real Tauri event bridge - same idiom as
// chat/useTwitchChatSession.test.tsx's SKIP_TTS_EVENT simulation.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// eslint-disable-next-line import/order
import { listen } from "@tauri-apps/api/event";
// eslint-disable-next-line import/order
import {
  getGameSoundSettings, importAndBindGameSound, logGameSoundTiming, previewGameSound, removeGameSoundBinding,
  setGameSoundBinding, updateGameSoundMaster,
} from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { useGameSoundEngine } from "./useGameSoundEngine";
// eslint-disable-next-line import/order
import type { GameSoundSettings } from "../services/dotaCompanionApi";

const baseSettings: GameSoundSettings = {
  schemaVersion: 1,
  enabled: true,
  masterVolume: 70,
  bindings: [],
  assets: [{ id: "asset-1", fileName: "asset-1.wav", originalName: "hook.wav", sizeBytes: 10 }],
};

function Harness({ onEngine }: { onEngine: (engine: ReturnType<typeof useGameSoundEngine>) => void }) {
  const engine = useGameSoundEngine();
  onEngine(engine);
  return null;
}

// Instances of this class stand in for the real HTMLAudioElement/Audio
// global - jsdom doesn't implement audio playback (play() is a no-op that
// never fires `ended`), so this gives full, synchronous control over
// play()/onended/onerror the way the tests below need.
class MockAudio {
  volume = 1;
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playCalls = 0;
  static instances: MockAudio[] = [];
  static playImpl: () => Promise<void> = () => Promise.resolve();
  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }
  play() {
    this.playCalls += 1;
    return MockAudio.playImpl();
  }
  pause() {}
}

const getPlayNotifyHandler = () => {
  const call = vi.mocked(listen).mock.calls.find(([eventName]) => eventName === "game-sound-play");
  if (!call) throw new Error("game-sound-play listener was never registered");
  return call[1] as (event: {
    payload: {
      eventId: string; base64: string; mime: string; volume: number; correlationId: string; emittedAtMs: number;
    };
  }) => void;
};

const playEvent = (eventId: string, volume = 70) => ({
  eventId, base64: "AAAA", mime: "audio/wav", volume, correlationId: `corr-${eventId}`, emittedAtMs: Date.now(),
});

describe("useGameSoundEngine", () => {
  beforeEach(() => {
    vi.mocked(getGameSoundSettings).mockReset().mockResolvedValue(baseSettings);
    vi.mocked(updateGameSoundMaster).mockReset();
    vi.mocked(setGameSoundBinding).mockReset();
    vi.mocked(removeGameSoundBinding).mockReset();
    vi.mocked(importAndBindGameSound).mockReset();
    vi.mocked(previewGameSound).mockReset().mockResolvedValue({ base64: "AAAA", mime: "audio/wav" });
    vi.mocked(logGameSoundTiming).mockReset().mockResolvedValue(undefined);
    vi.mocked(listen).mockClear().mockResolvedValue(() => {});
    MockAudio.instances = [];
    MockAudio.playImpl = () => Promise.resolve();
    vi.stubGlobal("Audio", MockAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("applies the event's volume to the created Audio element", async () => {
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());

    getPlayNotifyHandler()({ payload: playEvent("item_tango", 42) });

    expect(MockAudio.instances).toHaveLength(1);
    expect(MockAudio.instances[0].volume).toBeCloseTo(0.42);
  });

  it("logs frontend-received/audio-play-requested/audio-playing timing stages for the played event's correlation id, without blocking playback", async () => {
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());

    getPlayNotifyHandler()({ payload: playEvent("item_blood_grenade") });
    await Promise.resolve();
    await Promise.resolve();

    const stages = vi.mocked(logGameSoundTiming).mock.calls
      .filter(([correlationId]) => correlationId === "corr-item_blood_grenade")
      .map(([, stage]) => stage);
    expect(stages).toEqual(["frontend-received", "audio-play-requested", "audio-playing"]);
  });

  it("does not play when the master toggle is off", async () => {
    vi.mocked(getGameSoundSettings).mockResolvedValue({ ...baseSettings, enabled: false });
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());

    getPlayNotifyHandler()({ payload: playEvent("item_tango") });

    expect(MockAudio.instances).toHaveLength(0);
  });

  it("preview plays the requested asset at the given volume and stops any previous preview first", async () => {
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());

    await engine.preview("asset-1", 55);
    expect(previewGameSound).toHaveBeenCalledWith("asset-1");
    expect(MockAudio.instances).toHaveLength(1);
    expect(MockAudio.instances[0].volume).toBeCloseTo(0.55);

    const pauseSpy = vi.spyOn(MockAudio.instances[0], "pause");
    await engine.preview("asset-1", 80);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(MockAudio.instances).toHaveLength(2);
  });

  it("a playback error cleans up and does not break the listener for the next event", async () => {
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());
    const handler = getPlayNotifyHandler();

    handler({ payload: playEvent("item_tango") });
    expect(MockAudio.instances).toHaveLength(1);
    // Simulate a playback failure on the first clip.
    MockAudio.instances[0].onerror?.();

    // The listener must still be functional afterwards - a second event
    // plays normally rather than the engine getting stuck "playing" forever.
    handler({ payload: playEvent("item_flask") });
    expect(MockAudio.instances).toHaveLength(2);
  });

  it("bounds a burst of events instead of queuing them all", async () => {
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());
    const handler = getPlayNotifyHandler();

    // 4 events fire back to back before the first ever finishes - only the
    // first is played immediately; MAX_QUEUED_GAME_SOUNDS (2) more are held;
    // the 4th is dropped rather than growing the queue unbounded.
    handler({ payload: playEvent("a") });
    handler({ payload: playEvent("b") });
    handler({ payload: playEvent("c") });
    handler({ payload: playEvent("d") });

    expect(MockAudio.instances).toHaveLength(1);

    // Draining the queue plays the 2 that were held, but never the dropped 4th.
    MockAudio.instances[0].onended?.();
    await Promise.resolve();
    MockAudio.instances[1].onended?.();
    await Promise.resolve();
    expect(MockAudio.instances).toHaveLength(3);
  });

  it("setMaster/setBinding/removeBinding/chooseAndBindFile call through to the API", async () => {
    let engine!: ReturnType<typeof useGameSoundEngine>;
    render(<Harness onEngine={(e) => { engine = e; }} />);
    await waitFor(() => expect(engine.settings).not.toBeNull());

    vi.mocked(updateGameSoundMaster).mockResolvedValue({ ...baseSettings, enabled: false });
    await engine.setMaster(false, 70);
    expect(updateGameSoundMaster).toHaveBeenCalledWith(false, 70);

    vi.mocked(setGameSoundBinding).mockResolvedValue(baseSettings);
    await engine.setBinding("item_tango", "itemUsed", "asset-1");
    expect(setGameSoundBinding).toHaveBeenCalledWith("item_tango", "itemUsed", "asset-1");

    vi.mocked(removeGameSoundBinding).mockResolvedValue(baseSettings);
    await engine.removeBinding("item_tango");
    expect(removeGameSoundBinding).toHaveBeenCalledWith("item_tango");

    vi.mocked(importAndBindGameSound).mockResolvedValue(baseSettings);
    await engine.chooseAndBindFile("item_tango", "itemUsed");
    expect(importAndBindGameSound).toHaveBeenCalledWith("item_tango", "itemUsed");
  });
});
