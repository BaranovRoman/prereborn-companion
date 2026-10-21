import { useCallback, useState } from "react";
import { DEFAULT_SKIP_SHORTCUT } from "../chat/hotkey-format";
import type { SkipHotkeyStatus } from "../core/contracts";
import { HotkeyField, SettingsGroup, SettingsRow, Switch } from "./ui";

// A hotkey status rendered by the reusable recorder is the
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

// WK-135 - one hotkey's enable switch + shortcut editor, shared by every
// global hotkey (TTS skip, Twitch clips, Dota overlay). Own local error state
// per instance - two hotkeys must not share one recording session (WK-180:
// the recording itself lives in the shared HotkeyField).
export function HotkeyBindRow({ enableDescription, bindLabel, status, busy, defaultShortcut, onUpdate }: RowProps) {
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback((enabled: boolean, shortcut: string) => {
    setError(null);
    onUpdate(enabled, shortcut).catch((cause) => setError(String(cause)));
  }, [onUpdate]);

  const failed = !!status?.enabled && !status.registered;
  const problem = error ?? status?.lastError;
  return (
    <SettingsGroup>
      <SettingsRow label={bindLabel} description={enableDescription}>
        <Switch aria-label={`Горячая клавиша «${bindLabel}»`} checked={status?.enabled ?? false} disabled={busy} onChange={(event) => apply(event.target.checked, status?.shortcut ?? defaultShortcut)} />
      </SettingsRow>
      <SettingsRow
        label="Сочетание клавиш"
        description="Нажмите на поле и затем нужные клавиши"
        status={failed || problem ? <>
          {failed && <span className="ui-text-danger">Не удалось зарегистрировать</span>}
          {problem && <span className="ui-text-danger">Не удалось применить горячую клавишу: {problem}</span>}
        </> : undefined}
      >
        <HotkeyField
          label={bindLabel}
          shortcut={status?.shortcut ?? defaultShortcut}
          defaultShortcut={defaultShortcut}
          disabled={busy}
          invalid={failed || !!problem}
          onChange={(shortcut) => apply(true, shortcut)}
          onReset={() => apply(true, defaultShortcut)}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

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
// shipped (WK-93). Rendered inside Settings → «Горячие клавиши».
export function HotkeySettings({ status, busy, onUpdate }: Props) {
  return (
    <HotkeyBindRow
      enableDescription="Останавливает текущую озвучку и переходит к следующему сообщению. Работает, даже когда Companion свёрнут или открыта игра; очередь не очищается."
      bindLabel="Пропустить озвучку"
      status={status}
      busy={busy}
      defaultShortcut={DEFAULT_SKIP_SHORTCUT}
      onUpdate={onUpdate}
    />
  );
}
