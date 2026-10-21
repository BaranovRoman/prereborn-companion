// Shared by the plugin UI and the OBS widget.
const MODES: Record<string, string> = {
  solo: "Соло", duo: "Дуо", squad: "Отряды",
  "solo-fpp": "Соло FPP", "duo-fpp": "Дуо FPP", "squad-fpp": "Отряды FPP",
  tdm: "TDM", ibr: "Intense BR",
};

export function modeLabel(mode: string): string {
  if (MODES[mode]) return MODES[mode];
  if (mode.startsWith("normal-")) return `${modeLabel(mode.slice(7))} · обычный`;
  return mode || "—";
}

export function placeLabel(place: number | null): string {
  return place === null ? "—" : `#${place}`;
}

export function placeTone(place: number | null): "win" | "top" | "default" {
  if (place === 1) return "win";
  if (place !== null && place <= 10) return "top";
  return "default";
}

export function finishedAt(createdAt: string, durationSec: number): Date {
  return new Date(Date.parse(createdAt) + durationSec * 1000);
}
