import type { CSSProperties } from "react";
import { placeLabel, placeTone } from "../format";
import "./widget.css";

export interface WidgetMatch { id: string; map: string; place: number | null; kills: number; damage: number }
export interface WidgetState {
  enabled: boolean; count: number; scale: number; backgroundOpacity: number; showHeaders: boolean;
  matches: WidgetMatch[]; revision?: number;
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
