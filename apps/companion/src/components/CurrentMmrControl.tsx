import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { setCurrentMmr } from "../services/dotaCompanionApi";

interface Props {
  currentMmr: number | null;
  sessionDelta: number | null;
  hasSession: boolean;
}

const STEP = 25;

export function CurrentMmrControl({ currentMmr, sessionDelta, hasSession }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentMmr?.toString() ?? "");
  const [savedMmr, setSavedMmr] = useState(currentMmr);
  const [savedDelta, setSavedDelta] = useState(sessionDelta);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSavedMmr(currentMmr);
    setSavedDelta(sessionDelta);
  }, [currentMmr, sessionDelta]);

  useEffect(() => {
    if (!editing) setDraft(savedMmr?.toString() ?? "");
  }, [editing, savedMmr]);

  const beginEdit = () => {
    setDraft(savedMmr?.toString() ?? "");
    setError(null);
    setEditing(true);
  };

  const commit = async (rating: number) => {
    if (!Number.isInteger(rating) || rating < 0 || rating > 30_000) {
      setError("Введите целое число от 0 до 30000.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const summary = await setCurrentMmr(rating);
      setSavedMmr(summary.ratingCurrent);
      setSavedDelta(summary.sessionDelta);
      setDraft(summary.ratingCurrent?.toString() ?? "");
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить MMR.");
    } finally {
      setSaving(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void commit(Number(draft));
  };

  const nudge = (direction: 1 | -1) => {
    void commit((savedMmr ?? 0) + direction * STEP);
  };

  return (
    <div className="mmr-panel__stat mmr-panel__stat--current">
      <span className="section-heading__eyebrow">Текущий MMR</span>
      {!editing ? (
        <>
          <div className="mmr-panel__stepper">
            <button
              type="button"
              className="mmr-panel__step"
              aria-label="Уменьшить MMR на 25"
              disabled={saving || savedMmr == null}
              onClick={() => nudge(-1)}
            >
              −
            </button>
            <strong>{savedMmr ?? "—"}</strong>
            <button
              type="button"
              className="mmr-panel__step"
              aria-label="Увеличить MMR на 25"
              disabled={saving || savedMmr == null}
              onClick={() => nudge(1)}
            >
              +
            </button>
          </div>
          {savedDelta != null && (
            <span className={`mmr-panel__delta ${savedDelta >= 0 ? "is-positive" : "is-negative"}`}>
              {savedDelta >= 0 ? `+${savedDelta}` : savedDelta} за сессию
            </span>
          )}
          <button
            type="button"
            className="link-button mmr-panel__edit"
            onClick={beginEdit}
          >
            {savedMmr == null ? "Указать MMR" : "Изменить"}
          </button>
          {!hasSession && <small className="mmr-panel__hint">Будет стартовым MMR следующей сессии.</small>}
          {error && <span className="mmr-panel__error" role="alert">{error}</span>}
        </>
      ) : (
        <form className="mmr-panel__form" onSubmit={(event) => void save(event)}>
          <label>
            <span className="sr-only">Текущий MMR</span>
            <input
              aria-label="Текущий MMR"
              type="number"
              min="0"
              max="30000"
              step="1"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
            />
          </label>
          <div className="mmr-panel__form-actions">
            <button type="submit" className="button button--primary" disabled={saving}>Сохранить</button>
            <button type="button" className="button" disabled={saving} onClick={() => setEditing(false)}>Отмена</button>
          </div>
          <small className="mmr-panel__hint">Коррекция не изменяет историю матчей.</small>
          {error && <span className="mmr-panel__error" role="alert">{error}</span>}
        </form>
      )}
    </div>
  );
}
