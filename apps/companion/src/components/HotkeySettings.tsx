import { useEffect, useState } from "react";
import { DEFAULT_SKIP_SHORTCUT, shortcutFromKeyboardEvent } from "../chat/hotkey-format";
import type { SkipHotkeyStatus } from "../services/dotaCompanionApi";
import { Checkbox, SettingsGroup, SettingsRow } from "./ui";

interface Props {
  status: SkipHotkeyStatus | null;
  busy: boolean;
  onUpdate: (enabled: boolean, shortcut: string) => Promise<void>;
}

// Companion UI 2.0 follow-up - "пропустить озвучку" hotkey, moved here
// verbatim from TwitchChatPage's old "chat-settings" aside (see задача:
// "не реализовывай hotkeys заново, перенеси существующие controls"). Same
// component logic (recording via a captured keydown listener, Esc to
// cancel, reset-to-default), just relocated to Настройки - hotkeys aren't
// chat-specific, they're a general Companion setting that happened to live
// next to TTS controls only because that's where the feature originally
// shipped (WK-93).
//
// Visual-quality pass (Dota Keybindings reference): the shortcut is now a
// compact key-binding field (`.hotkey-keybind`) that IS the click target
// for recording, with a separate small reset icon beside it, laid out as a
// settings row - not a status paragraph + a text button.
export function HotkeySettings({ status, busy, onUpdate }: Props) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code === "Escape") { setRecording(false); return; }
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return; // lone modifier, or an unmodified non-function key - keep waiting
      setRecording(false);
      onUpdate(true, shortcut).catch((cause) => setError(String(cause)));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, onUpdate]);

  const toggleEnabled = (enabled: boolean) => {
    setError(null);
    onUpdate(enabled, status?.shortcut ?? DEFAULT_SKIP_SHORTCUT).catch((cause) => setError(String(cause)));
  };
  const resetToDefault = () => {
    setError(null);
    onUpdate(true, DEFAULT_SKIP_SHORTCUT).catch((cause) => setError(String(cause)));
  };

  const fieldsDisabled = busy || recording;

  return (
    <section className="hotkey-settings">
      <h2>Горячие клавиши</h2>
      <SettingsGroup>
        <SettingsRow label="Включить горячую клавишу" description="Пропустить озвучку текущего сообщения чата">
          <Checkbox checked={status?.enabled ?? false} disabled={busy} onChange={(event) => toggleEnabled(event.target.checked)} />
        </SettingsRow>
        <SettingsRow
          label="Пропустить озвучку"
          description={status?.enabled && !status?.registered ? "Не удалось зарегистрировать" : "Комбинация клавиш"}
        >
          <div className="hotkey-keybind-group">
            <button
              type="button"
              className={`hotkey-keybind${recording ? " is-recording" : ""}`}
              disabled={fieldsDisabled}
              onClick={() => { setError(null); setRecording(true); }}
            >
              {recording ? "Нажмите клавиши… (Esc)" : (status?.shortcut ?? DEFAULT_SKIP_SHORTCUT)}
            </button>
            <button
              type="button"
              className="hotkey-keybind__reset"
              title="Сбросить по умолчанию"
              aria-label="Сбросить по умолчанию"
              disabled={fieldsDisabled}
              onClick={resetToDefault}
            >
              ↺
            </button>
          </div>
        </SettingsRow>
      </SettingsGroup>
      {(error || status?.lastError) && (
        <p className="app__error">Не удалось применить горячую клавишу: {error ?? status?.lastError}</p>
      )}
      <p className="hotkey-settings__hint">
        Работает даже когда Companion свёрнут в трей или фокус в другом приложении (Dota, OBS). Останавливает
        текущую озвучку немедленно и переходит к следующему сообщению очереди; сама очередь не очищается, TTS не
        выключается. Никаких звуков при пропуске не воспроизводится.
      </p>
    </section>
  );
}
