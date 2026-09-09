import type { ErrorDescription } from "./errorDescription";

// WK-63 - `gsi_last_error` is a free-form string written in exactly two
// shapes by the GSI listener supervisor thread (src-tauri/src/server/mod.rs):
// a fixed "listener stopped" message, and `Could not bind {addr}: {error}`
// wrapping the OS's raw bind-failure text (os-dependent wording). This turns
// either into short Russian copy for Diagnostics/the setup guide, keeping the
// raw string as `detail` for troubleshooting. No other shape is produced
// today, so anything else falls back to a safe generic message rather than
// guessing.
export function describeGsiError(raw: string | null): ErrorDescription | null {
  if (!raw) return null;

  if (raw.startsWith("Could not bind")) {
    return {
      title: "Порт для приёма данных Dota 2 занят",
      message: "Проверьте, не запущена ли ещё одна копия Companion, и перезапустите приложение.",
      detail: raw,
    };
  }

  if (raw.includes("GSI listener stopped")) {
    return {
      title: "Локальный GSI-сервис перезапускается",
      message: "Переподключение выполняется автоматически.",
      detail: raw,
    };
  }

  return {
    title: "Проблема с локальным GSI-сервисом",
    message: "Подробности — ниже.",
    detail: raw,
  };
}
