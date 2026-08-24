import type { StreamSessionPromptState } from "../hooks/useStreamSessionPrompt";

interface Props {
  sessionPrompt: StreamSessionPromptState;
}

// Companion UI 2.0 follow-up - "Стрим-сессия": start/end controls for the
// backend/product concept of a stream session, kept structurally and
// visually separate from the OBS scene panel (see задача: "OBS connection
// и GSI/Dota - независимые integrations", not a gate for session controls).
// Rendered once at the top of Главная, unconditionally - including while
// the first-run setup wizard is still open and regardless of OBS/GSI
// status, because starting/ending a stream only ever depends on the
// backend + companion token (see useStreamSessionPrompt's initial fetch),
// never on OBS or Dota state.
//
// State mapping (see задача's A-F): `promptData` is null until the first
// fetch settles. Once it resolves, Companion's session is always exactly
// "active" or "ended" (never a third "none" state - see
// controllers/stream/companion.ts's getOrCreateActiveSession semantics),
// so `promptData.state` alone answers "start available" vs "end available".
// A null `promptData` with a set `error` means the backend/token genuinely
// isn't usable yet (D) - shown honestly, never a fake-enabled button, with
// a manual retry (self-review finding: the initial fetch never re-runs on
// its own, so without this button a stale error - e.g. "add a companion
// token" - would outlive the user actually fixing it in Настройки until
// the whole app restarted).
export function StreamSessionCard({ sessionPrompt }: Props) {
  const { promptData, promptMode, showPrompt, busy, error, onStartNew, onEndStream, refresh } = sessionPrompt;

  const state: "loading" | "unavailable" | "active" | "ended" = promptData
    ? promptData.state
    : error
      ? "unavailable"
      : "loading";

  // SessionPromptBanner is only actually rendered for "continueOrNew" (see
  // AppShell.tsx - "endedNewOnly" is deliberately suppressed there because
  // this card already covers the ended state). getSessionPromptMode returns
  // "endedNewOnly" for EVERY ended session unconditionally, so `showPrompt`
  // alone is true whenever state is "ended" regardless of whether the
  // banner is actually on screen - checking `promptMode` too is what makes
  // this card still show its own error while ended (self-review finding:
  // the naive `!showPrompt` check silently swallowed every error on a
  // failed "Начать новый стрим" click).
  const bannerIsShowing = showPrompt && promptMode !== "endedNewOnly";

  const confirmAndEnd = () => {
    if (window.confirm("Завершить стрим? OBS переключится на Post Stream, если подключён.")) {
      void onEndStream();
    }
  };

  return (
    <section className="session-bar">
      <div className="session-bar__info">
        <span className="section-heading__eyebrow">Стрим-сессия</span>
        <strong>
          {state === "loading" && "Проверяем состояние…"}
          {state === "unavailable" && "Недоступно"}
          {state === "active" && "Стрим идёт"}
          {state === "ended" && "Стрим завершён"}
        </strong>
        {state === "unavailable" && <p>{error}</p>}
      </div>
      <div className="session-bar__actions">
        {state === "active" && (
          <button className="button button--danger" disabled={busy} onClick={confirmAndEnd}>
            {busy ? "Завершаем…" : "Завершить стрим"}
          </button>
        )}
        {state === "ended" && (
          <button className="button button--primary" disabled={busy} onClick={() => void onStartNew()}>
            {busy ? "Начинаем…" : "Начать новый стрим"}
          </button>
        )}
        {state === "unavailable" && (
          <button className="button" onClick={() => void refresh()}>Обновить</button>
        )}
      </div>
      {error && state !== "unavailable" && !bannerIsShowing && (
        <p className="app__error session-bar__error">Ошибка: {error}</p>
      )}
    </section>
  );
}
