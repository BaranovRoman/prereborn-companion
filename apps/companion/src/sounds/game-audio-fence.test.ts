import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
import { GameAudioFenceRegistry, type GameAudioToken } from "./game-audio-fence";
const token = (id: string, generation = 1): GameAudioToken => ({ id, scope: { instance: "core", generation, epoch: 1, session: "session" } });
describe("game-only fence", () => {
  it("cancels pending game players, revokes late commands, leaves unrelated Twitch audio alone", () => {
    const registry = new GameAudioFenceRegistry();
    const game = vi.fn(() => true), twitch = { pause: vi.fn() };
    registry.track(token("queued"), game);registry.track(token("playing"), game);
    expect(registry.fence({ instance: "core", generation: 1, requestId: "fence", playbackIds: ["queued", "playing"] })).toBe(true);
    expect(game).toHaveBeenCalledTimes(2);expect(twitch.pause).not.toHaveBeenCalled();
    expect(registry.track(token("late"), game)).toBe(false);
    expect(registry.track(token("fresh", 2), game)).toBe(true);
  });
  it("does not turn an Unknown cancellation into stop proof on a second fence", () => {
    const registry = new GameAudioFenceRegistry();
    registry.track(token("playing"), () => false);
    const request = { instance: "core", generation: 1, requestId: "fence", playbackIds: ["playing"] };
    expect(registry.fence(request)).toBe(false);expect(registry.fence(request)).toBe(false);
  });
  it("does not cancel a new generation or another core instance", () => {
    const registry = new GameAudioFenceRegistry();const cancel = vi.fn(() => true);
    registry.track(token("new", 2), cancel);
    registry.track({ ...token("other"), scope: { ...token("other").scope, instance: "other" } }, cancel);
    registry.fence({ instance: "core", generation: 1, requestId: "fence", playbackIds: [] });
    expect(cancel).not.toHaveBeenCalled();
  });
});
it("unload reports Unknown for pending game audio without claiming cancellation", async () => {
  const { invoke } = await import("@tauri-apps/api/core");const registry = new GameAudioFenceRegistry();const cancel = vi.fn(() => true);
  const playback = token("unloading");registry.track(playback, cancel);registry.unload();
  expect(invoke).toHaveBeenLastCalledWith("plugin_audio_ack", { token: playback, status: "unknown" });expect(cancel).not.toHaveBeenCalled();
});

it("a reloaded registry cannot prove fencing playbacks it never owned", () => {
  expect(new GameAudioFenceRegistry().fence({ instance: "core", generation: 1, requestId: "restart", playbackIds: ["lost-player"] })).toBe(false);
});
