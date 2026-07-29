import { useState } from "react";
import * as dotaCompanionApi from "../services/dotaCompanionApi";
import type { DiagnosticsStatusSnapshot } from "../types/status";
import { formatBytes, formatTimestamp } from "../utils/format";

interface Props {
  status: DiagnosticsStatusSnapshot | null;
  refresh: () => Promise<DiagnosticsStatusSnapshot | void>;
}

// Диагностический режим GSI - полностью отдельная, по умолчанию выключенная
// возможность (см. src-tauri/src/diagnostics). Ничего здесь не влияет на
// обычный экран Companion выше - это самостоятельная секция.
export function DiagnosticsPanel({ status, refresh }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleExport = () =>
    run(async () => {
      const path = await dotaCompanionApi.diagnosticsExport();
      setLastExportPath(path);
    });

  const active = !!status?.active;
  const hasSession = !!status?.has_session;

  return (
    <section className="diagnostics-panel">
      <h2>Диагностика GSI (v0.2.1)</h2>
      <p className="diagnostics-panel__hint">
        Отдельный от обычной работы Companion сбор полного сырого GSI-payload'а — только для анализа того, что
        реально присылает Dota. Выключено по умолчанию, ничего не меняет в обычной работе приложения.
      </p>

      <ul className="status-checklist">
        <li className={`check-item${active ? " check-item--ok" : ""}`}>
          <span className="check-item__box">{active ? "✔" : ""}</span>
          <span className="check-item__label">{active ? "Диагностика записывается" : "Диагностика остановлена"}</span>
        </li>
      </ul>

      {status && hasSession && (
        <dl className="diagnostics-panel__stats">
          <dt>Сессия</dt>
          <dd>{status.session_id}</dd>
          <dt>Начата</dt>
          <dd>{status.started_at ? formatTimestamp(status.started_at) : "—"}</dd>
          <dt>GSI-запросов</dt>
          <dd>{status.request_count}</dd>
          <dt>Сохранено snapshot'ов</dt>
          <dd>{status.snapshot_count}</dd>
          <dt>Ошибок разбора запросов</dt>
          <dd>{status.error_count}</dd>
          <dt>Замеченные game_state</dt>
          <dd>{status.observed_game_states.length > 0 ? status.observed_game_states.join(", ") : "—"}</dd>
          <dt>Match ID</dt>
          <dd>{status.observed_match_ids.length > 0 ? status.observed_match_ids.join(", ") : "—"}</dd>
          <dt>Размер сессии</dt>
          <dd>
            {formatBytes(status.bytes_written)} из {formatBytes(status.size_limit_bytes)}
            {status.size_limit_reached && (
              <span className="diagnostics-panel__warning">
                {" "}
                — лимит достигнут, полные snapshot'ы больше не пишутся (timeline и каталог полей продолжают
                вестись)
              </span>
            )}
          </dd>
        </dl>
      )}

      {error && <p className="app__error">Ошибка: {error}</p>}
      {lastExportPath && <p className="diagnostics-panel__export-path">Экспортировано: {lastExportPath}</p>}

      <div className="action-buttons">
        <button onClick={() => run(dotaCompanionApi.diagnosticsStart)} disabled={busy || active}>
          Начать диагностику
        </button>
        <button onClick={() => run(dotaCompanionApi.diagnosticsStop)} disabled={busy || !active}>
          Остановить диагностику
        </button>
        <button onClick={() => run(dotaCompanionApi.diagnosticsClear)} disabled={busy || active || !hasSession}>
          Очистить диагностические логи
        </button>
        <button onClick={handleExport} disabled={busy || !hasSession}>
          Экспортировать диагностику (ZIP)
        </button>
      </div>
    </section>
  );
}
