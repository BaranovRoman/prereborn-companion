import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { StatusChecklist } from "../components/StatusChecklist";
import { LastEventPanel } from "../components/LastEventPanel";
import { EventHistoryList } from "../components/EventHistoryList";
import { ActionButtons } from "../components/ActionButtons";
import { BackendStatusPanel } from "../components/BackendStatusPanel";
import { CompanionTokenForm } from "../components/CompanionTokenForm";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { useStatus } from "../hooks/useStatus";
import { useGsiEvents } from "../hooks/useGsiEvents";
import { useDiagnostics } from "../hooks/useDiagnostics";
import * as dotaCompanionApi from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";

export function HomePage() {
  const { status, setStatus, refresh } = useStatus();
  const history = useGsiEvents();
  const diagnostics = useDiagnostics();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every GSI event bumps the request counter on the Rust side; resync so
  // the UI's "всего запросов" figure stays live without polling.
  useEffect(() => {
    if (history.length > 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length]);

  // Rust emits this after every attempted send to the backend (success or
  // failure) - see src-tauri/src/backend/mod.rs::apply_result.
  useEffect(() => {
    const unlistenPromise = listen("backend-status", () => refresh());
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: () => Promise<StatusSnapshot | void>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) setStatus(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const latestEvent = history[0] ?? status?.last_event ?? null;

  return (
    <main className="app">
      <header>
        <div className="app__brand">
          <img className="app__logo" src="/logo-new.png" alt="PreReborn Companion" width="72" height="72" />
          <h1>PreReborn Companion</h1>
        </div>
        <p className="app__subtitle">Исследовательский GSI-компаньон — MVP, не финальная архитектура</p>
      </header>

      <section>
        <h2>Статус</h2>
        <StatusChecklist status={status} />
      </section>

      {error && <p className="app__error">Ошибка: {error}</p>}

      <ActionButtons
        busy={busy}
        canOpenDotaFolder={!!status?.dota_found}
        onInstallGsi={() => run(dotaCompanionApi.installGsi)}
        onPickFolder={() => run(dotaCompanionApi.pickDotaFolder)}
        onOpenDotaFolder={() => run(dotaCompanionApi.openDotaFolder)}
        onOpenLogs={() => run(dotaCompanionApi.openLogsFolder)}
        onClearLog={() => run(dotaCompanionApi.clearLog)}
        onRefresh={() => run(dotaCompanionApi.getStatus)}
      />

      <LastEventPanel event={latestEvent} requestCount={status?.request_count ?? 0} />

      <EventHistoryList events={history} />

      <CompanionTokenForm
        status={status}
        busy={busy}
        onSave={(token) => run(() => dotaCompanionApi.saveCompanionToken(token))}
      />

      <BackendStatusPanel
        status={status}
        busy={busy}
        onResend={() => run(dotaCompanionApi.resendCurrentState)}
      />

      {status?.log_dir && <p className="app__log-dir">Логи: {status.log_dir}</p>}

      <DiagnosticsPanel status={diagnostics.status} refresh={diagnostics.refresh} />
    </main>
  );
}
