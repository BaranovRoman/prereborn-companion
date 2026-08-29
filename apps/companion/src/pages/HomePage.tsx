import { AccountForm } from "../components/AccountForm";
import { LocalStreamLifecycleCard } from "../components/LocalStreamLifecycleCard";
import type { LocalLifecycleState } from "../hooks/useLocalLifecycle";
import * as api from "../services/dotaCompanionApi";
import { getHeroById } from "../services/heroCatalog";
import type { LocalMatchSummary, LocalSessionSummary, StatusSnapshot } from "../types/status";
import type { BackendStatusDescription } from "../utils/backendStatus";

type Scene = "betweenMatches" | "draft" | "gameplay";

const sceneLabels: Record<Scene, string> = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
};

const activeSceneLabels: Record<Scene | "postStream", string> = {
  ...sceneLabels,
  postStream: "Post Stream",
};

const RESULT_LABEL: Record<NonNullable<LocalMatchSummary["result"]>, string> = {
  win: "Победа",
  loss: "Поражение",
  abandon: "Прервано",
};

function matchDelta(match: LocalMatchSummary): string | null {
  if (match.ratingBefore == null || match.ratingAfter == null) return null;
  const delta = match.ratingAfter - match.ratingBefore;
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

// WK-116 - parity audit: match rows used to show a raw "Герой #{id}" -
// Companion already has a hero-sounds catalog with real display names, but
// keyed by the string `npc_dota_hero_<name>` id, not GSI's numeric
// heroId. heroCatalog.ts bridges the two (see its own doc comment) so
// this can resolve a real name/portrait using data that's now genuinely
// local, no backend round trip. Falls back to the old "Герой #{id}" text
// for the (very rare/pre-1.0-catalog-update) case a heroId isn't found.
function MatchRow({ match, current }: { match: LocalMatchSummary; current?: boolean }) {
  const delta = matchDelta(match);
  const hero = getHeroById(match.heroId);
  return (
    <li className={`match-row ${current ? "match-row--current" : ""}`}>
      <span className="match-row__hero">
        {hero && <img className="match-row__hero-icon" src={hero.iconUrl} alt="" loading="lazy" />}
        {hero?.localizedName ?? `Герой #${match.heroId}`}
      </span>
      <span className={`match-row__result match-row__result--${match.result ?? "pending"}`}>
        {current && match.state !== "finalized"
          ? match.state === "post_game_pending" ? "Подтверждаем результат…" : match.state === "interrupted" ? "Матч прерван" : "Матч идёт"
          : match.result ? RESULT_LABEL[match.result] : "—"}
      </span>
      {delta && <span className="match-row__delta">{delta}</span>}
    </li>
  );
}

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  run: (action: () => Promise<StatusSnapshot | void>) => Promise<void>;
  ready: boolean;
  backendStatus: BackendStatusDescription;
  hasGsiSignal: boolean;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  finishSetup: () => void;
  provisionGsi: () => void;
  checkObs: () => void;
  setAutomaticMode: (enabled: boolean) => void;
  localLifecycle: LocalLifecycleState;
  sessionSummary: LocalSessionSummary | null;
}

