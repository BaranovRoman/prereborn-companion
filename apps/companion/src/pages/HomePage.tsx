import { CompanionTokenForm } from "../components/CompanionTokenForm";
import { LocalStreamLifecycleCard } from "../components/LocalStreamLifecycleCard";
import { StreamSessionCard } from "../components/StreamSessionCard";
import type { LocalLifecycleState } from "../hooks/useLocalLifecycle";
import type { StreamSessionPromptState } from "../hooks/useStreamSessionPrompt";
import * as api from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";
import type { BackendStatusDescription } from "../utils/backendStatus";

type Scene = "betweenMatches" | "draft" | "gameplay";

const sceneLabels: Record<Scene, string> = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
};

// WK-99 - "Активная сцена" below must display Post Stream too, but it's
// deliberately not one of the manual quick-switch buttons above (those stay
// the 3 GSI-phase scenes, per `sceneLabels`/`Scene` - Post Stream is only
// ever entered automatically once the stream session ends, not something a
// streamer picks by hand mid-match).
const activeSceneLabels: Record<Scene | "postStream", string> = {
  ...sceneLabels,
  postStream: "Post Stream",
};

function StatusCard({ label, value, detail, tone }: {
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warning" | "error";
}) {
  return (
    <article className={`status-card status-card--${tone}`}>
      <div className="status-card__heading"><span className="status-card__dot" />{label}</div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  run: (action: () => Promise<StatusSnapshot | void>) => Promise<void>;
  ready: boolean;
  backendStatus: BackendStatusDescription;
  hasGsiSignal: boolean;
  requestCount: number;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  finishSetup: () => void;
  provisionGsi: () => void;
  checkObs: () => void;
  setAutomaticMode: (enabled: boolean) => void;
  sessionPrompt: StreamSessionPromptState;
  localLifecycle: LocalLifecycleState;
}

// Companion UI 2.0 follow-up - StreamSessionCard now renders unconditionally
// (both branches below), independent of setupOpen/OBS/GSI - see задача
// "Stream controls must not depend on OBS/GSI". Everything else on this
// page (readiness, status grid, OBS scene panel) still only appears once
// the first-run wizard is dismissed/finished, unchanged from before.
export function HomePage({
  status, busy, run, ready, backendStatus, hasGsiSignal, requestCount,
  setupOpen, setSetupOpen, finishSetup, provisionGsi, checkObs, setAutomaticMode, sessionPrompt, localLifecycle,
}: Props) {
  // Companion UI 2.0 follow-up (WK-112) - the manual backend-session card
  // (start/end via the web-cabinet session, WK-83/WK-100) is no longer the
  // primary "is my stream running" control - LocalStreamLifecycleCard above
  // is, driven automatically by OBS. This stays fully functional as a
  // collapsed fallback rather than being removed, per the task's explicit
  // "manual controls stay available, just not front-and-center" instruction.
  const manualSessionFallback = (
    <details className="session-fallback">
      <summary>Ручное управление сессией (резерв)</summary>
      <StreamSessionCard sessionPrompt={sessionPrompt} />
    </details>
  );

  if (setupOpen) {
    return (
      <>
        <LocalStreamLifecycleCard lifecycle={localLifecycle} />
        {manualSessionFallback}
        <section className="setup-guide" aria-labelledby="setup-title">
          <div className="setup-guide__heading">
            <div><span className="section-heading__eyebrow">Первый запуск</span><h2 id="setup-title">Подготовим Companion к стриму</h2><p>Статусы обновляются автоматически и восстановятся после временного сбоя.</p></div>
            <button className="button" onClick={() => setSetupOpen(false)}>Продолжить позже</button>
          </div>
          <ol className="setup-steps">
            <li className={status?.server_running ? "is-complete" : ""}><strong>Companion</strong><span>{status?.server_running ? "Локальный сервис работает" : status?.gsi_state === "recovering" ? "Перезапускает локальный сервис" : "Локальный сервис недоступен"}</span><small>{status?.gsi_last_error ?? "Запускается автоматически"}</small></li>
            <li className={status?.gsi_installed && hasGsiSignal ? "is-complete" : ""}><strong>Dota 2 / GSI</strong><span>{hasGsiSignal ? "Данные поступают" : status?.gsi_installed ? "Конфигурация готова — запустите Dota 2" : "Нужна конфигурация GSI"}</span><button onClick={provisionGsi} disabled={busy}>{status?.gsi_installed ? "Проверить снова" : "Настроить автоматически"}</button></li>
            <li className={backendStatus.ready ? "is-complete" : ""}><strong>Связь с PreReborn</strong><span>{backendStatus.label}</span><CompanionTokenForm status={status} busy={busy} onSave={(token) => run(() => api.saveCompanionToken(token))} /></li>
            <li className={status?.obs_connected ? "is-complete" : ""}><strong>OBS</strong><span>{status?.obs_connected ? "WebSocket и сцены доступны" : status?.obs_state === "recovering" ? "Соединение восстанавливается" : "Настройте OBS WebSocket и сцены"}</span><button onClick={checkObs} disabled={busy || !status}>Проверить OBS</button><small>Маппинг сцен настраивается в разделе «Настройки».</small></li>
          </ol>
          <div className="setup-guide__footer"><p>{ready ? "Все обязательные компоненты готовы." : "Завершение станет доступно, когда все обязательные проверки успешны."}</p><button className="button button--primary" onClick={finishSetup} disabled={!ready}>Завершить настройку</button></div>
        </section>
      </>
    );
  }

  return (
    <>
      <LocalStreamLifecycleCard lifecycle={localLifecycle} />
      {manualSessionFallback}

      <section className={`readiness ${ready ? "readiness--ok" : "readiness--warning"}`}>
        <div>
          <span className="readiness__label">Состояние эфира</span>
          <h2>{ready ? "Всё готово к стриму" : "Проверьте подключения"}</h2>
          <p>{ready ? "Companion получает данные и управляет сценами OBS." : "Один или несколько сервисов требуют внимания."}</p>
        </div>
        <div className="readiness__actions"><button className="button" onClick={() => setSetupOpen(true)}>Проверить настройку</button><button className="button" onClick={() => void run(api.getStatus)} disabled={busy}>Обновить</button></div>
      </section>

      {/* This card's data (`backendStatus`) is a heartbeat to the PreReborn
          backend, not "is Companion running" - the same signal the setup
          wizard above already labels "Связь с PreReborn". It used to be
          labeled "Companion" here, which reads as "is the desktop app
          itself broken" to anyone glancing at Главная - misleading when
          Companion, GSI, and OBS are all actually fine and this card is
          just honestly reporting "Ожидание проверки" before the very first
          backend send has had a chance to complete (see
          utils/backendStatus.ts's WK-94 comment). Renamed to match the
          wizard's own existing wording for the identical data, not invented. */}
      <section className="status-grid" aria-label="Состояние подключений">
        <StatusCard label="Связь с PreReborn" value={backendStatus.label} detail={backendStatus.detail} tone={backendStatus.tone} />
        <StatusCard label="Dota 2 / GSI" value={hasGsiSignal ? "Получает данные" : status?.gsi_state === "recovering" ? "Восстанавливается" : status?.gsi_installed ? "Ожидает Dota 2" : "Не настроен"} detail={hasGsiSignal ? `Получено событий: ${requestCount}` : status?.gsi_last_error ?? (status?.gsi_installed ? "GSI установлен, запустите игру" : "Установите конфигурацию GSI")} tone={hasGsiSignal ? "ok" : status?.gsi_installed || status?.gsi_state === "recovering" ? "warning" : "error"} />
        <StatusCard label="OBS" value={status?.obs_connected ? "Подключён" : status?.obs_state === "recovering" ? "Восстанавливается" : "Нет связи"} detail={status?.obs_connected ? "OBS WebSocket отвечает" : status?.obs_last_error ?? "Проверьте OBS WebSocket"} tone={status?.obs_connected ? "ok" : status?.obs_state === "recovering" ? "warning" : "error"} />
      </section>

      {status?.obs_last_error && <p className="app__error">OBS: {status.obs_last_error}</p>}

      <section className="control-panel">
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
      </section>
    </>
  );
}
