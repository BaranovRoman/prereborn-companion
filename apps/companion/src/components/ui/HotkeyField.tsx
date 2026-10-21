import { Fragment, useEffect, useState } from "react";
import { shortcutFromKeyboardEvent } from "../../chat/hotkey-format";
import { IconButton } from "./IconButton";

const KEY_LABELS: Record<string, string> = {
  CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Control: "Ctrl", Super: "Win", Meta: "Win",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", Backquote: "`",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
};

/** "CommandOrControl+Alt+KeyC" -> ["Ctrl", "Alt", "C"]. Display only; the stored string is untouched. */
export function shortcutKeys(shortcut: string): string[] {
  return shortcut.split("+").filter(Boolean).map((part) => KEY_LABELS[part]
    ?? part.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1").replace(/^Numpad(\w+)$/, "Num $1"));
}
export const formatShortcut = (shortcut: string) => shortcutKeys(shortcut).join("+");

export interface HotkeyFieldProps {
  /** What the shortcut does, for the accessible name ("Создать клип"). */
  label: string;
  shortcut: string;
  defaultShortcut: string;
  disabled?: boolean;
  /** Registration problem / conflict: highlights the field. */
  invalid?: boolean;
  onChange: (shortcut: string) => void;
  onReset: () => void;
}

// The one shortcut editor (Twitch clips, TTS skip, Dota overlay): current
// combination as key caps; click to record (Esc cancels), reset to default.
export function HotkeyField({ label, shortcut, defaultShortcut, disabled, invalid, onChange, onReset }: HotkeyFieldProps) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code === "Escape") { setRecording(false); return; }
      const next = shortcutFromKeyboardEvent(event);
      if (!next) return; // lone modifier, or an unmodified non-function key - keep waiting
      setRecording(false);
      onChange(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, onChange]);

  const keys = shortcutKeys(shortcut);
  return (
    <span className="ui-hotkey">
      <button
        type="button"
        className={`ui-hotkey__value${recording ? " is-recording" : ""}${invalid && !recording ? " is-error" : ""}`}
        aria-label={recording ? `${label}: нажмите сочетание клавиш, Esc — отмена` : `${label}: ${keys.join("+")}. Изменить`}
        disabled={disabled}
        onClick={() => setRecording((value) => !value)}
      >
        {recording ? "Нажмите сочетание… (Esc — отмена)" : keys.map((key, index) => (
          <Fragment key={index}>{index > 0 && <span className="ui-kbd-plus">+</span>}<kbd className="ui-kbd">{key}</kbd></Fragment>
        ))}
      </button>
      <IconButton
        aria-label="Сбросить по умолчанию"
        title={`Сбросить по умолчанию (${formatShortcut(defaultShortcut)})`}
        disabled={disabled || recording}
        onClick={onReset}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </IconButton>
    </span>
  );
}
