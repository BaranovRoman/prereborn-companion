import type { CSSProperties } from "react";
import { apiStatusText, placeLabel, placeTone } from "../format";
import "./widget.css";

export interface WidgetMatch { id: string; map: string; place: number | null; kills: number; damage: number }
export interface WidgetState {
  enabled: boolean; count: number; scale: number; backgroundOpacity: number; showHeaders: boolean;
  matches: WidgetMatch[]; revision?: number;
  // Only explain an empty widget opened in a browser (WidgetNotice).
  configured?: boolean; sessionStartedAt?: string | null; apiStatus?: string | null;
}

// Compact table of the current session's matches. Renders nothing until the
// session has a match: an empty OBS source stays invisible on stream.
export function Widget({ state }: { state: WidgetState }) {
  const matches = state.matches.slice(0, state.count);
  if (!state.enabled || matches.length === 0) return null;
  const style = {
    "--pubg-widget-scale": state.scale / 100,
    "--pubg-widget-bg": state.backgroundOpacity / 100,
  } as CSSProperties;
  return (
    <table className="pubg-widget" style={style} aria-label="Матчи сессии PUBG">
      {state.showHeaders && <thead><tr><th>Карта</th><th>Место</th><th>Убийства</th><th>Урон</th></tr></thead>}
      <tbody>
        {matches.map((match) => (
          <tr key={match.id}>
            <td className="pubg-widget__map">{match.map}</td>
            <td className={`pubg-widget__place pubg-widget__place--${placeTone(match.place)}`}>{placeLabel(match.place)}</td>
            <td>{match.kills}</td>
            <td>{match.damage}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** Why the widget draws nothing, or null when it shows the table. */
export function emptyReason(state: WidgetState | null, offline: boolean): string | null {
  if (state?.enabled && state.matches.length > 0) return null;
  if (offline) return "Нет связи с плагином PUBG. Виджет работает, пока плагин включён в Companion.";
  if (!state) return "Подключение к плагину PUBG…";
  if (!state.enabled) return "Виджет выключен: включите «Показывать виджет» на вкладке «OBS-виджет» плагина PUBG.";
  if (state.configured === false) return "Укажите ник PUBG на вкладке «Игрок» плагина PUBG.";
  const since = state.sessionStartedAt ? ` (с ${time(state.sessionStartedAt)})` : "";
  const api = apiStatusText(state.apiStatus ?? null);
  return `В текущей сессии${since} ещё нет завершённых матчей. Матч появляется через несколько минут после окончания — так работает PUBG API.${api ? ` ${api}` : ""}`;
}

// Shown only outside OBS (a browser tab): on stream an empty source stays
// transparent.
export function WidgetNotice({ reason }: { reason: string }) {
  return (
    <div className="pubg-widget-notice" role="status">
      <p>{reason}</p>
      <p className="pubg-widget-notice__hint">Эта подсказка видна только в браузере. В OBS пустой виджет прозрачный.</p>
    </div>
  );
}
