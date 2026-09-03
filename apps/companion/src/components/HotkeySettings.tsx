import { useEffect, useState } from "react";
import { DEFAULT_OVERLAY_TOGGLE_SHORTCUT, DEFAULT_SKIP_SHORTCUT, shortcutFromKeyboardEvent } from "../chat/hotkey-format";
import type { SkipHotkeyStatus } from "../services/dotaCompanionApi";
import { Checkbox, SettingsGroup, SettingsRow } from "./ui";

// Any hotkey status this file renders (Skip TTS, overlay toggle, ...) is the
// exact same shape - a structural interface, not a union of the two
// generated types, so HotkeyBindRow doesn't need to know which hotkey it's
// showing.
interface HotkeyStatusLike {
  enabled: boolean;
  shortcut: string;
  registered: boolean;
  lastError: string | null;
}

interface RowProps {
  enableDescription: string;
  bindLabel: string;
  status: HotkeyStatusLike | null;
  busy: boolean;
  defaultShortcut: string;
  onUpdate: (enabled: boolean, shortcut: string) => Promise<void>;
}

// WK-135 - extracted from the single-hotkey component this used to be, so a
// second, independent hotkey (overlay show/hide) can reuse the exact same
// recording/reset/enable behavior (see the module comment below) without
// duplicating it. Own local recording/error state per instance - two
// hotkeys must not share one recording session.
function HotkeyBindRow({ enableDescription, bindLabel, status, busy, defaultShortcut, onUpdate }: RowProps) {
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
    onUpdate(enabled, status?.shortcut ?? defaultShortcut).catch((cause) => setError(String(cause)));
  };
  const resetToDefault = () => {
    setError(null);
    onUpdate(true, defaultShortcut).catch((cause) => setError(String(cause)));
  };

  const fieldsDisabled = busy || recording;

  return (
    <>
      <SettingsGroup>
        <SettingsRow label="Включить горячую клавишу" description={enableDescription}>
          <Checkbox checked={status?.enabled ?? false} disabled={busy} onChange={(event) => toggleEnabled(event.target.checked)} />
        </SettingsRow>
        <SettingsRow
          label={bindLabel}
          description={status?.enabled && !status?.registered ? "Не удалось зарегистрировать" : "Комбинация клавиш"}
        >
          <div className="hotkey-keybind-group">
            <button
              type="button"
              className={`hotkey-keybind${recording ? " is-recording" : ""}`}
              disabled={fieldsDisabled}
              onClick={() => { setError(null); setRecording(true); }}
            >
              {recording ? "Нажмите клавиши… (Esc)" : (status?.shortcut ?? defaultShortcut)}
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
    </>
  );
}

interface Props {
  status: SkipHotkeyStatus | null;
  busy: boolean;
  onUpdate: (enabled: boolean, shortcut: string) => Promise<void>;
  // WK-135 - overlay show/hide hotkey (primary control for WK-124's overlay
  // visibility switch). Optional so existing callers/tests that only know
  // about Skip TTS keep working unchanged - when provided, a second bind row
  // renders using the exact same HotkeyBindRow.
  overlay?: {
    status: HotkeyStatusLike | null;
    busy: boolean;
    onUpdate: (enabled: boolean, shortcut: string) => Promise<void>;
  };
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
export function HotkeySettings({ status, busy, onUpdate, overlay }: Props) {
  return (
    <section className="hotkey-settings">
      <h2>Горячие клавиши</h2>
      <HotkeyBindRow
        enableDescription="Пропустить озвучку текущего сообщения чата"
        bindLabel="Пропустить озвучку"
        status={status}
        busy={busy}
        defaultShortcut={DEFAULT_SKIP_SHORTCUT}
        onUpdate={onUpdate}
      />
      <p className="hotkey-settings__hint">
        Работает даже когда Companion свёрнут в трей или фокус в другом приложении (Dota, OBS). Останавливает
        текущую озвучку немедленно и переходит к следующему сообщению очереди; сама очередь не очищается, TTS не
        выключается. Никаких звуков при пропуске не воспроизводится.
      </p>
      {overlay && (
        <>
          <HotkeyBindRow
            enableDescription="Показать / скрыть PreReborn Overlay (WK-124)"
            bindLabel="Показать / скрыть оверлей"
            status={overlay.status}
            busy={overlay.busy}
            defaultShortcut={DEFAULT_OVERLAY_TOGGLE_SHORTCUT}
            onUpdate={overlay.onUpdate}
          />
          <p className="hotkey-settings__hint">
            Работает даже когда Companion свёрнут в трей. Переключает то же runtime-состояние видимости оверлея,
            что и раньше кнопка на Главной: GSI, сессия, MMR, OBS-сцены и Twitch/звуки продолжают работать как
            обычно, Browser Source не перезагружается.
          </p>
        </>
      )}
    </section>
  );
}
