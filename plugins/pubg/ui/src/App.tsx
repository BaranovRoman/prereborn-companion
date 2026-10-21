import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { finishedAt, modeLabel, placeLabel, placeTone } from "./format";
import { Widget } from "./widget/Widget";
import { Badge, Button, Field, Input, Panel, RangeField, Select, SettingsGroup, SettingsRow, Switch } from "./components/ui";

type Tab = "matches" | "settings" | "widget";
const TABS: [Tab, string][] = [["matches", "Матчи"], ["settings", "Игрок"], ["widget", "OBS-виджет"]];
const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const date = (d: Date) => d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Pubg() {
  const [tab, setTab] = useState<Tab>("matches");
  const [status, setStatus] = useState<api.Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [settings, setSettings] = useState<api.Settings | null>(null);
  const [matches, setMatches] = useState<api.Matches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    void api.invoke<{ settings: api.Settings }>("settings.get")
      .then((r) => { if (!disposed) { setSettings(r.settings); if (!r.settings.player) setTab("settings"); } })
      .catch((e) => { if (!disposed) setError(String(e)); });
    let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const s = await api.invoke<api.Status>("status");
        if (disposed) return;
        setStatus(s); setStatusError(null);
        if (revision.current !== s.revision) {
          const m = await api.invoke<api.Matches>("matches");
          if (!disposed) { revision.current = s.revision; setMatches(m); }
        }
      } catch (e) { if (!disposed) setStatusError(String(e)); } finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  const save = useCallback(async (next: api.Settings) => {
    setError(null);
    try {
      const result = await api.invoke<{ settings: api.Settings; status: api.Status }>("settings.save", { settings: next });
      setSettings(result.settings); setStatus(result.status);
      return true;
    } catch (e) { setError(String(e)); return false; }
  }, []);

  const tone = statusError ? "danger" : !status ? "default" : !status.active || !status.configured ? "warning" : "success";
  const line = statusError ? "Состояние плагина не подтверждено"
    : !status ? "Подключение к плагину…"
    : !status.active ? "Плагин выключен — включите его на странице «Плагины», настройки доступны"
    : !status.configured ? "Укажите ник PUBG, чтобы загружать матчи"
    : `Сессия с ${status.sessionStartedAt ? time(status.sessionStartedAt) : "—"} · матчей в сессии: ${status.sessionMatches}${status.fetching ? " · обновление…" : ""}`;
  const apiNotice = api.apiStatusText(status?.apiStatus ?? null);

  return <main className="pubg">
    <header className="pubg-bar">
      <nav className="ui-tabs" aria-label="Разделы PUBG">{TABS.map(([key, title]) =>
        <button key={key} className={`ui-tabs__tab${tab === key ? " is-active" : ""}`} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); setError(null); }}>{title}</button>)}</nav>
      <p className={`pubg-bar__status pubg-bar__status--${tone}`} role="status"><span aria-hidden="true" className="pubg-bar__dot" />{line}</p>
    </header>
    <div className="pubg-alerts">
      {(statusError || error || status?.lastError) && <p className="ui-notice ui-notice--danger" role="alert">{statusError ?? error ?? status?.lastError}</p>}
      {status?.active && status.configured && apiNotice && <p className="ui-notice ui-notice--warning" role="alert">{apiNotice}</p>}
    </div>
    {!settings ? <p className="pubg-loading">Чтение настроек…</p> : <>
      {tab === "matches" && <MatchesView matches={matches} status={status} />}
      {tab === "settings" && <PlayerView settings={settings} save={save} />}
      {tab === "widget" && <WidgetView settings={settings} status={status} matches={matches} save={save} />}
    </>}
  </main>;
}

