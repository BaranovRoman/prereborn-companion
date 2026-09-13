import type { LifecycleStatus, StatusSnapshot, SyncOutboxStatus } from "../types/status";
import type { BackendStatusDescription } from "../utils/backendStatus";

// WK-124 - replaces the old "warning"/"error" tone pair (mustard-yellow
// read as a generic modern alert, not Dota HUD chrome - see App.css) with
// the palette this slice's reference calls for: "recovering" is a
// restrained dark red/crimson (a transient, still-retrying state),
// "critical" is a deeper, more saturated red (confirmed down / permanent
// data loss), "info" is a desaturated steel/blue reserved for backend/sync
// issues, which never touch the live stream and stay categorically softer
// than a GSI/OBS problem. No tone is ever yellow.
type ProblemTone = "recovering" | "critical" | "info";
interface ProblemItem {
  key: string;
  tone: ProblemTone;
  label: string;
  detail: string;
  // Reliability follow-up - the one interactive affordance ProblemBar items
  // support: a small dismiss control. Deliberately NOT a general actions
  // array (Switch/Keep for a default-device change needs two distinct
  // choices with different outcomes, which doesn't fit a status bar item -
  // see AudioDeviceChangeBanner.tsx, which reuses the existing
  // banner-with-buttons pattern from UpdateBanner.tsx/SessionPromptBanner.tsx
  // for that case instead).
  onDismiss?: () => void;
}

// Reliability follow-up - audio-output-device warnings, computed by
// useAudioOutputDevice.ts (no Rust/StatusSnapshot involvement - this is a
// frontend/webview-only concern, see audio/outputDevice.ts's doc comment).
export interface AudioOutputProblemState {
  selectedDeviceMissing: boolean;
  selectedDeviceLabel: string | null;
  defaultDeviceChangedNotice: string | null;
  onDismissDefaultDeviceChangedNotice: () => void;
}

interface Props {
  status: StatusSnapshot | null;
  backendStatus: BackendStatusDescription;
  syncStatus: SyncOutboxStatus | null;
  // Reliability follow-up - both optional so existing callers/tests that
  // don't pass them keep behaving exactly as before (no items pushed).
  lifecycle?: LifecycleStatus | null;
  audioOutput?: AudioOutputProblemState | null;
}

