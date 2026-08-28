import { useEffect, useState } from "react";
import { AutostartSetting } from "./AutostartSetting";
import { CompanionTokenForm } from "./CompanionTokenForm";
import { HotkeySettings } from "./HotkeySettings";
import { ObsScenePanel } from "./ObsScenePanel";
import type { AutostartState } from "../hooks/useAutostart";
import * as api from "../services/dotaCompanionApi";
import type { SkipHotkeyStatus } from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";

type Category = "connection" | "obs" | "hotkeys" | "autostart";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "connection", label: "Подключение" },
  { key: "obs", label: "OBS" },
  { key: "hotkeys", label: "Горячие клавиши" },
  { key: "autostart", label: "Запуск" },
];

interface AutostartSlice {
  state: AutostartState;
  busy: boolean;
  setAutostart: (enabled: boolean) => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  status: StatusSnapshot | null;
  setStatus: (status: StatusSnapshot) => void;
  busy: boolean;
  run: (action: () => Promise<StatusSnapshot | void>) => Promise<void>;
  autostart: AutostartSlice;
  hotkeyStatus: SkipHotkeyStatus | null;
  hotkeyBusy: boolean;
  onUpdateHotkey: (enabled: boolean, shortcut: string) => Promise<void>;
}

// WK-114 - "Настройки" moves out of main navigation into a large system-style
// modal opened via the header's gear icon (old game client options window:
// a category rail + one content pane), rather than a small popover and
// rather than a page competing with Главная/Чат/Звуки. Hosts the exact same
// settings components the old SettingsPage did - connection token, OBS
// mapping, hotkeys, autostart - nothing lost in the move, see this
// component's removal in the same change.
export function SettingsModal({
  open, onClose, status, setStatus, busy, run, autostart, hotkeyStatus, hotkeyBusy, onUpdateHotkey,
}: Props) {
  const [category, setCategory] = useState<Category>("connection");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-modal__backdrop" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Настройки" onClick={(event) => event.stopPropagation()}>
        <div className="settings-modal__header">
          <h2>Настройки</h2>
          <button className="settings-modal__close" onClick={onClose} aria-label="Закрыть настройки">✕</button>
        </div>
        <div className="settings-modal__body">
          <nav className="settings-modal__rail" aria-label="Категории настроек">
            {CATEGORIES.map((item) => (
              <button key={item.key} className={category === item.key ? "is-active" : ""} onClick={() => setCategory(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal__content">
            {category === "connection" && (
              <CompanionTokenForm status={status} busy={busy} onSave={(token) => run(() => api.saveCompanionToken(token))} />
            )}
            {category === "obs" && <ObsScenePanel status={status} onStatus={setStatus} />}
            {category === "hotkeys" && <HotkeySettings status={hotkeyStatus} busy={hotkeyBusy} onUpdate={onUpdateHotkey} />}
            {category === "autostart" && <AutostartSetting state={autostart.state} busy={autostart.busy} onChange={autostart.setAutostart} />}
          </div>
        </div>
      </div>
    </div>
  );
}
