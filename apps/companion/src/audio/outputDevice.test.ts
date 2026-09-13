// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findRealDeviceForDefault,
  findSystemDefaultSignature,
  isSelectedDeviceMissing,
  loadSelection,
  sameSignature,
  saveSelection,
  toOutputDeviceOptions,
  type OutputDeviceSelection,
} from "./outputDevice";

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

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("outputDevice persistence", () => {
  it("defaults to system-default when nothing is stored", () => {
    expect(loadSelection()).toEqual({ mode: "system-default" });
  });

  it("round-trips an explicit selection through localStorage", () => {
    const selection: OutputDeviceSelection = { mode: "explicit", deviceId: "dev-42", label: "USB Headset" };
    saveSelection(selection);
    expect(loadSelection()).toEqual(selection);
  });

  it("falls back to system-default for corrupt/garbage stored JSON", () => {
    localStorage.setItem("companion-audio-output-device-v1", "{not json");
    expect(loadSelection()).toEqual({ mode: "system-default" });
  });

  it("falls back to system-default for an explicit selection missing a deviceId", () => {
    localStorage.setItem("companion-audio-output-device-v1", JSON.stringify({ mode: "explicit" }));
    expect(loadSelection()).toEqual({ mode: "system-default" });
  });
});

describe("toOutputDeviceOptions", () => {
  it("excludes the synthetic default/communications aggregate entries", () => {
    const devices = [
      device({ deviceId: "default", label: "Default - Speakers" }),
      device({ deviceId: "communications", label: "Communications - Speakers" }),
      device({ deviceId: "real-1", label: "Speakers (Realtek)" }),
      device({ deviceId: "mic-1", kind: "audioinput", label: "Microphone" }),
    ];
    expect(toOutputDeviceOptions(devices)).toEqual([{ deviceId: "real-1", label: "Speakers (Realtek)" }]);
  });

  it("falls back to a generic label when the real label is empty (labels not unlocked)", () => {
    const devices = [device({ deviceId: "real-1", label: "" })];
    expect(toOutputDeviceOptions(devices)[0].label).toBe("Устройство real-1");
  });
});

describe("findSystemDefaultSignature / findRealDeviceForDefault", () => {
  it("returns null when there is no default entry", () => {
    expect(findSystemDefaultSignature([device({ deviceId: "real-1" })])).toBeNull();
    expect(findRealDeviceForDefault([device({ deviceId: "real-1" })])).toBeNull();
  });

  it("resolves the real device sharing the default entry's groupId", () => {
    const devices = [
      device({ deviceId: "default", groupId: "group-a", label: "Default - Speakers" }),
      device({ deviceId: "real-1", groupId: "group-a", label: "Speakers (Realtek)" }),
      device({ deviceId: "real-2", groupId: "group-b", label: "Headset" }),
    ];
    expect(findSystemDefaultSignature(devices)).toEqual({ groupId: "group-a", label: "Default - Speakers" });
    expect(findRealDeviceForDefault(devices)).toEqual({ deviceId: "real-1", label: "Speakers (Realtek)" });
  });

  it("falls back to the literal 'default' sink id when no matching real device is found (labels not unlocked)", () => {
    const devices = [device({ deviceId: "default", groupId: "group-a", label: "Default" })];
    expect(findRealDeviceForDefault(devices)).toEqual({ deviceId: "default", label: "Default" });
  });
});

describe("isSelectedDeviceMissing", () => {
  const devices = [device({ deviceId: "real-1" })];

  it("is never missing in system-default mode", () => {
    expect(isSelectedDeviceMissing({ mode: "system-default" }, devices)).toBe(false);
  });

  it("is never missing for the literal 'default' sink id", () => {
    expect(isSelectedDeviceMissing({ mode: "explicit", deviceId: "default", label: "x" }, [])).toBe(false);
  });

  it("is missing when the explicit deviceId is no longer enumerable", () => {
    expect(isSelectedDeviceMissing({ mode: "explicit", deviceId: "gone", label: "x" }, devices)).toBe(true);
  });

  it("is not missing when the explicit deviceId is still present", () => {
    expect(isSelectedDeviceMissing({ mode: "explicit", deviceId: "real-1", label: "x" }, devices)).toBe(false);
  });
});

describe("sameSignature", () => {
  it("treats two nulls as equal", () => {
    expect(sameSignature(null, null)).toBe(true);
  });

  it("treats null and non-null as different", () => {
    expect(sameSignature(null, { groupId: "a", label: "A" })).toBe(false);
  });

  it("compares by groupId and label", () => {
    expect(sameSignature({ groupId: "a", label: "A" }, { groupId: "a", label: "A" })).toBe(true);
    expect(sameSignature({ groupId: "a", label: "A" }, { groupId: "b", label: "A" })).toBe(false);
  });
});
