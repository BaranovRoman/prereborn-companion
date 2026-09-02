import { useState } from "react";
import type { StatusSnapshot, SyncOutboxStatus } from "../types/status";
import { describeBackendStatus } from "../utils/backendStatus";
import { formatTimestamp } from "../utils/format";
import { triggerSyncDrain } from "../services/dotaCompanionApi";

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  onResend: () => void;
  syncStatus: SyncOutboxStatus | null;
  syncRefresh: () => Promise<void>;
}

// Tech-debt observability task - a compact tri-state summary of sync_outbox
// (WK-113), so "why hasn't this match reached the backend yet" has one line
// to check instead of grepping app.log. Deliberately never "Ошибка" just
// because the backend is currently unreachable (that's the existing
// backend_state/ProblemBar concern, matches keep syncing once it recovers) -
// only a real dead letter (a permanently-rejected event) counts as an error
// here.
function describeSyncStatus(syncStatus: SyncOutboxStatus | null): { label: string; tone: "ok" | "warn" | "error" } {
  if (!syncStatus || (syncStatus.failedCount === 0 && syncStatus.pendingCount === 0)) {
    return { label: "Синхронизировано", tone: "ok" };
  }
  if (syncStatus.failedCount > 0) {
    return { label: "Ошибка синхронизации", tone: "error" };
  }
  return { label: "Есть очередь", tone: "warn" };
}

export function BackendStatusPanel({ status, busy, onResend, syncStatus, syncRefresh }: Props) {
  const backendStatus = describeBackendStatus(status);
  const syncSummary = describeSyncStatus(syncStatus);
  const [retrying, setRetrying] = useState(false);

  const handleRetrySync = async () => {
    setRetrying(true);
    try {
      await triggerSyncDrain();
      await syncRefresh();
    } finally {
      setRetrying(false);
    }
  };

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

      {/* Tech-debt observability task - sync_outbox (WK-113/119) status,
          distinct from the legacy full-state heartbeat above: this reflects
          whether session/match events have actually reached the backend. */}
      <h3>Синхронизация</h3>
      <ul className="status-checklist">
        <li className={`check-item${syncSummary.tone === "ok" ? " check-item--ok" : ""}`}>
          <span className="check-item__box">{syncSummary.tone === "ok" ? "✔" : ""}</span>
          <span className="check-item__label">Статус: {syncSummary.label}</span>
        </li>
      </ul>
      {/* WK-119 - sync_outbox (WK-113) detail view: the fuller counterpart
          to ProblemBar's brief pending/dead-letter surface. */}
      {syncStatus && syncStatus.pendingCount > 0 && (
        <p className="backend-status__line">
          Ожидают отправки: {syncStatus.pendingCount}
          {syncStatus.retryingCount > 0 && syncStatus.retryingCount !== syncStatus.pendingCount &&
            ` (из них повторная попытка: ${syncStatus.retryingCount})`}
          {syncStatus.oldestPendingAt && ` (с ${formatTimestamp(syncStatus.oldestPendingAt)})`}
        </p>
      )}
      {syncStatus && syncStatus.failedCount > 0 && (
        <p className="backend-status__error">
          Не удалось синхронизировать: {syncStatus.failedCount}
          {syncStatus.lastError && ` — ${syncStatus.lastError}`}
          {syncStatus.lastErrorAt && ` (${formatTimestamp(syncStatus.lastErrorAt)})`}
        </p>
      )}
      <p className="backend-status__line">
        Последняя успешная синхронизация:{" "}
        {syncStatus?.lastDeliveredAt ? formatTimestamp(syncStatus.lastDeliveredAt) : "ещё не было"}
      </p>
      {syncStatus && syncStatus.pendingCount > 0 && (
        <button className="button" onClick={() => void handleRetrySync()} disabled={retrying}>
          {retrying ? "Синхронизация…" : "Повторить синхронизацию"}
        </button>
      )}

      <button className="button" onClick={onResend} disabled={busy}>
        Отправить текущее состояние повторно
      </button>
    </section>
  );
}