function MatchesView({ matches, status }: { matches: api.Matches | null; status: api.Status | null }) {
  const session = new Set(matches?.sessionIds ?? []);
  const list = matches?.matches ?? [];
  return <section className="pubg-view">
    <div className="pubg-view__header"><div>
      <h2>Последние матчи</h2>
      <p>Обновляется автоматически. В сессию попадают матчи, начатые после запуска Companion.</p>
    </div>
    <Button variant="ghost" disabled={!status?.active || !status.configured || status.fetching} onClick={() => void api.invoke("refresh").catch(() => undefined)}>Обновить</Button></div>
    {!matches ? <p className="ui-text-muted">Чтение истории…</p>
      : list.length === 0 ? <p className="ui-text-muted">{status?.configured ? "Матчей пока нет. Результат появляется в PUBG API через несколько минут после окончания матча." : "Укажите ник на вкладке «Игрок»."}</p>
      : <div className="pubg-matches" role="table" aria-label="Матчи PUBG">
        <div className="pubg-match pubg-match--head" role="row">
          <span role="columnheader">Карта</span><span role="columnheader">Место</span><span role="columnheader">Убийства</span>
          <span role="columnheader">Урон</span><span role="columnheader">Режим</span><span role="columnheader">Завершён</span><span />
        </div>
        {list.map((m) => <div key={m.id} className="pubg-match" role="row">
          <strong role="cell">{m.map}</strong>
          <span role="cell" className={`pubg-match__place pubg-match__place--${placeTone(m.place)}`}>{placeLabel(m.place)}</span>
          <span role="cell" className="pubg-match__num">{m.kills}</span>
          <span role="cell" className="pubg-match__num">{m.damage}</span>
          <span role="cell" className="pubg-match__mode">{modeLabel(m.gameMode)}</span>
          <time role="cell">{date(finishedAt(m.createdAt, m.durationSec))}</time>
          <span role="cell">{session.has(m.id) && <Badge tone="success">Сессия</Badge>}</span>
        </div>)}
      </div>}
  </section>;
}

