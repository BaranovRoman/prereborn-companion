import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ActionButtons } from "../components/ActionButtons";
import { BackendStatusPanel } from "../components/BackendStatusPanel";
import { CompanionTokenForm } from "../components/CompanionTokenForm";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { EventHistoryList } from "../components/EventHistoryList";
import { LastEventPanel } from "../components/LastEventPanel";
import { ObsScenePanel } from "../components/ObsScenePanel";
import { StatusChecklist } from "../components/StatusChecklist";
import { TwitchChatPage } from "../components/TwitchChatPage";
import { UpdateBanner } from "../components/UpdateBanner";
import { useTwitchChatSession } from "../chat/useTwitchChatSession";
import { useDiagnostics } from "../hooks/useDiagnostics";
import { useGsiEvents } from "../hooks/useGsiEvents";
import { useStatus } from "../hooks/useStatus";
import { useUpdater } from "../hooks/useUpdater";
import * as api from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";

type View = "home" | "chat" | "diagnostics";
type Scene = "betweenMatches" | "draft" | "gameplay";

const sceneLabels: Record<Scene, string> = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
};

function StatusCard({ label, value, detail, tone }: {
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warning" | "error";
}) {
  return (
    <article className={`status-card status-card--${tone}`}>
      <div className="status-card__heading"><span className="status-card__dot" />{label}</div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

export function HomePage() {
  const { status, setStatus, refresh } = useStatus();
  const history = useGsiEvents();
  const diagnostics = useDiagnostics();
  const updater = useUpdater();
  // WK-78 - owned here (app root, always mounted) rather than inside
  // TwitchChatPage, so chat polling/dedup and TTS keep running regardless
  // of which tab is currently visible.
  const chatSession = useTwitchChatSession();
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(() => localStorage.getItem("companion-setup-complete") !== "true");

  useEffect(() => {
    if (history.length > 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length]);

  useEffect(() => {
    void updater.checkForUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const listeners = ["backend-status", "gsi-status", "obs-status"].map((event) => listen(event, () => refresh()));
    return () => listeners.forEach((promise) => void promise.then((unlisten) => unlisten()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: () => Promise<StatusSnapshot | void>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) setStatus(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setAutomaticMode = (enabled: boolean) => {
    if (status) void run(() => api.saveObsConfig({ ...status.obs_config, enabled }));
  };

  const latestEvent = history[0] ?? status?.last_event ?? null;
  const hasGsiSignal = status?.gsi_state === "connected";
  const ready = !!(status?.backend_connected && status.server_running && status.gsi_installed && hasGsiSignal && status.obs_connected);

  const finishSetup = () => {
    localStorage.setItem("companion-setup-complete", "true");
    setSetupOpen(false);
  };

  const provisionGsi = () => void run(async () => {
    let next = await api.findDota();
    if (next.dota_found && !next.gsi_installed) next = await api.installGsi();
    return next;
  });

  const checkObs = () => void run(async () => {
    await api.testObsConnection();
    return api.getStatus();
  });

  return (
    <main className="app">
      <header className="app-header">
        <div className="app__brand">
          <img className="app__logo" src="/logo-new.png" alt="" width="52" height="52" />
          <div><span className="app__eyebrow">Desktop Companion</span><h1>PreReborn{status?.companion_version && <span className="app__version"> v{status.companion_version}</span>}</h1></div>
        </div>
        <nav className="app-nav" aria-label="Разделы приложения">
          <button className={view === "home" ? "is-active" : ""} onClick={() => setView("home")}>Главная</button>
          <button className={view === "chat" ? "is-active" : ""} onClick={() => setView("chat")}>Чат</button>
          <button className={view === "diagnostics" ? "is-active" : ""} onClick={() => setView("diagnostics")}>Диагностика</button>
        </nav>
      </header>

      <UpdateBanner
        state={updater.state}
        onCheck={() => void updater.checkForUpdate()}
        onInstall={() => void updater.installUpdate()}
        onRestart={() => void updater.restartToApply()}
        onDismiss={updater.dismiss}
      />

      {view === "home" && setupOpen ? <section className="setup-guide" aria-labelledby="setup-title">
        <div className="setup-guide__heading">
          <div><span className="section-heading__eyebrow">Первый запуск</span><h2 id="setup-title">Подготовим Companion к стриму</h2><p>Статусы обновляются автоматически и восстановятся после временного сбоя.</p></div>
          <button className="button" onClick={() => setSetupOpen(false)}>Продолжить позже</button>
        </div>
        {error && <p className="app__error">Ошибка: {error}</p>}
        <ol className="setup-steps">
          <li className={status?.server_running ? "is-complete" : ""}><strong>Companion</strong><span>{status?.server_running ? "Локальный сервис работает" : status?.gsi_state === "recovering" ? "Перезапускает локальный сервис" : "Локальный сервис недоступен"}</span><small>{status?.gsi_last_error ?? "Запускается автоматически"}</small></li>
          <li className={status?.gsi_installed && hasGsiSignal ? "is-complete" : ""}><strong>Dota 2 / GSI</strong><span>{hasGsiSignal ? "Данные поступают" : status?.gsi_installed ? "Конфигурация готова — запустите Dota 2" : "Нужна конфигурация GSI"}</span><button onClick={provisionGsi} disabled={busy}>{status?.gsi_installed ? "Проверить снова" : "Настроить автоматически"}</button></li>
          <li className={status?.companion_token_configured && status.backend_connected ? "is-complete" : ""}><strong>Связь с PreReborn</strong><span>{status?.backend_connected ? "Состояние отправляется" : status?.companion_token_configured ? "Ожидает GSI или восстанавливает связь" : "Добавьте companion token"}</span><CompanionTokenForm status={status} busy={busy} onSave={(token) => run(() => api.saveCompanionToken(token))} /></li>
          <li className={status?.obs_connected ? "is-complete" : ""}><strong>OBS</strong><span>{status?.obs_connected ? "WebSocket и сцены доступны" : status?.obs_state === "recovering" ? "Соединение восстанавливается" : "Настройте OBS WebSocket и сцены"}</span><ObsScenePanel status={status} onStatus={setStatus} /><button onClick={checkObs} disabled={busy || !status}>Проверить OBS</button></li>
        </ol>
        <div className="setup-guide__footer"><p>{ready ? "Все обязательные компоненты готовы." : "Завершение станет доступно, когда все обязательные проверки успешны."}</p><button className="button button--primary" onClick={finishSetup} disabled={!ready}>Завершить настройку</button></div>
      </section> : view === "chat" ? <TwitchChatPage session={chatSession} /> : view === "home" ? <>
        <section className={`readiness ${ready ? "readiness--ok" : "readiness--warning"}`}>
          <div>
            <span className="readiness__label">Состояние эфира</span>
            <h2>{ready ? "Всё готово к стриму" : "Проверьте подключения"}</h2>
            <p>{ready ? "Companion получает данные и управляет сценами OBS." : "Один или несколько сервисов требуют внимания."}</p>
          </div>
          <div className="readiness__actions"><button className="button" onClick={() => setSetupOpen(true)}>Проверить настройку</button><button className="button" onClick={() => void run(api.getStatus)} disabled={busy}>Обновить</button></div>
        </section>

        <section className="status-grid" aria-label="Состояние подключений">
          <StatusCard label="Companion" value={status?.backend_connected ? "Подключён" : "Нет связи"} detail={status?.backend_connected ? "Состояние отправляется на сервер" : "Проверьте токен и подключение"} tone={status?.backend_connected ? "ok" : "error"} />
          <StatusCard label="Dota 2 / GSI" value={hasGsiSignal ? "Получает данные" : status?.gsi_state === "recovering" ? "Восстанавливается" : status?.gsi_installed ? "Ожидает Dota 2" : "Не настроен"} detail={hasGsiSignal ? `Получено событий: ${status?.request_count ?? history.length}` : status?.gsi_last_error ?? (status?.gsi_installed ? "GSI установлен, запустите игру" : "Установите конфигурацию GSI")} tone={hasGsiSignal ? "ok" : status?.gsi_installed || status?.gsi_state === "recovering" ? "warning" : "error"} />
          <StatusCard label="OBS" value={status?.obs_connected ? "Подключён" : status?.obs_state === "recovering" ? "Восстанавливается" : "Нет связи"} detail={status?.obs_connected ? "OBS WebSocket отвечает" : status?.obs_last_error ?? "Проверьте OBS WebSocket"} tone={status?.obs_connected ? "ok" : status?.obs_state === "recovering" ? "warning" : "error"} />
        </section>

        {error && <p className="app__error">Ошибка: {error}</p>}
        {status?.obs_last_error && <p className="app__error">OBS: {status.obs_last_error}</p>}

        <section className="control-panel">
          <div className="section-heading">
            <div><span className="section-heading__eyebrow">Управление эфиром</span><h2>Сцены OBS</h2></div>
            <span className={`connection-pill ${status?.obs_connected ? "is-online" : ""}`}>{status?.obs_connected ? "На связи" : "Не подключён"}</span>
          </div>
          <div className="mode-switch" role="group" aria-label="Режим переключения сцен">
            <button className={status?.obs_config.enabled ? "is-active" : ""} onClick={() => setAutomaticMode(true)} disabled={busy || !status}>Автоматический</button>
            <button className={!status?.obs_config.enabled ? "is-active" : ""} onClick={() => setAutomaticMode(false)} disabled={busy || !status}>Ручной</button>
          </div>
          <p className="mode-hint">{status?.obs_config.enabled ? "Companion меняет сцену по фазе матча." : "Вы управляете сценой кнопками ниже."}</p>
          <div className="scene-summary"><span>Активная сцена</span><strong>{status?.obs_active_scene ? sceneLabels[status.obs_active_scene] : "Не определена"}</strong></div>
          <div className="scene-actions">
            {(Object.keys(sceneLabels) as Scene[]).map((scene) => (
              <button key={scene} className={status?.obs_active_scene === scene ? "is-active" : ""} disabled={busy || !status?.obs_connected} onClick={() => void run(() => api.switchObsScene(scene))}>
                <span>{sceneLabels[scene]}</span>
                <small>{scene === "betweenMatches" ? "Лобби и паузы" : scene === "draft" ? "Выбор героев" : "Матч идёт"}</small>
              </button>
            ))}
          </div>
        </section>

        <button className="diagnostics-entry" onClick={() => setView("diagnostics")}>
          <span><strong>Нужны подробности?</strong><small>События GSI, настройки, логи и техническая диагностика</small></span><span>→</span>
        </button>
      </> : <div className="diagnostics-view">
        <div className="page-heading"><span className="section-heading__eyebrow">Для разработчика</span><h2>Диагностика</h2><p>Технические данные и настройки Companion. Повседневное управление находится на главной.</p></div>
        {error && <p className="app__error">Ошибка: {error}</p>}
        <section><h2>Базовая настройка</h2><StatusChecklist status={status} /></section>
        <div className="diagnostic-card"><ActionButtons busy={busy} canOpenDotaFolder={!!status?.dota_found} legacyCleanupInProgress={!!status?.legacy_cleanup_in_progress} onInstallGsi={() => void run(api.installGsi)} onPickFolder={() => void run(api.pickDotaFolder)} onOpenDotaFolder={() => void run(api.openDotaFolder)} onOpenLogs={() => void run(api.openLogsFolder)} onClearLog={() => void run(api.clearLog)} onRefresh={() => void run(api.getStatus)} /></div>
        <div className="diagnostic-card"><LastEventPanel event={latestEvent} requestCount={status?.request_count ?? 0} /></div>
        <EventHistoryList events={history} />
        <CompanionTokenForm status={status} busy={busy} onSave={(token) => run(() => api.saveCompanionToken(token))} />
        <BackendStatusPanel status={status} busy={busy} onResend={() => void run(api.resendCurrentState)} />
        <ObsScenePanel status={status} onStatus={setStatus} />
        <DiagnosticsPanel status={diagnostics.status} refresh={diagnostics.refresh} />
        {status?.log_dir && <p className="app__log-dir">Логи: {status.log_dir}</p>}
      </div>}
    </main>
  );
}
