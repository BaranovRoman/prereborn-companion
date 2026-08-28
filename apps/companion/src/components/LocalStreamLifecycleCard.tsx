import type { LocalLifecycleState } from "../hooks/useLocalLifecycle";

interface Props {
  lifecycle: LocalLifecycleState;
}

// WK-112/WK-114 - the primary "is my stream running" status: driven entirely
// by OBS Start/Stop Streaming (see local_runtime::lifecycle), no button to
// press in the normal case. Renders as a single compact status line for the
// three ordinary states (none/open/pending_end) - not a card demanding
// attention - and only becomes a real, actionable prompt for the rare
// "needs_manual_recovery" case (a suspiciously old open session), matching
// the задача's "healthy/ordinary state should not visually compete for
// attention" rule for Главная as a whole.
export function LocalStreamLifecycleCard({ lifecycle }: Props) {
  const { status, busy, error, onContinue, onEnd } = lifecycle;
  const state = status?.session_state ?? "none";

  if (state !== "needs_manual_recovery") {
    return (
      <p className="stream-status-line">
        {state === "none" && "Ожидание старта стрима в OBS"}
        {state === "open" && "Стрим идёт"}
        {state === "pending_end" && "OBS остановлен — завершаем через 30 сек, если не возобновится"}
        {error && ` · ${error}`}
      </p>
    );
  }

  return (
    <section className="stream-status-line stream-status-line--attention">
      <div className="stream-status-line__info">
        <strong>Найдена давно открытая сессия — нужно решение</strong>
        {error && <p>{error}</p>}
      </div>
      <div className="stream-status-line__actions">
        <button className="button button--primary" disabled={busy} onClick={() => void onContinue()}>
          {busy ? "Применяем…" : "Продолжить эту сессию"}
        </button>
        <button className="button button--danger" disabled={busy} onClick={() => void onEnd()}>
          {busy ? "Применяем…" : "Завершить старую сессию"}
        </button>
      </div>
    </section>
  );
}
