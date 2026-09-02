import { AccountForm } from "../components/AccountForm";
import { LocalStreamLifecycleCard } from "../components/LocalStreamLifecycleCard";
import { CurrentMmrControl } from "../components/CurrentMmrControl";
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

function formatDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

function matchDelta(match: LocalMatchSummary): string | null {
  if (match.ratingBefore == null || match.ratingAfter == null) return null;
  return formatDelta(match.ratingAfter - match.ratingBefore);
}

// WK-115 - the ×2 button's active state is DERIVED from
// detected/effective delta, never a separate `isDoubleDown` boolean that
// could drift from what the numbers actually say (see the task's "не
// делать ×2 хрупким boolean" requirement): active exactly when the stored
// correction equals the detected delta, i.e. effective = 2 × detected.
function isDoubled(match: LocalMatchSummary): boolean {
  return match.detectedRatingDelta != null && match.detectedRatingDelta !== 0 && match.ratingDeltaCorrection === match.detectedRatingDelta;
}

function effectiveDelta(match: LocalMatchSummary): number | null {
  return match.detectedRatingDelta == null ? null : match.detectedRatingDelta + match.ratingDeltaCorrection;
}

const DELTA_STEP = 25;

// WK-115 - compact, hover-revealed correction controls for one finalized
// match: +/- and ×2 on the effective delta (never touches detected_rating_delta,
// only rating_delta_correction - see local_runtime::store::correct_match_delta),
// plus the Ranked<->Unranked toggle. Deliberately its own component (not
// inline in MatchRow) so it can stay entirely absent from the DOM for the
// in-progress match and for legacy matches with nothing to correct.
function MatchCorrectionControls({
  match,
  onCorrectDelta,
  onCorrectRanked,
}: {
  match: LocalMatchSummary;
  onCorrectDelta: (localId: string, effectiveDelta: number | null) => void;
  onCorrectRanked: (localId: string, ranked: boolean | null) => void;
}) {
  const detected = match.detectedRatingDelta;
  const current = effectiveDelta(match);
  const canCorrectDelta = match.rankedMode === "ranked" && detected != null;
  const unranked = match.rankedMode === "unranked";
  const correctedAway = match.rankedMode !== match.rankedModeDetected;
  const rankedToggleLabel = unranked ? (correctedAway ? "Вернуть в Ranked" : "Отметить Ranked") : "Отметить Unranked";
  const rankedToggleTarget = unranked ? (correctedAway ? null : true) : false;

  return (
    <span className="match-row__actions">
      {canCorrectDelta && detected != null && (
        <span className="match-row__delta-controls">
          <button type="button" className="match-row__step" aria-label="Уменьшить дельту на 25" onClick={() => onCorrectDelta(match.localId, (current ?? 0) - DELTA_STEP)}>−</button>
          <button
            type="button"
            className={`match-row__x2 ${isDoubled(match) ? "is-active" : ""}`}
            aria-pressed={isDoubled(match)}
            title="×2: удвоить эффективную дельту этого матча"
            onClick={() => onCorrectDelta(match.localId, isDoubled(match) ? detected : detected * 2)}
          >
            ×2
          </button>
          <button type="button" className="match-row__step" aria-label="Увеличить дельту на 25" onClick={() => onCorrectDelta(match.localId, (current ?? 0) + DELTA_STEP)}>+</button>
        </span>
      )}
      <button type="button" className="match-row__ranked-toggle" onClick={() => onCorrectRanked(match.localId, rankedToggleTarget)}>
        {rankedToggleLabel}
      </button>
    </span>
  );
}