function PlayerView({ settings, save }: { settings: api.Settings; save: (s: api.Settings) => Promise<boolean> }) {
  const [player, setPlayer] = useState(settings.player);
  const [platform, setPlatform] = useState<api.Platform>(settings.platform);
  const [saved, setSaved] = useState(false);
  const valid = /^[A-Za-z0-9_-]{2,32}$/.test(player.trim());
  const dirty = player.trim() !== settings.player || platform !== settings.platform;
  return <section className="pubg-view">
    <div className="pubg-view__header"><div><h2>Игрок</h2><p>Ник и платформа для загрузки матчей через официальный PUBG API.</p></div></div>
    <Panel title="Аккаунт PUBG" description="Смена ника или платформы начинает отдельную историю.">
      <form className="pubg-player" onSubmit={(e) => { e.preventDefault(); if (!valid || !dirty) return; void save({ ...settings, player: player.trim(), platform }).then(setSaved); }}>
        <Field label="Игровой ник" hint="Как в игре, с учётом регистра">
          <Input value={player} maxLength={32} autoComplete="off" spellCheck={false} aria-invalid={player !== "" && !valid} onChange={(e) => { setPlayer(e.target.value); setSaved(false); }} />
        </Field>
        <Field label="Платформа">
          <Select value={platform} onChange={(e) => { setPlatform(e.target.value as api.Platform); setSaved(false); }}>
            {api.PLATFORMS.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
          </Select>
        </Field>
        <div className="ui-button-row">
          <Button type="submit" variant="primary" disabled={!valid || !dirty}>Сохранить</Button>
          {saved && !dirty && <span className="ui-text-success" role="status">Сохранено</span>}
          {player !== "" && !valid && <span className="ui-text-danger">Латинские буквы, цифры, «_» и «-», от 2 до 32 символов.</span>}
        </div>
      </form>
    </Panel>
    <p className="ui-text-muted pubg-hint">Плагин не читает память игры и не взаимодействует с клиентом PUBG — только с публичной статистикой PUBG API через сервер Prereborn.</p>
  </section>;
}

function WidgetView({ settings, status, matches, save }: { settings: api.Settings; status: api.Status | null; matches: api.Matches | null; save: (s: api.Settings) => Promise<boolean> }) {
  const w = settings.widget;
  const [draft, setDraft] = useState(w);
  useEffect(() => setDraft(settings.widget), [settings.widget]);
  const commit = (patch: Partial<api.WidgetSettings>) => {
    const next = { ...settings.widget, ...patch };
    setDraft(next);
    void save({ ...settings, widget: next });
  };
  const slider = (key: "count" | "scale") => ({
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: Number(e.target.value) }),
    onPointerUp: (e: React.PointerEvent<HTMLInputElement>) => commit({ [key]: Number(e.currentTarget.value) }),
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key.startsWith("Arrow")) commit({ [key]: Number(e.currentTarget.value) }); },
  });
  const session = new Set(matches?.sessionIds ?? []);
  const preview = (matches?.matches ?? []).filter((m) => session.has(m.id));
  const sample = [{ id: "a", map: "Erangel", place: 3, kills: 5, damage: 640 }, { id: "b", map: "Miramar", place: 12, kills: 2, damage: 285 }, { id: "c", map: "Rondo", place: 1, kills: 8, damage: 970 }];
  const url = status?.widget.url ?? "http://127.0.0.1:3667/pubg/widget";
  return <section className="pubg-view">
    <div className="pubg-view__header"><div><h2>OBS-виджет</h2><p>Матчи текущей сессии для трансляции. Необязательный: по умолчанию выключен.</p></div></div>
    <div className="pubg-columns">
      <Panel title="Настройки виджета" aside={<Badge tone={w.enabled && status?.widget.running ? "success" : "default"} dot>{!w.enabled ? "Выключен" : status?.widget.running ? `Включён${status.widget.clients ? " · OBS подключён" : ""}` : "Включится вместе с плагином"}</Badge>}>
        <SettingsGroup>
          <SettingsRow label="Показывать виджет" description="Пока выключен, источник в OBS остаётся пустым">
            <Switch aria-label="Показывать виджет" checked={w.enabled} onChange={(e) => commit({ enabled: e.target.checked })} />
          </SettingsRow>
          <SettingsRow label="Количество матчей" description="Последние матчи текущей сессии">
            <span className="pubg-range"><RangeField aria-label="Количество матчей" display={String(draft.count)} min={3} max={10} {...slider("count")} /></span>
          </SettingsRow>
          <SettingsRow label="Масштаб">
            <span className="pubg-range"><RangeField aria-label="Масштаб" display={`${draft.scale}%`} min={50} max={200} step={10} {...slider("scale")} /></span>
          </SettingsRow>
          <SettingsRow label="Прозрачность фона" description="100% — фона нет, только текст">
            <span className="pubg-range"><RangeField aria-label="Прозрачность фона" display={`${100 - draft.backgroundOpacity}%`} min={0} max={100} step={5}
              value={100 - draft.backgroundOpacity}
              onChange={(e) => setDraft({ ...draft, backgroundOpacity: 100 - Number(e.target.value) })}
              onPointerUp={(e) => commit({ backgroundOpacity: 100 - Number(e.currentTarget.value) })}
              onKeyUp={(e) => { if (e.key.startsWith("Arrow")) commit({ backgroundOpacity: 100 - Number(e.currentTarget.value) }); }} /></span>
          </SettingsRow>
          <SettingsRow label="Заголовки колонок">
            <Switch aria-label="Заголовки колонок" checked={w.showHeaders} onChange={(e) => commit({ showHeaders: e.target.checked })} />
          </SettingsRow>
        </SettingsGroup>
        <div className="pubg-url">
          <span>Browser Source в OBS</span>
          <code>{url}</code>
          <p className="ui-text-muted">Добавьте источник «Браузер» с этим адресом. Фон страницы прозрачный, обновление автоматическое.</p>
          {status?.widget.error && <p className="ui-text-danger" role="alert">Виджет не запущен: {status.widget.error}</p>}
        </div>
      </Panel>
      <Panel title="Предпросмотр" description={preview.length ? "Как сейчас выглядит виджет" : "Пример: в сессии ещё нет матчей"}>
        <div className="pubg-preview">
          <Widget state={{ ...draft, enabled: true, matches: preview.length ? preview : sample }} />
        </div>
      </Panel>
    </div>
  </section>;
}
