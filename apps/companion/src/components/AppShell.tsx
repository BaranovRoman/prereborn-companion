import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SessionPromptBanner } from "./SessionPromptBanner";
import { TwitchChatPage } from "./TwitchChatPage";
import { UpdateBanner } from "./UpdateBanner";
import { useTwitchChatSession } from "../chat/useTwitchChatSession";
import { useAutostart } from "../hooks/useAutostart";
import { useDiagnostics } from "../hooks/useDiagnostics";
import { useGsiEvents } from "../hooks/useGsiEvents";
import { useLocalLifecycle } from "../hooks/useLocalLifecycle";
import { useStatus } from "../hooks/useStatus";
import { useStreamSessionPrompt } from "../hooks/useStreamSessionPrompt";
import { useUpdater } from "../hooks/useUpdater";
import { DiagnosticsPage } from "../pages/DiagnosticsPage";
import { HomePage } from "../pages/HomePage";
import { SettingsPage } from "../pages/SettingsPage";
import { SoundsPage } from "../pages/SoundsPage";
import * as api from "../services/dotaCompanionApi";
import { useGameSoundEngine } from "../sounds/useGameSoundEngine";
import type { StatusSnapshot } from "../types/status";
import { describeBackendStatus } from "../utils/backendStatus";

type Section = "home" | "chat" | "settings" | "sounds" | "diagnostics";

const NAV_ITEMS: { key: Section; label: string; hint: string }[] = [
  { key: "home", label: "Главная", hint: "Статус и управление эфиром" },
  { key: "chat", label: "Чат", hint: "Twitch-чат и озвучка" },
  { key: "sounds", label: "Звуки", hint: "Реакции на предметы и способности" },
  { key: "settings", label: "Настройки", hint: "OBS, автозапуск, подключение" },
  { key: "diagnostics", label: "Диагностика", hint: "Для разработчика" },
];

// Companion UI 2.0 - single owner of all app-root state (status polling, GSI
// event feed, diagnostics, updater, chat session, session prompt, autostart)
// and the desktop shell (sidebar nav + always-visible banners). Previously
// all of this lived directly inside HomePage, which also owned every view's
// markup - that's the monolith this component replaces. Each page component
// (HomePage/SettingsPage/DiagnosticsPage, plus the pre-existing
// TwitchChatPage) now only receives the specific slice of state/actions it
// actually renders.
export function AppShell() {
  const { status, setStatus, refresh } = useStatus();
  const history = useGsiEvents();
  const diagnostics = useDiagnostics();
  const updater = useUpdater();
  const autostart = useAutostart();
  // WK-78 - owned here (app root, always mounted) rather than inside
  // TwitchChatPage, so chat polling/dedup and TTS keep running regardless
  // of which section is currently visible.
  const chatSession = useTwitchChatSession();
  // WK-106 - hoisted here (not inside SoundsPage) for the same reason
  // chatSession is (see the WK-78 note above): the "game-sound-play"
  // listener/playback must keep working regardless of which sidebar section
  // is currently visible, not just while the user is looking at "Звуки".
  const gameSoundEngine = useGameSoundEngine();
  const sessionPrompt = useStreamSessionPrompt();
  // WK-112 - OBS-driven local stream lifecycle, independent polling from
  // the backend-session prompt above (see useLocalLifecycle's doc comment).
  const localLifecycle = useLocalLifecycle();
  const [section, setSection] = useState<Section>("home");
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
  const backendStatus = describeBackendStatus(status);
  const hasGsiSignal = status?.gsi_state === "connected";
  const ready = !!(backendStatus.ready && status?.server_running && status.gsi_installed && hasGsiSignal && status.obs_connected);

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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <img className="sidebar__logo" src="/logo-new.png" alt="" width="40" height="40" />
          <div>
            <span className="sidebar__eyebrow">Desktop Companion</span>
            <strong>PreReborn</strong>
            {status?.companion_version && <span className="sidebar__version">v{status.companion_version}</span>}
          </div>
        </div>
        <nav className="sidebar__nav" aria-label="Разделы приложения">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={section === item.key ? "is-active" : ""}
              onClick={() => setSection(item.key)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar__footer">
          <span className={`connection-pill ${backendStatus.ready ? "is-online" : ""}`}>
            {backendStatus.ready ? "На связи" : backendStatus.label}
          </span>
        </div>
      </aside>

      <main className="main">
        <UpdateBanner
          state={updater.state}
          onCheck={() => void updater.checkForUpdate()}
          onInstall={() => void updater.installUpdate()}
          onRestart={() => void updater.restartToApply()}
          onDismiss={updater.dismiss}
        />

        {/* Companion UI 2.0 follow-up - "endedNewOnly" is now covered by the
            always-visible StreamSessionCard on Главная (see HomePage.tsx),
            which offers the same "Начать новый стрим" action without
            requiring the user to be on Главная to see it hidden behind a
            dismissible nudge. This banner now only ever fires for the
            genuinely different "stale-but-still-active" case
            ("continueOrNew") - showing both would duplicate the same
            control (задача: "не должно остаться дублирующих controls"). */}
        <SessionPromptBanner
          show={sessionPrompt.showPrompt && sessionPrompt.promptMode !== "endedNewOnly"}
          mode={sessionPrompt.promptMode}
          session={sessionPrompt.promptData}
          busy={sessionPrompt.busy}
          error={sessionPrompt.error}
          onContinue={sessionPrompt.onContinue}
          onStartNew={() => void sessionPrompt.onStartNew()}
        />

        {/* Shared across every section - the same `run()`/`busy`/`error`
            primitive HomePage owned before the split, now surfaced once at
            shell level so an action triggered from any page reports here
            regardless of which section is active when it settles. */}
        {error && <p className="app__error">Ошибка: {error}</p>}

        {section === "home" && (
          <HomePage
            status={status}
            busy={busy}
            run={run}
            ready={ready}
            backendStatus={backendStatus}
            hasGsiSignal={hasGsiSignal}
            requestCount={status?.request_count ?? history.length}
            setupOpen={setupOpen}
            setSetupOpen={setSetupOpen}
            finishSetup={finishSetup}
            provisionGsi={provisionGsi}
            checkObs={checkObs}
            setAutomaticMode={setAutomaticMode}
            sessionPrompt={sessionPrompt}
            localLifecycle={localLifecycle}
          />
        )}
        {section === "chat" && <TwitchChatPage session={chatSession} />}
        {section === "sounds" && <SoundsPage engine={gameSoundEngine} />}
        {section === "settings" && (
          <SettingsPage
            status={status}
            setStatus={setStatus}
            busy={busy}
            run={run}
            autostart={autostart}
            hotkeyStatus={chatSession.skipHotkeyStatus}
            hotkeyBusy={chatSession.skipHotkeyBusy}
            onUpdateHotkey={chatSession.updateSkipHotkey}
          />
        )}
        {section === "diagnostics" && (
          <DiagnosticsPage
            status={status}
            busy={busy}
            run={run}
            history={history}
            latestEvent={latestEvent}
            diagnosticsStatus={diagnostics.status}
            diagnosticsRefresh={diagnostics.refresh}
          />
        )}
      </main>
    </div>
  );
}
