import type { StatusSnapshot } from "../types/status";

export type BackendStatusTone = "ok" | "warning" | "error";

export interface BackendStatusDescription {
  label: string;
  detail: string;
  tone: BackendStatusTone;
  // True only once the backend has actually confirmed reachability - the
  // single signal both HomePage's readiness check and its checklist item
  // should treat as "done", instead of each re-deriving it from raw fields.
  ready: boolean;
}

type BackendStatusInput = Pick<
  StatusSnapshot,
  "companion_token_configured" | "backend_state" | "backend_last_error"
> | null;

// WK-94 - single source of truth for how `backend_state` (+ whether a token
// is configured at all) reads as UI copy, so BackendStatusPanel and
// HomePage's checklist/readiness line can never disagree about whether the
// backend is connected. Never renders "disconnected" for Waiting/Recovering -
// only Unavailable is a confirmed, sustained problem (see state.rs).
export function describeBackendStatus(status: BackendStatusInput): BackendStatusDescription {
  if (!status || !status.companion_token_configured) {
    return {
      label: "Не настроено",
      detail: "Добавьте companion token",
      tone: "warning",
      ready: false,
    };
  }

  switch (status.backend_state) {
    case "connected":
      return {
        label: "Подключено",
        detail: "Состояние отправляется на сервер",
        tone: "ok",
        ready: true,
      };
    case "recovering":
      return {
        label: "Переподключение…",
        detail: status.backend_last_error ?? "Временная ошибка, повторная попытка",
        tone: "warning",
        ready: false,
      };
    case "unavailable":
      return {
        label: "Backend недоступен",
        detail: status.backend_last_error ?? "Проверьте подключение и токен",
        tone: "error",
        ready: false,
      };
    case "waiting":
    default:
      return {
        label: "Ожидание проверки",
        detail: "Соединение ещё не проверялось",
        tone: "warning",
        ready: false,
      };
  }
}
