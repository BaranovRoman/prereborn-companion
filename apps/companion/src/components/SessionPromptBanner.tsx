import type { SessionPromptMode, StreamSessionSummary } from "../session/session-prompt";

interface Props {
  show: boolean;
  mode: SessionPromptMode;
  session: StreamSessionSummary | null;
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  onStartNew: () => void;
}

function formatLastActivity(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / dayMs);

  if (diffDays === 0) return `сегодня, ${time}`;
  if (diffDays === 1) return `вчера, ${time}`;
  return `${date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}, ${time}`;
}

function formatDelta(delta: number | null): string | null {
  if (delta === null) return null;
  if (delta === 0) return "±0 MMR";
  return delta > 0 ? `+${delta} MMR` : `${delta} MMR`;
}

// Non-blocking startup banner (not a modal, not a native dialog) - renders
// nothing unless there's an old session worth asking about. See
// useStreamSessionPrompt for the show/hide decision.
export function SessionPromptBanner({ show, mode, session, busy, error, onContinue, onStartNew }: Props) {
  if (!show || !session) return null;

  const matches = session.wins + session.losses;
  const delta = formatDelta(session.sessionRatingDelta);
  // WK-53 - an explicitly ended session is never "continuable": no
  // "Продолжить" button, no staleness-framed copy, regardless of how
  // recently End happened.
  const ended = mode === "endedNewOnly";

  return (
    <section className="session-prompt-banner">
      <div>
        <strong>{ended ? "Стрим завершён" : "Продолжить прошлый стрим?"}</strong>
        <p className="session-prompt-banner__stats">
          {ended
            ? `Завершён: ${formatLastActivity(session.endedAt ?? session.updatedAt)}.`
            : `Последняя активность: ${formatLastActivity(session.updatedAt)}.`}{" "}
          {matches} {matches === 1 ? "матч" : "матчей"} · {session.wins}–{session.losses}
          {delta ? ` · ${delta}` : ""}
        </p>
        {ended && (
          <p className="session-prompt-banner__stats">Начните новый, чтобы продолжить.</p>
        )}
        {error && <p className="session-prompt-banner__error">{error}</p>}
      </div>
      <div className="session-prompt-banner__actions">
        <button
          className={ended ? "button button--primary" : "button"}
          onClick={onStartNew}
          disabled={busy}
        >
          {busy ? "Начинаем…" : "Начать новый стрим"}
        </button>
        {!ended && (
          <button className="button button--primary" onClick={onContinue} disabled={busy}>
            Продолжить
          </button>
        )}
      </div>
    </section>
  );
}
