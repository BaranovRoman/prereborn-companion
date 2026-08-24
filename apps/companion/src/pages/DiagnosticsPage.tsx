import { ActionButtons } from "../components/ActionButtons";
import { BackendStatusPanel } from "../components/BackendStatusPanel";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { EventHistoryList } from "../components/EventHistoryList";
import { LastEventPanel } from "../components/LastEventPanel";
import { StatusChecklist } from "../components/StatusChecklist";
import * as api from "../services/dotaCompanionApi";
import type { DiagnosticsStatusSnapshot, LastEvent, StatusSnapshot } from "../types/status";

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  run: (action: () => Promise<StatusSnapshot | void>) => Promise<void>;
  history: LastEvent[];
  latestEvent: LastEvent | null;
  diagnosticsStatus: DiagnosticsStatusSnapshot | null;
  diagnosticsRefresh: () => Promise<DiagnosticsStatusSnapshot | void>;
}

// Companion UI 2.0 - "Диагностика": technical/troubleshooting tools only.
// OBS scene mapping and the companion token moved to Настройки (see
// SettingsPage) - this page no longer duplicates them. Everything that
// remains here (raw GSI event stream, backend resend, install/log
// maintenance, GSI capture export) is genuinely for diagnosing a problem,
// not day-to-day use - matches the задача's split between "обычное
// ежедневное использование" and troubleshooting.
export function DiagnosticsPage({
  status, busy, run, history, latestEvent, diagnosticsStatus, diagnosticsRefresh,
}: Props) {
  return (
    <div className="diagnostics-view">
      <div className="page-heading"><span className="section-heading__eyebrow">Для разработчика</span><h2>Диагностика</h2><p>Технические данные для troubleshooting. Повседневное управление находится на главной, настройки — в разделе «Настройки».</p></div>
      <section><h2>Базовая настройка</h2><StatusChecklist status={status} /></section>
      <div className="diagnostic-card"><ActionButtons busy={busy} canOpenDotaFolder={!!status?.dota_found} legacyCleanupInProgress={!!status?.legacy_cleanup_in_progress} onInstallGsi={() => void run(api.installGsi)} onPickFolder={() => void run(api.pickDotaFolder)} onOpenDotaFolder={() => void run(api.openDotaFolder)} onOpenLogs={() => void run(api.openLogsFolder)} onClearLog={() => void run(api.clearLog)} onRefresh={() => void run(api.getStatus)} /></div>
      <div className="diagnostic-card"><LastEventPanel event={latestEvent} requestCount={status?.request_count ?? 0} /></div>
      <EventHistoryList events={history} />
      <BackendStatusPanel status={status} busy={busy} onResend={() => void run(api.resendCurrentState)} />
      <DiagnosticsPanel status={diagnosticsStatus} refresh={diagnosticsRefresh} />
      {status?.log_dir && <p className="app__log-dir">Логи: {status.log_dir}</p>}
    </div>
  );
}
