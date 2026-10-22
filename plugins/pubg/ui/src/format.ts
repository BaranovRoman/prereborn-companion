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

// Backend/PUBG status codes → what the streamer can do about it.
export function apiStatusText(code: string | null): string | null {
  switch (code) {
    case null: case "ok": return null;
    case "not_configured": return "Сервер Prereborn ещё не подключён к PUBG API. История появится, как только ключ будет настроен.";
    case "player_not_found": return "Игрок не найден. Проверьте ник (с учётом регистра) и платформу.";
    case "rate_limited": return "PUBG API временно ограничил запросы. Повторим автоматически.";
    case "account_not_connected": return "Войдите в аккаунт Prereborn в Companion: история загружается через сервер Prereborn.";
    case "companion_outdated": return "Обновите Companion, чтобы загружать историю PUBG.";
    case "invalid_response": return "Сервер вернул некорректный ответ. Повторим автоматически.";
    default: return "PUBG API сейчас недоступен. Повторим автоматически.";
  }
}
