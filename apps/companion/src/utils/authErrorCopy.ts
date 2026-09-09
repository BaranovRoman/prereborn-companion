import type { ErrorDescription } from "./errorDescription";

// WK-63 - AccountForm's login/logout errors are the raw `Result<_, String>`
// that crosses the Tauri `invoke` boundary from backend::login (see
// src-tauri/src/backend/mod.rs::post_login) - there is no structured error
// code, only a flat string. These are the only reliably distinguishable
// shapes it ever produces: a 401 ("Неверный email или пароль."), an
// unreachable server ("Не удалось связаться с PreReborn: ..."), a non-2xx
// HTTP status ("Backend ответил {status}", split on the embedded status
// code into "server" for 5xx vs a generic rejection otherwise), and a
// malformed response body ("Неверный ответ входа: ..."). Anything else
// (HTTP client build failure, spawn_blocking join failure) has no dedicated
// marker and falls back to a generic message.
export function describeAuthError(raw: string): ErrorDescription {
  if (raw.includes("Неверный email или пароль")) {
    // No `detail` here - the raw string is already the same plain-Russian
    // sentence as the mapped copy, so surfacing it a second time (e.g. in a
    // help tooltip) would just be clutter, not new diagnostic information.
    return {
      title: "Не удалось войти",
      message: "Проверьте логин и пароль.",
      detail: null,
    };
  }

  if (raw.includes("Не удалось связаться с PreReborn")) {
    return {
      title: "Нет связи с сервером PreReborn",
      message: "Проверьте интернет-соединение и повторите попытку.",
      detail: raw,
    };
  }

  const statusMatch = raw.match(/Backend ответил (\d{3})/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status >= 500
      ? {
          title: "Сервер PreReborn временно недоступен",
          message: "Попробуйте ещё раз чуть позже.",
          detail: raw,
        }
      : {
          title: "Сервер PreReborn отклонил запрос",
          message: "Попробуйте ещё раз. Если проблема повторяется, обратитесь в поддержку.",
          detail: raw,
        };
  }

  if (raw.includes("Неверный ответ входа")) {
    return {
      title: "Сервер PreReborn вернул неожиданный ответ",
      message: "Попробуйте ещё раз чуть позже.",
      detail: raw,
    };
  }

  return {
    title: "Не удалось войти",
    message: "Попробуйте ещё раз. Если проблема повторяется, проверьте подключение к интернету.",
    detail: raw,
  };
}
