// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useOverallVolume } from "./useOverallVolume";

const STORAGE_KEY = "companion-overall-volume-v1";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

// WK-135 - Audio Settings "Общий" multiplier. Defaults to 100 (no
// attenuation) so an existing user's TTS/Custom-Sounds volumes are
// unchanged until they touch this new slider - a safe, no-op-by-default
// migration (see useGameSoundEngine.ts/useTwitchChatSession.ts for where
// the actual multiplication happens).
describe("useOverallVolume", () => {
  it("defaults to 100 with nothing persisted", () => {
    const { result } = renderHook(() => useOverallVolume());
    expect(result.current.overallVolume).toBe(100);
  });

  it("persists and reloads a set value", () => {
    const { result, unmount } = renderHook(() => useOverallVolume());
    act(() => result.current.setOverallVolume(65));
    expect(result.current.overallVolume).toBe(65);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("65");
    unmount();

    const { result: reloaded } = renderHook(() => useOverallVolume());
    expect(reloaded.current.overallVolume).toBe(65);
  });

  it("clamps to the 0-100 boundary", () => {
    const { result } = renderHook(() => useOverallVolume());
    act(() => result.current.setOverallVolume(150));
    expect(result.current.overallVolume).toBe(100);
    act(() => result.current.setOverallVolume(-20));
    expect(result.current.overallVolume).toBe(0);
  });

  it("falls back to the default on a malformed persisted value", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const { result } = renderHook(() => useOverallVolume());
    expect(result.current.overallVolume).toBe(100);
  });
});
