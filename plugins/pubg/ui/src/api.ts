import { client } from "../../../protocol/ui";
export { apiStatusText } from "./format";

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

// A failed settings.save, in words the streamer can act on.
export function saveErrorText(error: unknown): string {
  const code = String(error instanceof Error ? error.message : error);
  if (code.includes("invalid_player_name")) return "некорректный ник.";
  if (code.includes("invalid_platform")) return "неизвестная платформа.";
  if (code.includes("plugin_data_write_failed") || code.includes("plugin_data_invalid")) return "не удалось записать файл настроек плагина.";
  if (code.includes("plugin_request_timeout")) return "плагин не ответил. Попробуйте ещё раз.";
  if (code.includes("plugin_host_not_ready") || code.includes("not_running") || code.includes("not_installed")) return "плагин недоступен. Откройте его заново на странице «Плагины».";
  if (code.includes("settings_not_confirmed")) return "плагин не подтвердил сохранение.";
  return code.slice(0, 300);
}