// WK-116 - parity audit: match rows used to show a raw "Герой #{id}" -
// Companion already has a hero-sounds catalog with real display names, but
// keyed by the string `npc_dota_hero_<name>` id, not GSI's numeric
// heroId. heroCatalog.ts bridges the two (see its own doc comment) so
// this can resolve a real name/portrait using data that's now genuinely
// local, no backend round trip. Falls back to the old "Герой #{id}" text
// for the (very rare/pre-1.0-catalog-update) case a heroId isn't found.
//
// WK-115 - now also shows K/D/A (when observed) and the match's rating-
// after alongside its effective delta, and - for a finalized match only -
// a hover-revealed correction toolbar (MatchCorrectionControls). An
// Unranked match (whether detected that way or corrected to it) shows no
// rating delta at all, matching the "absent, not zero" requirement.
function MatchRow({
  match,
  current,
  onCorrectDelta,
  onCorrectRanked,
}: {
  match: LocalMatchSummary;
  current?: boolean;
  onCorrectDelta?: (localId: string, effectiveDelta: number | null) => void;
  onCorrectRanked?: (localId: string, ranked: boolean | null) => void;
}) {
  const delta = matchDelta(match);
  const hero = getHeroById(match.heroId);
  const hasKda = match.kills != null && match.deaths != null && match.assists != null;
  const correctable = match.state === "finalized" && onCorrectDelta && onCorrectRanked;
  return (
    <li className={`match-row ${current ? "match-row--current" : ""}`}>
      <span className="match-row__hero">
        {hero && <img className="match-row__hero-icon" src={hero.iconUrl} alt="" loading="lazy" />}
        {hero?.localizedName ?? `Герой #${match.heroId}`}
      </span>
      {hasKda && <span className="match-row__kda">{match.kills} / {match.deaths} / {match.assists}</span>}
      <span className={`match-row__result match-row__result--${match.result ?? "pending"}`}>
        {current && match.state !== "finalized"
          ? match.state === "post_game_pending" ? "Подтверждаем результат…" : match.state === "interrupted" ? "Матч прерван" : "Матч идёт"
          : match.result ? RESULT_LABEL[match.result] : "—"}
      </span>
      {match.state === "finalized" && match.rankedMode === "unranked" && <span className="match-row__unranked-tag">Unranked</span>}
      {delta && match.rankedMode === "ranked" && <span className="match-row__delta">{delta}</span>}
      {match.rankedMode === "ranked" && match.ratingAfter != null && <span className="match-row__rating-after">{match.ratingAfter}</span>}
      {correctable && <MatchCorrectionControls match={match} onCorrectDelta={onCorrectDelta} onCorrectRanked={onCorrectRanked} />}
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
  refreshSessionSummary: () => Promise<void>;
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
  refreshSessionSummary,
}: Props) {
  // WK-115 - fire-and-forget correction handlers: these are quick, frequent
  // inline dashboard actions (+/-, ×2, Ranked/Unranked toggle), not the
  // page's `run()`-gated OBS/scene actions, so they don't take the whole
  // page's shared `busy` lock. Each just re-reads the local session summary
  // immediately afterward instead of waiting for the next 3s poll tick -
  // every projection (current MMR, session delta, W/L, match list) comes
  // from that one summary, so a single refresh keeps them all in sync.
  const correctDelta = (localId: string, effectiveDelta: number | null) => {
    void api.correctLocalMatchDelta(localId, effectiveDelta)
      .then(() => refreshSessionSummary())
      .catch((cause) => console.warn("correctLocalMatchDelta failed", cause));
  };
  const correctRanked = (localId: string, ranked: boolean | null) => {
    void api.correctLocalMatchRankedMode(localId, ranked)
      .then(() => refreshSessionSummary())
      .catch((cause) => console.warn("correctLocalMatchRankedMode failed", cause));
  };

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
  // WK-124 - defaults to `true` when status hasn't loaded yet, matching the
  // real AppState default (a fresh Companion process is always ON) so the
  // control never flashes an "OFF" state before the first status fetch.
  const overlayVisible = status?.overlay_visible ?? true;
  const hasSession = sessionSummary?.hasSession ?? false;
  const hasRecentMatches = (sessionSummary?.recentMatches.length ?? 0) > 0;
  const sessionDelta = hasSession ? sessionSummary?.sessionDelta ?? null : null;

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
          <CurrentMmrControl
            currentMmr={sessionSummary?.ratingCurrent ?? null}
            sessionDelta={sessionDelta}
            hasSession={hasSession}
          />
          <div className="mmr-panel__divider" aria-hidden="true" />
          <div className="mmr-panel__stat">
            <span className="section-heading__eyebrow">Победы / Поражения</span>
            <strong>{hasSession ? `${sessionSummary?.wins ?? 0} – ${sessionSummary?.losses ?? 0}` : "—"}</strong>
          </div>
        </section>

        <div className="home-grid__columns">
          <section className="matches-panel home-grid__col-main">
            <div className="section-heading"><div><span className="section-heading__eyebrow">Матчи сессии</span><h2>Текущий и недавние</h2></div></div>
            {!hasSession && !hasRecentMatches && <p className="matches-panel__empty">Сессия ещё не началась.</p>}
            {hasSession && !sessionSummary?.currentMatch && !hasRecentMatches && (
              <p className="matches-panel__empty">Матчи появятся здесь, как только Dota начнёт передавать данные.</p>
            )}
            {(sessionSummary?.currentMatch || hasRecentMatches) && (
              <ul className="match-list">
                {sessionSummary?.currentMatch && <MatchRow match={sessionSummary.currentMatch} current />}
                {sessionSummary?.recentMatches.map((match, index) => (
                  <MatchRow
                    key={`${match.matchId ?? "m"}-${index}`}
                    match={match}
                    onCorrectDelta={correctDelta}
                    onCorrectRanked={correctRanked}
                  />
                ))}
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
            {/* WK-124 - global runtime visibility override for the local
                overlay renderer (Browser Source at 127.0.0.1:3666/overlay).
                Purely a rendering toggle: GSI, LocalSession, match
                detection/finalization, MMR, OBS scene automation, Twitch/
                chat, TTS/Game Sounds, sync and the local HTTP/SSE server all
                keep running unaffected - see toggle_overlay_visible's doc
                comment. Mirrors poststream-actions' own swap-button
                pattern immediately above, deliberately not a big SaaS-style
                pill switch, so OFF reads as an intentional streamer action,
                not an error state. */}
            <div className="overlay-visibility-actions">
              {overlayVisible ? (
                <button className="button" disabled={busy} onClick={() => void run(api.toggleOverlayVisible)}>
                  Скрыть оверлей
                </button>
              ) : (
                <>
                  <button className="button button--primary" disabled={busy} onClick={() => void run(api.toggleOverlayVisible)}>
                    Показать оверлей
                  </button>
                  <small>PreReborn Overlay скрыт в OBS Browser Source. Всё остальное — GSI, сессия, MMR, OBS — продолжает работать как обычно.</small>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
