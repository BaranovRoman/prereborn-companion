import type { LocalLifecycleState } from "../hooks/useLocalLifecycle";

interface Props {
  lifecycle: LocalLifecycleState;
}

// WK-112 - the new primary "is my stream running" status: driven entirely
// by OBS Start/Stop Streaming (see local_runtime::lifecycle), no button to
// press in the normal case. Only ever asks for input in the rare
// "needs_manual_recovery" case (a suspiciously old open session) - normal
// start/continue/end is fully automatic. The pre-existing StreamSessionCard
// (backend session, WK-83/WK-100) stays available as a manual/debug
// fallback elsewhere on this page - this card doesn't replace it, it just
// takes over as the thing a streamer actually looks at day to day.
export function LocalStreamLifecycleCard({ lifecycle }: Props) {
  const { status, busy, error, onContinue, onEnd } = lifecycle;
  const state = status?.session_state ?? "none";

  return (
    <section className="session-bar">
      <div className="session-bar__info">
        <span className="section-heading__eyebrow">Локальная сессия (по OBS)</span>
        <strong>
          {state === "none" && "Ожидание старта стрима в OBS"}
          {state === "open" && "Стрим идёт"}
          {state === "pending_end" && "OBS остановлен — завершаем через 30 сек, если не возобновится"}
          {state === "needs_manual_recovery" && "Найдена давно открытая сессия — нужно решение"}
        </strong>
        {state !== "needs_manual_recovery" && (
          <p className="session-bar__hint">
            Начинается и заканчивается автоматически по Start/Stop Streaming в OBS.
          </p>
        )}
        {error && <p>{error}</p>}
      </div>
      {state === "needs_manual_recovery" && (
        <div className="session-bar__actions">
          <button className="button button--primary" disabled={busy} onClick={() => void onContinue()}>
            {busy ? "Применяем…" : "Продолжить эту сессию"}
          </button>
          <button className="button button--danger" disabled={busy} onClick={() => void onEnd()}>
            {busy ? "Применяем…" : "Завершить старую сессию"}
          </button>
        </div>
      )}
    </section>
  );
}
