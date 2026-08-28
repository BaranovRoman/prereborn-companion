import type { StatusSnapshot } from "../types/status";
import type { BackendStatusDescription } from "../utils/backendStatus";

interface ProblemItem {
  key: string;
  tone: "warning" | "error";
  label: string;
  detail: string;
}

interface Props {
  status: StatusSnapshot | null;
  backendStatus: BackendStatusDescription;
}

// WK-114 - replaces the permanent status-grid cards that used to sit on
// Главная: a genuinely healthy Companion renders nothing here at all. Reuses
// the existing ConnectionState model (gsi_state/obs_state/backend_state,
// see types/status.ts and state.rs) as the ONLY source of truth for what
// counts as a real problem - "waiting" (never checked yet, e.g. Dota simply
// hasn't been launched) is deliberately never shown as a problem, only a
// sustained "recovering"/"unavailable" is. Backend/sync issues stay
// categorically softer (always "warning", never "error") than GSI/OBS ones,
// matching utils/backendStatus.ts's WK-113 design: a sync problem never
// touches the live stream, a GSI/OBS problem can.
export function ProblemBar({ status, backendStatus }: Props) {
  if (!status) return null;
  const items: ProblemItem[] = [];

  // WK-115 copy audit - never show the raw technical error string here
  // (e.g. a raw OS socket error) - this bar is the most visible surface in
  // the app, not a troubleshooting tool. The same raw error is still
  // available on Диагностика for anyone who actually needs it (see
  // StatusChecklist).
  if (status.gsi_state === "unavailable") {
    items.push({ key: "gsi", tone: "error", label: "Нет сигнала Dota", detail: "Локальный сервис недоступен. Подробности — в Диагностике." });
  } else if (status.gsi_state === "recovering") {
    items.push({ key: "gsi", tone: "warning", label: "Нет сигнала Dota", detail: "Переподключение…" });
  }

  if (status.obs_state === "unavailable") {
    items.push({ key: "obs", tone: "error", label: "OBS не подключён", detail: "Проверьте, что OBS запущен и WebSocket включён." });
  } else if (status.obs_state === "recovering") {
    items.push({ key: "obs", tone: "warning", label: "OBS не подключён", detail: "Переподключение…" });
  }

  if (backendStatus.tone !== "ok" && (status.backend_state === "recovering" || status.backend_state === "unavailable")) {
    items.push({ key: "backend", tone: "warning", label: backendStatus.label, detail: backendStatus.detail });
  }

  if (items.length === 0) return null;

  return (
    <div className="problem-bars" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.key} className={`problem-bar problem-bar--${item.tone}`}>
          <span className="problem-bar__label">{item.label}</span>
          <span className="problem-bar__detail">{item.detail}</span>
        </div>
      ))}
    </div>
  );
}
