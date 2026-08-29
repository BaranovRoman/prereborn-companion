import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppAtmosphere } from "./AppAtmosphere";
import { ProblemBar } from "./ProblemBar";
import { SessionPromptBanner } from "./SessionPromptBanner";
import { SettingsModal, type Category as SettingsCategory } from "./SettingsModal";
import { TwitchChatPage } from "./TwitchChatPage";
import { UpdateBanner } from "./UpdateBanner";
import { useTwitchChatSession } from "../chat/useTwitchChatSession";
import { useAutostart } from "../hooks/useAutostart";
import { useDiagnostics } from "../hooks/useDiagnostics";
import { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";
import { useGsiEvents } from "../hooks/useGsiEvents";
import { useLocalLifecycle } from "../hooks/useLocalLifecycle";
import { useLocalSessionSummary } from "../hooks/useLocalSessionSummary";
import { useStatus } from "../hooks/useStatus";
import { useSyncOutboxStatus } from "../hooks/useSyncOutboxStatus";
import { useStreamSessionPrompt } from "../hooks/useStreamSessionPrompt";
import { useUpdater } from "../hooks/useUpdater";
import { DiagnosticsPage } from "../pages/DiagnosticsPage";
import { DesignPage } from "../pages/DesignPage";
import { HeroDetailPage } from "../pages/HeroDetailPage";
import { HeroesPage } from "../pages/HeroesPage";
import { HomePage } from "../pages/HomePage";
import { SoundsPage } from "../pages/SoundsPage";
import * as api from "../services/dotaCompanionApi";
import { getHeroById } from "../services/heroCatalog";
import { useGameSoundEngine } from "../sounds/useGameSoundEngine";
import type { StatusSnapshot } from "../types/status";
import { describeBackendStatus } from "../utils/backendStatus";

type Section = "home" | "heroes" | "design" | "chat" | "sounds" | "diagnostics";

const MAIN_NAV_ITEMS: { key: Section; label: string }[] = [
  { key: "home", label: "Главная" },
  { key: "heroes", label: "Герои" },
  { key: "design", label: "Оформление" },
  { key: "chat", label: "Чат" },
  { key: "sounds", label: "Звуки" },
];

// WK-114 - Old Dota Companion shell: a heavy top header (brand + gear +
// primary nav) instead of the previous sidebar, in place of the generic
// rounded-dashboard IA from Companion UI 2.0. Settings is no longer a nav
// item - the gear button opens it as a large modal (SettingsModal).
// Diagnostics is reachable but deliberately not one of the equal-weight
// primary tabs (see the header's secondary link). Connection problems are
// surfaced only when they're real (ProblemBar, driven by the existing
// ConnectionState model) - a healthy Companion shows no status chrome at
// all under the header, matching the задача's "no permanent status cards"
// rule.
export function AppShell() {
  const { status, setStatus, refresh } = useStatus();
  const history = useGsiEvents();
  const diagnostics = useDiagnostics();
  const updater = useUpdater();
  const autostart = useAutostart();
  const chatSession = useTwitchChatSession();
  const gameSoundEngine = useGameSoundEngine();
  const sessionPrompt = useStreamSessionPrompt();
  const localLifecycle = useLocalLifecycle();
  const sessionSummary = useLocalSessionSummary();
  const syncStatus = useSyncOutboxStatus();
  const favoriteHeroes = useFavoriteHeroes();
  const [section, setSection] = useState<Section>("home");
  const [selectedHeroId, setSelectedHeroId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | undefined>(undefined);
  const openSettings = (category?: SettingsCategory) => {
    setSettingsCategory(category);
    setSettingsOpen(true);
  };
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

  const backendStatus = describeBackendStatus(status);
  const hasGsiSignal = status?.gsi_state === "connected";
  const ready = !!(status?.server_running && status.gsi_installed && hasGsiSignal && status.obs_connected);

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
      {/* WK-115 audit - mounted once here, outside every tab's conditional
          render below, so the atmosphere never remounts/flickers when
          `section` changes - see AppAtmosphere.tsx. */}
      <AppAtmosphere />
      <header className="app-header">
        <div className="app-header__left">
          <button className="app-header__gear" onClick={() => openSettings()} aria-label="Настройки">⚙</button>
          <img className="app-header__logo" src="/logo-new.png" alt="" width="40" height="40" />
          <span className="app-header__brandmark">
            <strong className="app-header__brand">PreReborn</strong>
            <span className="app-header__brand-sub">Companion</span>
          </span>
        </div>
        <nav className="app-header__nav" aria-label="Разделы приложения">
          {MAIN_NAV_ITEMS.map((item) => (
            <button key={item.key} className={section === item.key ? "is-active" : ""} onClick={() => setSection(item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="app-header__right">
          <button
            className={`app-header__diagnostics ${section === "diagnostics" ? "is-active" : ""}`}
            onClick={() => setSection("diagnostics")}
          >
            Диагностика
          </button>
          {status?.companion_version && <span className="app-header__version">v{status.companion_version}</span>}
        </div>
      </header>

      <ProblemBar status={status} backendStatus={backendStatus} syncStatus={syncStatus} />

      <main className="main">
        <UpdateBanner
          state={updater.state}
          onCheck={() => void updater.checkForUpdate()}
          onInstall={() => void updater.installUpdate()}
          onRestart={() => void updater.restartToApply()}
          onDismiss={updater.dismiss}
        />

        <SessionPromptBanner
          show={sessionPrompt.showPrompt && sessionPrompt.promptMode !== "endedNewOnly"}
          mode={sessionPrompt.promptMode}
          session={sessionPrompt.promptData}
          busy={sessionPrompt.busy}
          error={sessionPrompt.error}
          onContinue={sessionPrompt.onContinue}
          onStartNew={() => void sessionPrompt.onStartNew()}
        />

        {error && <p className="app__error">Ошибка: {error}</p>}

        {section === "home" && (
          <HomePage
            status={status}
            busy={busy}
            run={run}
            ready={ready}
            backendStatus={backendStatus}
            hasGsiSignal={hasGsiSignal}
            setupOpen={setupOpen}
            setSetupOpen={setSetupOpen}
            finishSetup={finishSetup}
            provisionGsi={provisionGsi}
            checkObs={checkObs}
            setAutomaticMode={setAutomaticMode}
            localLifecycle={localLifecycle}
            sessionSummary={sessionSummary}
          />
        )}
        {section === "heroes" && (
          selectedHeroId !== null ? (
            <HeroDetailPage
              heroId={selectedHeroId}
              favorites={favoriteHeroes}
              trackedHero={
                gameSoundEngine.catalog?.heroes.find(
                  (h) => h.id === `npc_dota_hero_${getHeroById(selectedHeroId)?.name}`
                ) ?? null
              }
              settings={gameSoundEngine.settings}
              onBack={() => setSelectedHeroId(null)}
              onChooseFile={async (eventId, kind) => {
                gameSoundEngine.stopPreview();
                await gameSoundEngine.chooseAndBindFile(eventId, kind);
              }}
              onPreview={(assetId) => gameSoundEngine.preview(assetId, gameSoundEngine.settings?.masterVolume ?? 100)}
              onRemove={gameSoundEngine.removeBinding}
            />
          ) : (
            <HeroesPage
              favorites={favoriteHeroes}
              soundSettings={gameSoundEngine.settings}
              trackedHeroes={gameSoundEngine.catalog?.heroes ?? []}
              onSelectHero={setSelectedHeroId}
            />
          )
        )}
        {section === "design" && <DesignPage />}
        {section === "chat" && <TwitchChatPage session={chatSession} onOpenChatSettings={() => openSettings("chat")} />}
        {section === "sounds" && <SoundsPage engine={gameSoundEngine} />}
        {section === "diagnostics" && (
          <DiagnosticsPage
            status={status}
            busy={busy}
            run={run}
            history={history}
            latestEvent={history[0] ?? status?.last_event ?? null}
            diagnosticsStatus={diagnostics.status}
            diagnosticsRefresh={diagnostics.refresh}
            sessionPrompt={sessionPrompt}
            syncStatus={syncStatus}
          />
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        status={status}
        setStatus={setStatus}
        busy={busy}
        run={run}
        autostart={autostart}
        hotkeyStatus={chatSession.skipHotkeyStatus}
        hotkeyBusy={chatSession.skipHotkeyBusy}
        onUpdateHotkey={chatSession.updateSkipHotkey}
        chatSession={chatSession}
        initialCategory={settingsCategory}
      />
    </div>
  );
}
