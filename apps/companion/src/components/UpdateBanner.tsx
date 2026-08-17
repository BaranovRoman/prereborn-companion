import type { UpdaterState } from "../hooks/useUpdater";

interface Props {
  state: UpdaterState;
  onCheck: () => void;
  onInstall: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

// "idle"/"up-to-date" render nothing - the banner only takes up space when
// there's something to check, wait on, or react to.
export function UpdateBanner({ state, onCheck, onInstall, onRestart, onDismiss }: Props) {
  if (state.phase === "idle" || state.phase === "up-to-date") {
    return null;
  }

  if (state.phase === "checking") {
    return (
      <section className="update-banner">
        <span>Проверка обновлений…</span>
      </section>
    );
  }

  if (state.phase === "available") {
    return (
      <section className="update-banner update-banner--available">
        <div>
          <strong>Доступно обновление {state.version}</strong>
          {state.notes && <p className="update-banner__notes">{state.notes}</p>}
        </div>
        <div className="update-banner__actions">
          <button className="button button--primary" onClick={onInstall}>Установить</button>
          <button className="button" onClick={onDismiss}>Позже</button>
        </div>
      </section>
    );
  }

  if (state.phase === "downloading") {
    const percent = state.total ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;
    return (
      <section className="update-banner">
        <span>
          Загрузка {state.version}
          {percent !== null ? ` — ${percent}%` : ` — ${formatBytes(state.downloaded)}`}
        </span>
      </section>
    );
  }

  if (state.phase === "ready") {
    return (
      <section className="update-banner update-banner--available">
        <strong>Обновление {state.version} готово к установке</strong>
        <div className="update-banner__actions">
          <button className="button button--primary" onClick={onRestart}>Перезапустить</button>
        </div>
      </section>
    );
  }

  // state.phase === "error"
  return (
    <section className="update-banner update-banner--error">
      <span>Не удалось обновить Companion: {state.message}</span>
      <div className="update-banner__actions">
        <button className="button" onClick={onCheck}>Повторить</button>
        <button className="button" onClick={onDismiss}>Закрыть</button>
      </div>
    </section>
  );
}
