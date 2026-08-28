import { ActionButtons } from "../components/ActionButtons";
import { BackendStatusPanel } from "../components/BackendStatusPanel";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { EventHistoryList } from "../components/EventHistoryList";
import { LastEventPanel } from "../components/LastEventPanel";
import { StatusChecklist } from "../components/StatusChecklist";
import { StreamSessionCard } from "../components/StreamSessionCard";
import type { StreamSessionPromptState } from "../hooks/useStreamSessionPrompt";
import * as api from "../services/dotaCompanionApi";
import type { DiagnosticsStatusSnapshot, LastEvent, StatusSnapshot, SyncOutboxStatus } from "../types/status";

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  run: (action: () => Promise<StatusSnapshot | void>) => Promise<void>;
  history: LastEvent[];
  latestEvent: LastEvent | null;
  diagnosticsStatus: DiagnosticsStatusSnapshot | null;
  diagnosticsRefresh: () => Promise<DiagnosticsStatusSnapshot | void>;
  sessionPrompt: StreamSessionPromptState;
  syncStatus: SyncOutboxStatus | null;
}

// Companion UI 2.0 / WK-114 - "Диагностика": technical/troubleshooting tools
// only, secondary to Главная/Чат/Звуки (see AppShell's header). OBS scene
// mapping and the companion token live in the Настройки modal now - this
// page no longer duplicates them. The legacy manual backend-session
// controls (WK-83/WK-100 "Завершить стрим"/"Начать новый стрим") moved here
// in WK-114: OBS is the source of truth for the local session now (see
// HomePage's LocalStreamLifecycleCard), so this manual backend concept is a
// recovery/debug tool, not a day-to-day control - Диагностика is exactly
// that surface.
export function DiagnosticsPage({
  status, busy, run, history, latestEvent, diagnosticsStatus, diagnosticsRefresh, sessionPrompt, syncStatus,
}: Props) {
  return (
    <div className="diagnostics-view">
      <div className="page-heading"><span className="section-heading__eyebrow">Для разработчика</span><h2>Диагностика</h2><p>Технические данные и восстановление для troubleshooting. Повседневное управление находится на главной, настройки — по значку шестерёнки.</p></div>
      <section><h2>Базовая настройка</h2><StatusChecklist status={status} /></section>
      {(status?.gsi_last_error || status?.obs_last_error) && (
        <div className="diagnostic-card">
          <h2>Технические ошибки</h2>
          {status?.gsi_last_error && <p className="backend-status__error">GSI: {status.gsi_last_error}</p>}
          {status?.obs_last_error && <p className="backend-status__error">OBS: {status.obs_last_error}</p>}
        </div>
      )}
      <details className="session-fallback">
        <summary>Ручное управление сессией (резерв на backend)</summary>
        <StreamSessionCard sessionPrompt={sessionPrompt} />
      </details>
      <div className="diagnostic-card"><ActionButtons busy={busy} canOpenDotaFolder={!!status?.dota_found} legacyCleanupInProgress={!!status?.legacy_cleanup_in_progress} onInstallGsi={() => void run(api.installGsi)} onPickFolder={() => void run(api.pickDotaFolder)} onOpenDotaFolder={() => void run(api.openDotaFolder)} onOpenLogs={() => void run(api.openLogsFolder)} onClearLog={() => void run(api.clearLog)} onRefresh={() => void run(api.getStatus)} /></div>
      <div className="diagnostic-card"><LastEventPanel event={latestEvent} requestCount={status?.request_count ?? 0} /></div>
      <EventHistoryList events={history} />
      <BackendStatusPanel status={status} busy={busy} onResend={() => void run(api.resendCurrentState)} syncStatus={syncStatus} />
      <DiagnosticsPanel status={diagnosticsStatus} refresh={diagnosticsRefresh} />
      {status?.log_dir && <p className="app__log-dir">Логи: {status.log_dir}</p>}
    </div>
  );
}
