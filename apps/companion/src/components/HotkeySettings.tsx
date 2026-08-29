import { useEffect, useState } from "react";
import { DEFAULT_SKIP_SHORTCUT, shortcutFromKeyboardEvent } from "../chat/hotkey-format";
import type { SkipHotkeyStatus } from "../services/dotaCompanionApi";
import { Button, Checkbox } from "./ui";

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

  return (
    <section className="hotkey-settings">
      <h2>Пропустить озвучку</h2>
      <Checkbox
        checked={status?.enabled ?? false}
        disabled={busy}
        onChange={(event) => toggleEnabled(event.target.checked)}
        label="Включить горячую клавишу"
      />
      <p className="hotkey-settings__status">
        Текущая комбинация: <strong>{status?.shortcut ?? DEFAULT_SKIP_SHORTCUT}</strong>
        {status?.enabled && !status?.registered && " (не удалось зарегистрировать)"}
      </p>
      <div className="tts-buttons">
        <Button onClick={() => { setError(null); setRecording(true); }} disabled={busy || recording}>
          {recording ? "Нажмите новую комбинацию… (Esc — отмена)" : "Изменить"}
        </Button>
        <Button onClick={resetToDefault} disabled={busy || recording}>
          Сбросить по умолчанию
        </Button>
      </div>
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
