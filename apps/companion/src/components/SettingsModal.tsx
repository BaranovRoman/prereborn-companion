import { useEffect, useState } from "react";
import { AccountForm } from "./AccountForm";
import { AutostartSetting } from "./AutostartSetting";
import { HotkeySettings } from "./HotkeySettings";
import { ObsScenePanel } from "./ObsScenePanel";
import { ChatTtsSettings } from "./settings/ChatTtsSettings";
import type { TwitchChatSession } from "../chat/useTwitchChatSession";
import type { AutostartState } from "../hooks/useAutostart";
import { useModalBehavior } from "../hooks/useModalBehavior";
import type { SkipHotkeyStatus } from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";

// WK-121 §4 - Settings ownership audit result: connection/OBS/hotkeys/
// autostart stay (app-behavior configuration), "Чат и TTS" is new (moved
// out of the Chat screen's sidebar - see ChatTtsSettings.tsx's doc
// comment). Chat itself keeps only runtime concerns.
export type Category = "account" | "obs" | "chat" | "hotkeys" | "autostart";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "account", label: "Аккаунт" },
  { key: "obs", label: "OBS" },
  { key: "chat", label: "Чат и TTS" },
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
  chatSession: TwitchChatSession;
  /** Opens directly onto a specific category (e.g. Chat's "Открыть настройки
   *  чата и TTS" link) - re-applied every time the modal opens. */
  initialCategory?: Category;
}

// WK-114 - "Настройки" moves out of main navigation into a large system-style
// modal opened via the header's gear icon (old game client options window:
// a category rail + one content pane), rather than a small popover and
// rather than a page competing with Главная/Чат/Звуки. Hosts the exact same
// settings components the old SettingsPage did - connection token, OBS
// mapping, hotkeys, autostart - nothing lost in the move, see this
// component's removal in the same change.
export function SettingsModal({
  open, onClose, status, setStatus, autostart, hotkeyStatus, hotkeyBusy, onUpdateHotkey,
  chatSession, initialCategory,
}: Props) {
  const [category, setCategory] = useState<Category>("account");
  const containerRef = useModalBehavior(open, onClose);

  useEffect(() => {
    if (open && initialCategory) setCategory(initialCategory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCategory]);

  if (!open) return null;

  return (
    <div className="settings-modal__backdrop" onClick={onClose}>
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
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
            {/* WK-115 - ObsScenePanel renders nothing at all while `status`
                hasn't loaded yet (see its early `return null`) - in practice
                status resolves almost instantly after launch, but an empty
                content pane with no explanation is still a real
                loading-state gap the audit should close, not leave as
                silent blank space. AccountForm manages its own loading
                state (account status is a separate, async Tauri call). */}
            {category === "account" && <AccountForm />}
            {category === "obs" && (
              status
                ? <ObsScenePanel status={status} onStatus={setStatus} />
                : <p className="matches-panel__empty">Загрузка…</p>
            )}
            {category === "chat" && <ChatTtsSettings session={chatSession} />}
            {category === "hotkeys" && <HotkeySettings status={hotkeyStatus} busy={hotkeyBusy} onUpdate={onUpdateHotkey} />}
            {category === "autostart" && <AutostartSetting state={autostart.state} busy={autostart.busy} onChange={autostart.setAutostart} />}
          </div>
        </div>
      </div>
    </div>
  );
}
