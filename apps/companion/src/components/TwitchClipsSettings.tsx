import { useState } from "react";
import { DEFAULT_CLIP_SHORTCUT } from "../chat/hotkey-format";
import { useTwitchClips } from "../clips/useTwitchClips";
import type { ClipHistoryEntry, ClipsAccess, ClipsStatus } from "../core/contracts";
import { HotkeyBindRow } from "./HotkeySettings";
import { Button, Notice, Panel, Select, SettingsGroup, SettingsRow } from "./ui";

// WK-178 - Settings → «Клипы Twitch». Helix Create Clip really accepts a
// 5..60 s `duration` (default 30), so the duration setting is a real one,
// not a cosmetic preference.
const DURATION_PRESETS = [10, 15, 20, 30, 45, 60];
const DEFAULT_DURATION = 30;

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export function TwitchClipsSettings() {
  const clips = useTwitchClips();
  return <TwitchClipsSettingsView {...clips} />;
}

type ViewProps = Pick<
  ReturnType<typeof useTwitchClips>,
  "status" | "access" | "accessError" | "busy" | "updateHotkey" | "updateDuration" | "clearHistory" | "createNow" | "openClip" | "reconnectTwitch"
>;

export function TwitchClipsSettingsView({
  status, access, accessError, busy, updateHotkey, updateDuration, clearHistory, createNow, openClip, reconnectTwitch,
}: ViewProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const guard = (action: () => Promise<unknown>) => {
    setActionError(null);
    action().catch((cause) => setActionError(String(cause)));
  };
  const copy = (clip: ClipHistoryEntry) => guard(async () => {
    await navigator.clipboard.writeText(clip.url);
    setCopiedId(clip.id);
  });

  const duration = status?.durationSeconds ?? DEFAULT_DURATION;
  const durations = DURATION_PRESETS.includes(duration) ? DURATION_PRESETS : [...DURATION_PRESETS, duration].sort((a, b) => a - b);
  const creating = status?.phase.kind === "creating";

  return (
    <Panel
      className="clips-settings"
      title="Клипы Twitch"
      description="Клип текущей трансляции через официальный Twitch API — без OBS и плагинов. Работает только во время эфира."
    >
      <AccessNotice access={access} accessError={accessError} onReconnect={() => guard(reconnectTwitch)} />

      <HotkeyBindRow
        enableDescription="Создаёт клип, даже когда Companion свёрнут или открыта игра"
        bindLabel="Создать клип"
        status={status}
        busy={busy}
        defaultShortcut={DEFAULT_CLIP_SHORTCUT}
        onUpdate={updateHotkey}
      />
      <SettingsGroup>
        <SettingsRow label="Длительность клипа" description="Последние секунды эфира до нажатия (Twitch: 5–60 с)">
          <Select
            aria-label="Длительность клипа"
            className="clips-settings__duration"
            value={duration}
            disabled={busy}
            onChange={(event) => guard(() => updateDuration(Number(event.target.value)))}
          >
            {durations.map((seconds) => <option key={seconds} value={seconds}>{seconds} с</option>)}
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <div className="ui-button-row">
        <Button variant="primary" disabled={!status || creating} onClick={() => guard(createNow)}>
          {creating ? "Создаю клип…" : "Создать клип сейчас"}
        </Button>
      </div>
      <PhaseLine status={status} onReconnect={() => guard(reconnectTwitch)} />
      {actionError && <Notice tone="danger">Ошибка: {actionError}</Notice>}

      <div className="clips-settings__history">
        <div className="clips-settings__history-header">
          <h3>Последние клипы</h3>
          {!!status?.history.length && (
            <Button variant="ghost" size="small" disabled={busy} onClick={() => guard(clearHistory)}>Очистить историю</Button>
          )}
        </div>
        {!status?.history.length ? (
          <p className="ui-text-muted clips-settings__empty">Клипов пока нет. Они появятся здесь после создания через Companion.</p>
        ) : (
          <ol className="clips-history" aria-label="Последние клипы">
            {status.history.map((clip) => (
              <li key={clip.id} className="clips-history__item">
                <div className="clips-history__meta">
                  <strong title={clip.title ?? undefined}>{clip.title ?? "Без названия"}</strong>
                  <span><time dateTime={clip.createdAt}>{formatTime(clip.createdAt)}</time> · <span className="clips-history__url" title={clip.url}>{clip.url}</span></span>
                </div>
                <div className="clips-history__actions">
                  <Button size="small" onClick={() => guard(() => openClip(clip.id))}>Открыть</Button>
                  <Button size="small" variant="ghost" onClick={() => copy(clip)}>
                    {copiedId === clip.id ? "Скопировано" : "Копировать ссылку"}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="ui-text-muted clips-settings__footnote">Фрагмент выбирает Twitch. История хранится только на этом компьютере.</p>
      </div>
    </Panel>
  );
}

function AccessNotice({ access, accessError, onReconnect }: { access: ClipsAccess | null; accessError: string | null; onReconnect: () => void }) {
  if (accessError) return <Notice tone="warning">Не удалось проверить доступ к клипам: {accessError}</Notice>;
  if (!access) return null;
  if (!access.configured) return <Notice tone="danger">Twitch-интеграция не настроена на сервере.</Notice>;
  if (!access.accountConnected) {
    return <Notice tone="warning">Twitch не подключён. Подключите его в блоке «Интеграции».</Notice>;
  }
  if (access.scopeGranted === false) {
    return (
      <Notice tone="danger" action={<Button variant="primary" size="small" onClick={onReconnect}>Переподключить Twitch</Button>}>
        Нет разрешения Twitch на создание клипов. Переподключите Twitch и подтвердите новый доступ.
      </Notice>
    );
  }
  return null;
}

function PhaseLine({ status, onReconnect }: { status: ClipsStatus | null; onReconnect: () => void }) {
  const phase = status?.phase;
  if (!phase || phase.kind === "idle") return null;
  if (phase.kind === "creating") return <Notice>Создаю клип… Twitch подтверждает его до 15 секунд.</Notice>;
  if (phase.kind === "succeeded") return <Notice tone="success">Клип создан: {phase.clip.title ?? phase.clip.url}</Notice>;
  return (
    <Notice tone="danger" action={phase.code === "reauth_required" ? <Button size="small" onClick={onReconnect}>Переподключить Twitch</Button> : undefined}>
      {phase.message}
    </Notice>
  );
}
