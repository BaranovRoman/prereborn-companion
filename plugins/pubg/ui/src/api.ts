import { client } from "../../../protocol/ui";

export const bridge = client();
export async function invoke<T>(name: string, args: unknown = {}): Promise<T> {
  await bridge.connection;
  return bridge.invoke<T>(name, args);
}

export type Platform = "steam" | "kakao" | "psn" | "xbox";
export interface WidgetSettings { enabled: boolean; count: number; scale: number; backgroundOpacity: number; showHeaders: boolean }
export interface Settings { player: string; platform: Platform; widget: WidgetSettings }
export interface Status {
  prepared: boolean; active: boolean; configured: boolean; player: string; platform: Platform;
  sessionStartedAt: string | null; apiStatus: string | null; lastError: string | null; lastFetchAt: string | null;
  fetching: boolean; matches: number; sessionMatches: number; revision: number;
  widget: { enabled: boolean; url: string; error: string | null; running: boolean; clients: number };
}
export interface Match {
  id: string; createdAt: string; durationSec: number; map: string; gameMode: string;
  place: number | null; kills: number; damage: number;
}
export interface Matches { matches: Match[]; sessionIds: string[]; sessionStartedAt: string | null; revision: number }

export const PLATFORMS: [Platform, string][] = [["steam", "Steam (ПК)"], ["kakao", "Kakao"], ["psn", "PlayStation"], ["xbox", "Xbox"]];

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