// WK-114 - replaces the permanent status-grid cards that used to sit on
// Главная: a genuinely healthy Companion renders nothing here at all. Reuses
// the existing ConnectionState model (gsi_state/obs_state/backend_state,
// see types/status.ts and state.rs) as the ONLY source of truth for what
// counts as a real problem - "waiting" (never checked yet, e.g. Dota simply
// hasn't been launched) is deliberately never shown as a problem, only a
// sustained "recovering"/"unavailable" is. Backend/sync issues stay
// categorically softer (always "warning", never "error") than GSI/OBS ones,
// matching utils/backendStatus.ts's WK-113 design: a sync problem never
// touches the live stream, a GSI/OBS problem can.
export function ProblemBar({ status, backendStatus, syncStatus, lifecycle, audioOutput }: Props) {
  if (!status) return null;
  const items: ProblemItem[] = [];

  // WK-115 copy audit - never show the raw technical error string here
  // (e.g. a raw OS socket error) - this bar is the most visible surface in
  // the app, not a troubleshooting tool. The same raw error is still
  // available on Диагностика for anyone who actually needs it (see
  // StatusChecklist).
  if (status.gsi_state === "unavailable") {
    items.push({ key: "gsi", tone: "critical", label: "Нет сигнала Dota", detail: "Локальный сервис недоступен. Подробности — в Диагностике." });
  } else if (status.gsi_state === "recovering") {
    items.push({ key: "gsi", tone: "recovering", label: "Нет сигнала Dota", detail: "Переподключение…" });
  }

  if (status.obs_state === "unavailable") {
    items.push({ key: "obs", tone: "critical", label: "OBS не подключён", detail: "Проверьте, что OBS запущен и WebSocket включён." });
  } else if (status.obs_state === "recovering") {
    items.push({ key: "obs", tone: "recovering", label: "OBS не подключён", detail: "Переподключение…" });
  }

  if (backendStatus.tone !== "ok" && (status.backend_state === "recovering" || status.backend_state === "unavailable")) {
    // WK-119 - while the backend is unreachable, tell the user how much is
    // waiting instead of just that it's waiting (the brief's "Pending: N
    // изменений ожидают отправки" state) - reusing this same item rather
    // than adding a second one, per the "no separate big sync card" rule.
    const pending = syncStatus?.pendingCount ?? 0;
    const detail = pending > 0 ? `${backendStatus.detail} Ожидает отправки: ${pending}.` : backendStatus.detail;
    items.push({ key: "backend", tone: "info", label: backendStatus.label, detail });
  }

  // WK-119 - dead-lettered sync events (the backend permanently rejected
  // them) are a real, standing problem independent of current connectivity -
  // surfaced here regardless of backend_state, with detail in Диагностика
  // (BackendStatusPanel) per the brief's "ProblemBar + Diagnostics details"
  // dead-letter requirement.
  if (syncStatus && syncStatus.failedCount > 0) {
    items.push({
      key: "sync-dead-letter",
      tone: "critical",
      label: "Часть данных не синхронизирована",
      detail: `${syncStatus.failedCount} событий отклонены сервером. Подробности — в Диагностике.`,
    });
  }

  // Reliability follow-up - "OBS unexpectedly stopped" (pending_end, the
  // existing 30s grace window before a session finalizes) takes precedence
  // over "OBS never confirmed streaming" when both happen to be true at once
  // (OBS drops mid-match, GSI still shows Gameplay) - it's the strictly more
  // specific/useful message, see local_runtime::lifecycle's field doc on
  // awaiting_start_confirmation. Neither fires for `session_state === "none"`
  // after a normal finalize (see the задача's "explicit stop is not a false
  // alarm" criterion) or for "needs_manual_recovery" (already surfaced as its
  // own actionable card on Главная, see LocalStreamLifecycleCard.tsx - not
  // duplicated here).
  if (lifecycle) {
    if (lifecycle.session_state === "pending_end") {
      items.push({
        key: "stream-pending-end",
        tone: "recovering",
        label: "Стрим неожиданно остановился",
        detail: "OBS перестал стримить. Если не возобновится, сессия завершится через 30 секунд.",
      });
    } else if (lifecycle.awaiting_start_confirmation) {
      items.push({
        key: "stream-not-confirmed",
        tone: "critical",
        label: "OBS не подтвердил трансляцию",
        detail: "Игра идёт, но OBS не стримит. Проверьте Start Streaming в OBS.",
      });
    }
  }

  // Reliability follow-up - the selected explicit output device disappearing
  // is the higher-priority audio warning (задача п.1/п.2); a plain
  // system-default-changed notice is informational only.
  if (audioOutput?.selectedDeviceMissing) {
    items.push({
      key: "audio-device-missing",
      tone: "critical",
      label: "Выбранное аудиоустройство недоступно",
      detail: `«${audioOutput.selectedDeviceLabel ?? "устройство"}» не найдено. TTS и алерты играют на резервном устройстве — выберите другое в Настройках → Чат и TTS.`,
    });
  } else if (audioOutput?.defaultDeviceChangedNotice) {
    items.push({
      key: "audio-default-changed",
      tone: "info",
      label: "Системное аудиоустройство изменилось",
      detail: audioOutput.defaultDeviceChangedNotice,
      onDismiss: audioOutput.onDismissDefaultDeviceChangedNotice,
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="problem-bars" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.key} className={`problem-bar problem-bar--${item.tone}`}>
          <span className="problem-bar__label">{item.label}</span>
          <span className="problem-bar__detail">{item.detail}</span>
          {item.onDismiss && (
            <button className="problem-bar__dismiss" onClick={item.onDismiss} aria-label="Скрыть">✕</button>
          )}
        </div>
      ))}
    </div>
  );
}
