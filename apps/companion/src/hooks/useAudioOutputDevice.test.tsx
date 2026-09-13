// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLabelsUnlockedForTests } from "../audio/outputDevice";
import { useAudioOutputDevice } from "./useAudioOutputDevice";

function device(overrides: Partial<MediaDeviceInfo> = {}): MediaDeviceInfo {
  return {
    deviceId: "dev-1",
    groupId: "group-1",
    kind: "audiooutput",
    label: "Speakers",
    toJSON: () => ({}),
    ...overrides,
  } as MediaDeviceInfo;
}

function installMediaDevices(initial: MediaDeviceInfo[]) {
  let devices = initial;
  const listeners: Array<() => void> = [];
  const mediaDevices = {
    enumerateDevices: vi.fn(() => Promise.resolve(devices)),
    getUserMedia: vi.fn(() => Promise.reject(new Error("permission denied in test"))),
    addEventListener: vi.fn((event: string, cb: () => void) => {
      if (event === "devicechange") listeners.push(cb);
    }),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  return {
    setDevices: (next: MediaDeviceInfo[]) => { devices = next; },
    fireDeviceChange: () => listeners.forEach((cb) => cb()),
  };
}

const DEFAULT_A = device({ deviceId: "default", groupId: "group-a", label: "Default - Speakers A" });
const REAL_A = device({ deviceId: "real-a", groupId: "group-a", label: "Speakers A" });
const DEFAULT_B = device({ deviceId: "default", groupId: "group-b", label: "Default - Headset B" });
const REAL_B = device({ deviceId: "real-b", groupId: "group-b", label: "Headset B" });

beforeEach(() => {
  localStorage.clear();
  resetLabelsUnlockedForTests();
});

describe("useAudioOutputDevice", () => {
  it("lists devices and does not show a change notice on the very first observation", async () => {
    installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());

    await waitFor(() => expect(result.current.devices).toEqual([{ deviceId: "real-a", label: "Speakers A" }]));
    expect(result.current.defaultDeviceChangedNotice).toBeNull();
    expect(result.current.switchPrompt).toBeNull();
    unmount();
  });

  it("system-default mode: a real default change shows an informational notice", async () => {
    const control = installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());
    await waitFor(() => expect(result.current.devices.length).toBe(1));

    control.setDevices([DEFAULT_B, REAL_B]);
    await act(async () => control.fireDeviceChange());

    expect(result.current.defaultDeviceChangedNotice).toContain("Headset B");
    unmount();
  });

  it("dismissing the notice acks the signature so it doesn't reappear for the same device", async () => {
    const control = installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());
    await waitFor(() => expect(result.current.devices.length).toBe(1));

    control.setDevices([DEFAULT_B, REAL_B]);
    await act(async () => control.fireDeviceChange());
    expect(result.current.defaultDeviceChangedNotice).not.toBeNull();

    act(() => result.current.dismissDefaultDeviceChangedNotice());
    expect(result.current.defaultDeviceChangedNotice).toBeNull();

    // Same device list observed again (e.g. the safety-net poll ticking) -
    // must not resurrect the already-acknowledged notice.
    await act(async () => control.fireDeviceChange());
    expect(result.current.defaultDeviceChangedNotice).toBeNull();
    unmount();
  });

  it("explicit-device mode: a default change offers Switch/Keep instead of auto-switching", async () => {
    const control = installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());
    await waitFor(() => expect(result.current.devices.length).toBe(1));

    act(() => result.current.setSelection({ mode: "explicit", deviceId: "real-a", label: "Speakers A" }));

    control.setDevices([DEFAULT_B, REAL_B, REAL_A]);
    await act(async () => control.fireDeviceChange());

    expect(result.current.switchPrompt).toEqual({ toLabel: "Default - Headset B" });
    // Never auto-switches - the pinned device selection is untouched until
    // the user explicitly acts.
    expect(result.current.selection).toEqual({ mode: "explicit", deviceId: "real-a", label: "Speakers A" });
    unmount();
  });

  it("onSwitchToNewDefault pins the real device behind the new default and clears the prompt", async () => {
    const control = installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());
    await waitFor(() => expect(result.current.devices.length).toBe(1));
    act(() => result.current.setSelection({ mode: "explicit", deviceId: "real-a", label: "Speakers A" }));

    control.setDevices([DEFAULT_B, REAL_B, REAL_A]);
    await act(async () => control.fireDeviceChange());
    expect(result.current.switchPrompt).not.toBeNull();

    act(() => result.current.onSwitchToNewDefault());

    expect(result.current.selection).toEqual({ mode: "explicit", deviceId: "real-b", label: "Headset B" });
    expect(result.current.switchPrompt).toBeNull();
    unmount();
  });

  it("onKeepCurrentDevice dedupes the prompt for the same transition without switching", async () => {
    const control = installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());
    await waitFor(() => expect(result.current.devices.length).toBe(1));
    act(() => result.current.setSelection({ mode: "explicit", deviceId: "real-a", label: "Speakers A" }));

    control.setDevices([DEFAULT_B, REAL_B, REAL_A]);
    await act(async () => control.fireDeviceChange());
    act(() => result.current.onKeepCurrentDevice());

    expect(result.current.switchPrompt).toBeNull();
    expect(result.current.selection).toEqual({ mode: "explicit", deviceId: "real-a", label: "Speakers A" });

    // Re-observing the exact same (still B) default must not re-prompt.
    await act(async () => control.fireDeviceChange());
    expect(result.current.switchPrompt).toBeNull();
    unmount();
  });

  it("flags the selected explicit device as missing once it drops out of the device list", async () => {
    const control = installMediaDevices([DEFAULT_A, REAL_A]);
    const { result, unmount } = renderHook(() => useAudioOutputDevice());
    await waitFor(() => expect(result.current.devices.length).toBe(1));
    act(() => result.current.setSelection({ mode: "explicit", deviceId: "real-a", label: "Speakers A" }));
    expect(result.current.selectedDeviceMissing).toBe(false);

    control.setDevices([DEFAULT_B, REAL_B]); // real-a is gone
    await act(async () => control.fireDeviceChange());

    expect(result.current.selectedDeviceMissing).toBe(true);
    expect(result.current.selectedDeviceLabel).toBe("Speakers A");
    unmount();
  });
});
