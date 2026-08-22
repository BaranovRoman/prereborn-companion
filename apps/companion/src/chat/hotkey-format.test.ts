import { describe, expect, it } from "vitest";
import { shortcutFromKeyboardEvent } from "./hotkey-format";

const key = (code: string, mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as KeyboardEvent);

describe("shortcutFromKeyboardEvent", () => {
  it("builds a Ctrl+Alt+<key> combo in a fixed modifier order", () => {
    expect(shortcutFromKeyboardEvent(key("F10", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+F10");
  });
  it("includes every held modifier, in Ctrl/Alt/Shift/Super order regardless of press order", () => {
    expect(shortcutFromKeyboardEvent(key("KeyS", { metaKey: true, shiftKey: true, ctrlKey: true })))
      .toBe("Ctrl+Shift+Super+KeyS");
  });
  it("ignores a lone modifier key press - waits for the real key", () => {
    expect(shortcutFromKeyboardEvent(key("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(shortcutFromKeyboardEvent(key("AltRight", { altKey: true }))).toBeNull();
  });
  it("allows a bare function key with no modifier", () => {
    expect(shortcutFromKeyboardEvent(key("F9"))).toBe("F9");
    expect(shortcutFromKeyboardEvent(key("F24"))).toBe("F24");
  });
  it("rejects a bare non-function key with no modifier, to avoid globally binding an ordinary key", () => {
    expect(shortcutFromKeyboardEvent(key("KeyS"))).toBeNull();
    expect(shortcutFromKeyboardEvent(key("Digit5"))).toBeNull();
  });
  it("accepts a modified ordinary key", () => {
    expect(shortcutFromKeyboardEvent(key("KeyS", { ctrlKey: true }))).toBe("Ctrl+KeyS");
  });
});
