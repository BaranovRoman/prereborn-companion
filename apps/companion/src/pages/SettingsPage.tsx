import { AutostartSetting } from "../components/AutostartSetting";
import { CompanionTokenForm } from "../components/CompanionTokenForm";
import { HotkeySettings } from "../components/HotkeySettings";
import { ObsScenePanel } from "../components/ObsScenePanel";
import type { AutostartState } from "../hooks/useAutostart";
import * as api from "../services/dotaCompanionApi";
import type { SkipHotkeyStatus } from "../services/dotaCompanionApi";
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
  hotkeyStatus: SkipHotkeyStatus | null;
  hotkeyBusy: boolean;
  onUpdateHotkey: (enabled: boolean, shortcut: string) => Promise<void>;
}

// Companion UI 2.0 follow-up - "Настройки": everything that used to be
// spread across the first-run wizard, Диагностика, and (for hotkeys) Чат,
// but is really steady-state user configuration. OBS scene mapping and the
// companion token used to be duplicated between the setup wizard and the
// old diagnostics view - this is now their single home for returning users
// (the setup wizard on Главная keeps its own copy of the token form for
// first-run guidance, which is normal onboarding UX, not the kind of
// old/new duplication that was cleaned up here).
//
// One continuous panel with internal dividers rather than 4 separate
// floating cards (задача: "не превращать каждый блок в отдельную rounded
// card... снизить количество декоративных контейнеров") - hierarchy comes
// from the section labels/spacing/borders inside, not from stacking more
// bordered boxes.
export function SettingsPage({ status, setStatus, busy, run, autostart, hotkeyStatus, hotkeyBusy, onUpdateHotkey }: Props) {
  return (
    <div className="settings-view">
      <div className="page-heading">
        <span className="section-heading__eyebrow">Настройки</span>
        <h2>Настройки</h2>
        <p>Подключение, OBS, горячие клавиши и автозапуск.</p>
      </div>

      <div className="settings-panel">
        <div className="settings-panel__group">
          <span className="settings-group__label">Подключение</span>
          <CompanionTokenForm status={status} busy={busy} onSave={(token) => run(() => api.saveCompanionToken(token))} />
        </div>

        <div className="settings-panel__group">
          <span className="settings-group__label">OBS</span>
          <ObsScenePanel status={status} onStatus={setStatus} />
        </div>

        <div className="settings-panel__group">
          <span className="settings-group__label">Горячие клавиши</span>
          <HotkeySettings status={hotkeyStatus} busy={hotkeyBusy} onUpdate={onUpdateHotkey} />
        </div>

        <div className="settings-panel__group">
          <span className="settings-group__label">Запуск</span>
          <AutostartSetting state={autostart.state} busy={autostart.busy} onChange={autostart.setAutostart} />
        </div>
      </div>
    </div>
  );
}
