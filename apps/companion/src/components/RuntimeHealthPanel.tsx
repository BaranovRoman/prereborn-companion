import type { HealthComponent, HealthStatusValue, RuntimeHealth } from "../types/status";
import { formatTimestamp } from "../utils/format";

interface Props {
  health: RuntimeHealth | null;
}

const MODIFIER: Record<HealthStatusValue, string> = {
  healthy: "check-item--ok",
  degraded: "check-item--degraded",
  unavailable: "check-item--unavailable",
  disabled: "check-item--muted",
  unknown: "check-item--muted",
};

const MARK: Record<HealthStatusValue, string> = {
  healthy: "✔",
  degraded: "!",
  unavailable: "✕",
  disabled: "–",
  unknown: "?",
};

function ComponentRow({ label, component }: { label: string; component: HealthComponent }) {
  // WK-126 §12 - healthy/disabled stay quiet (no detail line at all); only
  // an actual problem (degraded/unavailable) or a genuinely unresolved
  // unknown shows its reason, matching ProblemBar's "no permanent status
  // grid" spirit even inside this more detailed Diagnostics view.
  const showReason = component.status !== "healthy" && component.status !== "disabled" && component.reason;
  return (
    <li className={`check-item ${MODIFIER[component.status]}`}>
      <span className="check-item__box">{MARK[component.status]}</span>
      <span className="check-item__label">{label}</span>
      {showReason && <span className="check-item__detail">{component.reason}</span>}
    </li>
  );
}

function Group({ title, status, children }: { title: string; status: HealthStatusValue; children: React.ReactNode }) {
  return (
    <div className="runtime-health-group">
      <h3 className={`runtime-health-group__title ${MODIFIER[status]}`}>
        <span className="check-item__box">{MARK[status]}</span>
        {title}
      </h3>
      <ul className="status-checklist">{children}</ul>
    </div>
  );
}

// WK-126 - Diagnostics v2. One canonical read-only projection reused as-is
// (see hooks/useRuntimeHealth, src-tauri/src/runtime_health.rs) - reuses the
// existing StatusChecklist/check-item visual language rather than a new
// card design, per the task's "no modern rounded cards" constraint.
export function RuntimeHealthPanel({ health }: Props) {
  if (!health) return null;
  return (
    <div className="diagnostic-card runtime-health-panel">
      <h2>Состояние Companion</h2>
      <Group title="Локальный runtime" status={health.localRuntime.status}>
        <ComponentRow label="GSI" component={health.localRuntime.gsi} />
        <ComponentRow label="Локальная сессия" component={health.localRuntime.localSession} />
        <ComponentRow label="Локальная БД" component={health.localRuntime.sqlite} />
        <ComponentRow label="Оверлей-сервер" component={health.localRuntime.overlayServer} />
      </Group>
      <Group title="Интеграции" status={health.integrations.status}>
        <ComponentRow label="OBS" component={health.integrations.obs} />
        <ComponentRow label="Автосмена сцен OBS" component={health.integrations.obsSceneAutomation} />
        <ComponentRow label="Twitch-чат" component={health.integrations.twitch} />
        <ComponentRow label="Озвучка (TTS)" component={health.integrations.tts} />
        <ComponentRow label="Игровые звуки" component={health.integrations.gameSounds} />
      </Group>
      <Group title="Облако" status={health.cloud.status}>
        <ComponentRow label="PreReborn backend" component={health.cloud.backend} />
        <ComponentRow label="Синхронизация" component={health.cloud.sync} />
        <ComponentRow label="Аккаунт" component={health.cloud.account} />
      </Group>
      <p className="diagnostics-panel__hint">Обновлено: {formatTimestamp(health.generatedAt)}</p>
    </div>
  );
}
