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

  // Regression for a real reported bug: a streamer could not assign F12 as
  // the skip-TTS hotkey. Code review found this recorder never singled out
  // F12 (or any F-key) - BARE_KEY_ALLOWED covers the whole F1-F24 range - so
  // these pin down F9-F12 (the specific keys the task called out as
  // desirable streamer controls) plus a modified F12 combo as an executable
  // fact, not just a reading of the regex. If F12 is still refused in a real
  // build, the block is happening below this function (OS/webview level,
  // e.g. Chromium's F12-opens-DevTools interception) - see the PR report.
  it("allows every one of F9, F10, F11, F12 bare, and a modified F12 combo", () => {
    expect(shortcutFromKeyboardEvent(key("F9"))).toBe("F9");
    expect(shortcutFromKeyboardEvent(key("F10"))).toBe("F10");
    expect(shortcutFromKeyboardEvent(key("F11"))).toBe("F11");
    expect(shortcutFromKeyboardEvent(key("F12"))).toBe("F12");
    expect(shortcutFromKeyboardEvent(key("F12", { ctrlKey: true }))).toBe("Ctrl+F12");
  });

  // The standalone allowlist must stay narrow (function keys only) - a bare
  // Space/Enter/letter must never become a global shortcut by accident while
  // typing elsewhere in the recorder or the rest of the app.
  it("rejects other bare special keys (Space, Enter) with no modifier", () => {
    expect(shortcutFromKeyboardEvent(key("Space"))).toBeNull();
    expect(shortcutFromKeyboardEvent(key("Enter"))).toBeNull();
  });
});