// WK-114 - Главная rebuilt around the local-first runtime: the local
// session's own MMR/W-L/current+recent matches (see
// hooks/useLocalSessionSummary) are the primary content, not a backend
// session card. Backend/sync state is now only ever shown as a problem bar
// under the header (see AppShell/ProblemBar) - never a permanent status
// card here. Manual/legacy backend-session controls (WK-83/WK-100) moved to
// Диагностика, the new recovery/debug home for that kind of control.
export function HomePage({
  status, busy, run, ready, backendStatus, hasGsiSignal,
  setupOpen, setSetupOpen, finishSetup, provisionGsi, checkObs, setAutomaticMode, localLifecycle, sessionSummary,
}: Props) {
  if (setupOpen) {
    return (
      <>
        <LocalStreamLifecycleCard lifecycle={localLifecycle} />
        <section className="setup-guide" aria-labelledby="setup-title">
          <div className="setup-guide__heading">
            <div><span className="section-heading__eyebrow">Первый запуск</span><h2 id="setup-title">Подготовим Companion к стриму</h2><p>Статусы обновляются автоматически и восстановятся после временного сбоя.</p></div>
            <button className="button" onClick={() => setSetupOpen(false)}>Продолжить позже</button>
          </div>
          <ol className="setup-steps">
            <li className={status?.server_running ? "is-complete" : ""}><strong>Companion</strong><span>{status?.server_running ? "Локальный сервис работает" : status?.gsi_state === "recovering" ? "Перезапускает локальный сервис" : "Локальный сервис недоступен"}</span><small>{status?.gsi_last_error ?? "Запускается автоматически"}</small></li>
            <li className={status?.gsi_installed && hasGsiSignal ? "is-complete" : ""}><strong>Dota 2 / GSI</strong><span>{hasGsiSignal ? "Данные поступают" : status?.gsi_installed ? "Конфигурация готова — запустите Dota 2" : "Нужна конфигурация GSI"}</span><button onClick={provisionGsi} disabled={busy}>{status?.gsi_installed ? "Проверить снова" : "Настроить автоматически"}</button></li>
            <li className={backendStatus.ready ? "is-complete" : ""}><strong>Связь с PreReborn</strong><span>{backendStatus.label}</span><AccountForm compact /></li>
            <li className={status?.obs_connected ? "is-complete" : ""}><strong>OBS</strong><span>{status?.obs_connected ? "WebSocket и сцены доступны" : status?.obs_state === "recovering" ? "Соединение восстанавливается" : "Настройте OBS WebSocket и сцены"}</span><button onClick={checkObs} disabled={busy || !status}>Проверить OBS</button><small>Маппинг сцен настраивается через значок настроек.</small></li>
          </ol>
          <div className="setup-guide__footer"><p>{ready ? "Все обязательные компоненты готовы." : "Завершение станет доступно, когда все обязательные проверки успешны."}</p><button className="button button--primary" onClick={finishSetup} disabled={!ready}>Завершить настройку</button></div>
        </section>
      </>
    );
  }

  const summaryActive = status?.obs_manual_summary_active ?? false;
  const hasSession = sessionSummary?.hasSession ?? false;
  const sessionDelta = hasSession && sessionSummary?.ratingStart != null && sessionSummary?.ratingCurrent != null
    ? sessionSummary.ratingCurrent - sessionSummary.ratingStart
    : null;

  return (
    <>
      <div className="stream-status-row">
        <LocalStreamLifecycleCard lifecycle={localLifecycle} />
        <button className="link-button" onClick={() => setSetupOpen(true)}>Проверить настройку</button>
      </div>

      {/* WK-115 visual-correction audit - `.home-grid`/`.home-grid__columns`
          are pure layout wrappers (no new state, no changed data flow):
          MMR/W-L becomes a full-width "hero" stat readout up top, then
          Матчи сессии (primary - wider column) and Управление эфиром
          (secondary - narrower column) sit side by side on wide windows
          instead of stacking three same-width boxes down a narrow center
          column - see the task's "используй desktop canvas" ask. Narrow
          windows fall back to a single column (App.css media query),
          identical to the previous stacked order. */}
      <div className="home-grid">
        <section className="mmr-panel mmr-panel--hero">
          <div className="mmr-panel__stat">
            <span className="section-heading__eyebrow">Текущий MMR</span>
            <strong>{hasSession && sessionSummary?.ratingCurrent != null ? sessionSummary.ratingCurrent : "—"}</strong>
            {sessionDelta != null && <span className={`mmr-panel__delta ${sessionDelta >= 0 ? "is-positive" : "is-negative"}`}>{sessionDelta >= 0 ? `+${sessionDelta}` : sessionDelta} за сессию</span>}
          </div>
          <div className="mmr-panel__divider" aria-hidden="true" />
          <div className="mmr-panel__stat">
            <span className="section-heading__eyebrow">Победы / Поражения</span>
            <strong>{hasSession ? `${sessionSummary?.wins ?? 0} – ${sessionSummary?.losses ?? 0}` : "—"}</strong>
          </div>
        </section>

        <div className="home-grid__columns">
          <section className="matches-panel home-grid__col-main">
            <div className="section-heading"><div><span className="section-heading__eyebrow">Матчи сессии</span><h2>Текущий и недавние</h2></div></div>
            {!hasSession && <p className="matches-panel__empty">Сессия ещё не началась.</p>}
            {hasSession && !sessionSummary?.currentMatch && sessionSummary?.recentMatches.length === 0 && (
              <p className="matches-panel__empty">Матчи появятся здесь, как только Dota начнёт передавать данные.</p>
            )}
            {hasSession && (sessionSummary?.currentMatch || (sessionSummary?.recentMatches.length ?? 0) > 0) && (
              <ul className="match-list">
                {sessionSummary?.currentMatch && <MatchRow match={sessionSummary.currentMatch} current />}
                {sessionSummary?.recentMatches.map((match, index) => <MatchRow key={`${match.matchId ?? "m"}-${index}`} match={match} />)}
              </ul>
            )}
          </section>

          <section className="control-panel home-grid__col-side">
            <div className="section-heading">
              <div><span className="section-heading__eyebrow">Управление эфиром</span><h2>Сцены OBS</h2></div>
              <span className={`connection-pill ${status?.obs_connected ? "is-online" : ""}`}>{status?.obs_connected ? "На связи" : "Не подключён"}</span>
            </div>
            <div className="mode-switch" role="group" aria-label="Режим переключения сцен">
              <button className={status?.obs_config.enabled ? "is-active" : ""} onClick={() => setAutomaticMode(true)} disabled={busy || !status}>Автоматический</button>
              <button className={!status?.obs_config.enabled ? "is-active" : ""} onClick={() => setAutomaticMode(false)} disabled={busy || !status}>Ручной</button>
            </div>
            <p className="mode-hint">{status?.obs_config.enabled ? "Companion меняет сцену по фазе матча." : "Вы управляете сценой кнопками ниже."}</p>
            <div className="scene-summary"><span>Активная сцена</span><strong>{status?.obs_active_scene ? activeSceneLabels[status.obs_active_scene] : "Не определена"}</strong></div>
            <div className="scene-actions">
              {(Object.keys(sceneLabels) as Scene[]).map((scene) => (
                <button key={scene} className={status?.obs_active_scene === scene ? "is-active" : ""} disabled={busy || !status?.obs_connected} onClick={() => void run(() => api.switchObsScene(scene))}>
                  <span>{sceneLabels[scene]}</span>
                  <small>{scene === "betweenMatches" ? "Лобби и паузы" : scene === "draft" ? "Выбор героев" : "Матч идёт"}</small>
                </button>
              ))}
            </div>
            <div className="poststream-actions">
              {!summaryActive ? (
                <button className="button" disabled={busy || !status?.obs_connected} onClick={() => void run(api.showStreamSummaryScene)}>
                  Итоги стрима
                </button>
              ) : (
                <>
                  <button className="button button--primary" disabled={busy} onClick={() => void run(api.resumeLiveScene)}>
                    Вернуться к трансляции
                  </button>
                  <small>OBS показывает Post Stream. Стрим и сессия продолжаются — это не завершение эфира.</small>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
