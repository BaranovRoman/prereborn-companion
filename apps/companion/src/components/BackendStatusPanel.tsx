import type { StatusSnapshot } from "../types/status";
import { describeBackendStatus } from "../utils/backendStatus";
import { formatTimestamp } from "../utils/format";

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  onResend: () => void;
}

export function BackendStatusPanel({ status, busy, onResend }: Props) {
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
      <button onClick={onResend} disabled={busy}>
        Отправить текущее состояние повторно
      </button>
    </section>
  );
}
