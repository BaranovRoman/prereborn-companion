import type { StatusSnapshot, SyncOutboxStatus } from "../types/status";
import { describeBackendStatus } from "../utils/backendStatus";
import { formatTimestamp } from "../utils/format";

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  onResend: () => void;
  syncStatus: SyncOutboxStatus | null;
}

export function BackendStatusPanel({ status, busy, onResend, syncStatus }: Props) {
  const backendStatus = describeBackendStatus(status);

  return (
    <section className="backend-status">
      <h2>Backend</h2>
      <ul className="status-checklist">
        <li className={`check-item${backendStatus.ready ? " check-item--ok" : ""}`}>
          <span className="check-item__box">{backendStatus.ready ? "✔" : ""}</span>
          <span className="check-item__label">{backendStatus.label}</span>
          <span className="check-item__detail">{status?.backend_url}</span>
        </li>
      </ul>
      <p className="backend-status__line">
        Последняя успешная отправка:{" "}
        {status?.backend_last_sent_at
          ? formatTimestamp(status.backend_last_sent_at)
          : "ещё не было"}
      </p>
      {status?.backend_last_error && (
        <p className="backend-status__error">
          Последняя ошибка: {status.backend_last_error}
        </p>
      )}
      {/* WK-119 - sync_outbox (WK-113) detail view: the fuller counterpart
          to ProblemBar's brief pending/dead-letter surface. */}
      {syncStatus && syncStatus.pendingCount > 0 && (
        <p className="backend-status__line">
          Ожидают отправки: {syncStatus.pendingCount}
          {syncStatus.oldestPendingAt && ` (с ${formatTimestamp(syncStatus.oldestPendingAt)})`}
        </p>
      )}
      {syncStatus && syncStatus.failedCount > 0 && (
        <p className="backend-status__error">
          Не удалось синхронизировать: {syncStatus.failedCount}
          {syncStatus.lastError && ` — ${syncStatus.lastError}`}
        </p>
      )}
      <button className="button" onClick={onResend} disabled={busy}>
        Отправить текущее состояние повторно
      </button>
    </section>
  );
}
