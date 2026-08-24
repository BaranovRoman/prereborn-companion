import { AutostartSetting } from "../components/AutostartSetting";
import { CompanionTokenForm } from "../components/CompanionTokenForm";
import { ObsScenePanel } from "../components/ObsScenePanel";
import type { AutostartState } from "../hooks/useAutostart";
import * as api from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";

interface AutostartSlice {
  state: AutostartState;
  busy: boolean;
  setAutostart: (enabled: boolean) => void;
}

interface Props {
  status: StatusSnapshot | null;
  setStatus: (status: StatusSnapshot) => void;
  busy: boolean;
  run: (action: () => Promise<StatusSnapshot | void>) => Promise<void>;
  autostart: AutostartSlice;
}

// Companion UI 2.0 - "Настройки": everything that used to be spread across
// the first-run wizard and Диагностика but is really steady-state user
// configuration, not troubleshooting. OBS scene mapping (ObsScenePanel) and
// the companion token used to be duplicated between the setup wizard and
// the old diagnostics view - this is now their single home for returning
// users (the setup wizard on Главная keeps its own copy of the token form
// for first-run guidance, which is normal onboarding UX, not the kind of
// old/new duplication being cleaned up here - see AppShell/HomePage).
export function SettingsPage({ status, setStatus, busy, run, autostart }: Props) {
  return (
    <div className="settings-view">
      <div className="page-heading">
        <span className="section-heading__eyebrow">Настройки</span>
        <h2>Настройки</h2>
        <p>OBS, автозапуск и подключение к PreReborn.</p>
      </div>

      {/* Group labels are plain text, not headings - CompanionTokenForm/
          ObsScenePanel already carry their own <h2> (also used standalone
          in the Главная setup wizard), so nesting another heading level
          above them here would invert the document outline (h2 "Настройки"
          -> h3 group label -> h2 "Companion token" jumps backward instead
          of deeper). */}
      <div className="settings-group">
        <span className="settings-group__label">Подключение</span>
        <CompanionTokenForm status={status} busy={busy} onSave={(token) => run(() => api.saveCompanionToken(token))} />
      </div>

      <div className="settings-group">
        <span className="settings-group__label">OBS</span>
        <ObsScenePanel status={status} onStatus={setStatus} />
      </div>

      <div className="settings-group">
        <AutostartSetting state={autostart.state} busy={autostart.busy} onChange={autostart.setAutostart} />
      </div>
    </div>
  );
}
