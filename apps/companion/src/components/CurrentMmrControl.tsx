import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { setCurrentMmr } from "../services/dotaCompanionApi";

interface Props {
  currentMmr: number | null;
  sessionDelta: number | null;
  hasSession: boolean;
}

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

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const rating = Number(draft);
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

  return (
    <div className="mmr-panel__stat mmr-panel__stat--current">
      <span className="section-heading__eyebrow">Текущий MMR</span>
      {!editing ? (
        <>
          <strong>{savedMmr ?? "—"}</strong>
          {savedDelta != null && (
            <span className={`mmr-panel__delta ${savedDelta >= 0 ? "is-positive" : "is-negative"}`}>
              {savedDelta >= 0 ? `+${savedDelta}` : savedDelta} за сессию
            </span>
          )}
          <button
            type="button"
            className="link-button mmr-panel__edit"
            onClick={beginEdit}
            disabled={!hasSession}
            title={hasSession ? undefined : "MMR можно задать после начала локальной сессии"}
          >
            {savedMmr == null ? "Указать MMR" : "Изменить"}
          </button>
          {!hasSession && <small className="mmr-panel__hint">Доступно после начала эфира.</small>}
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
