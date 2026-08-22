// WK-83 - converts a captured browser KeyboardEvent into the shortcut
// string format the Rust side's global_hotkey parser accepts (see
// src-tauri/src/hotkeys.rs / the global-hotkey crate's `parse_hotkey`).
// That parser splits on "+" and matches modifier tokens case-insensitively,
// then falls back to matching the remaining token against `KeyboardEvent`
// `code` values almost verbatim (`"KeyS"`, `"F10"`, `"Digit5"`,
// `"ArrowUp"`, ...) - so building the string directly from `event.code`
// needs no lookup table, just modifier detection.

// Mirrors DEFAULT_SKIP_SHORTCUT in src-tauri/src/hotkeys.rs - used by the
// settings-page "Сбросить по умолчанию" button. Chosen as a combo unlikely
// to already be bound in Dota (which mostly uses unmodified letters/Alt-
// click) or OBS (user-configurable, rarely defaults to a modified F-key).
export const DEFAULT_SKIP_SHORTCUT = "CommandOrControl+Alt+F10";

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

// A function key (F1-F24) is accepted on its own, unmodified - the Silero/
// Piper/OBS ecosystem commonly binds bare F-keys and a collision there is
// low-risk. Any other key requires at least one modifier, so recording
// never binds a plain letter/digit globally (which would fire on every
// keystroke in Dota/chat/anywhere else).
const BARE_KEY_ALLOWED = /^F([1-9]|1\d|2[0-4])$/;

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) return null; // wait for a real key, not just the modifier itself
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  if (parts.length === 0 && !BARE_KEY_ALLOWED.test(event.code)) return null;
  parts.push(event.code);
  return parts.join("+");
}
