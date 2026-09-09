import type { ErrorDescription } from "./errorDescription";

// WK-63 - `obs_last_error`/`obs_watcher_last_error` are free-form strings
// from the hand-rolled obs-websocket client (src-tauri/src/obs.rs, built on
// raw tungstenite, not the `obws` crate). Only two shapes are reliably
// distinguishable there: connection unreachable
// ("Не удалось подключиться к OBS: ...") and a rejected password/WebSocket
// version ("OBS отклонил пароль или версию WebSocket"). Everything else
// (closed socket, missing Hello, malformed response, timeouts) shares
// generic io::Error/tungstenite text with no dedicated marker - a closed
// socket in particular is used both for a bad-password close AND unrelated
// closes, so it is deliberately NOT split further here. See the ticket's
// "don't guess categories the data can't reliably distinguish" rule.
export function describeObsError(raw: string | null): ErrorDescription | null {
  if (!raw) return null;

  if (raw.startsWith("Не удалось подключиться к OBS")) {
    return {
      title: "Не удалось подключиться к OBS",
      message: "Проверьте, что OBS запущен и WebSocket-сервер включён в настройках OBS.",
      detail: raw,
    };
  }

  if (raw.startsWith("OBS отклонил пароль или версию WebSocket")) {
    return {
      title: "OBS отклонил подключение",
      message: "Проверьте пароль WebSocket в настройках Companion и в OBS.",
      detail: raw,
    };
  }

  return {
    title: "Проблема с подключением к OBS",
    message: "Проверьте, что OBS запущен, WebSocket включён и пароль совпадает.",
    detail: raw,
  };
}
