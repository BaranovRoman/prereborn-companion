import { useState } from "react";
import { Badge, Button } from "./ui";
import { detectObsBrowserSource, migrateObsBrowserSource, type BrowserSourceDetection } from "../services/dotaCompanionApi";

type Phase = { kind: "idle" } | { kind: "checking" } | { kind: "result"; result: BrowserSourceDetection } | { kind: "error"; message: string };

// WK-126 - mirrors obs.rs's LOCAL_OVERLAY_URL constant verbatim. "missing"/
// "ambiguous" used to tell the user to add or pick a Browser Source
// manually without ever showing them the URL to actually use - the one gap
// this panel had for a fresh setup (detectObsBrowserSource can only find/
// migrate an EXISTING input, never create one from scratch).
const LOCAL_OVERLAY_URL = "http://127.0.0.1:3666/overlay";

// WK-121 §13 - OBS Browser Source migration. Manual, explicit action (never
// automatic): the user clicks "Проверить", sees exactly one of the four
// states the task asks for, and - only when a single unambiguous legacy
// candidate is found - can migrate just that one input's URL. Never touches
// webcam/game-capture/alerts/any other source (obs.rs's
// migrate_browser_source is scoped to SetInputSettings on the one named
// input, see its doc comment).
export function BrowserSourceMigrationPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [migrating, setMigrating] = useState(false);

  const check = async () => {
    setPhase({ kind: "checking" });
    try {
      setPhase({ kind: "result", result: await detectObsBrowserSource() });
    } catch (cause) {
      setPhase({ kind: "error", message: String(cause) });
    }
  };

  const migrate = async (inputName: string) => {
    setMigrating(true);
    try {
      await migrateObsBrowserSource(inputName);
      setPhase({ kind: "result", result: await detectObsBrowserSource() });
    } catch (cause) {
      setPhase({ kind: "error", message: String(cause) });
    } finally {
      setMigrating(false);
    }
  };

  return (
    <section className="browser-source-migration">
      <h3>OBS Browser Source</h3>
      <p className="obs-panel__hint">
        Переводит существующий PreReborn Browser Source с prereborn.ru на локальный оверлей
        (127.0.0.1:3666/overlay). Другие источники (вебкамера, захват игры, алерты) не затрагиваются.
      </p>

      <Button onClick={() => void check()} disabled={phase.kind === "checking"}>
        {phase.kind === "checking" ? "Проверяем…" : "Проверить"}
      </Button>

      {phase.kind === "error" && <p className="app__error">Ошибка: {phase.message}</p>}

      {phase.kind === "result" && (
        <div className="browser-source-migration__result">
          {phase.result.state === "localConnected" && (
            <Badge tone="success" dot>Локальный оверлей подключён ({phase.result.inputName})</Badge>
          )}
          {phase.result.state === "legacyDetected" && (() => {
            const legacy = phase.result;
            return (
              <div className="browser-source-migration__legacy">
                <Badge tone="warning" dot>Найден старый оверлей: {legacy.inputName}</Badge>
                <p className="obs-panel__hint">Текущий URL: {legacy.currentUrl}</p>
                <Button variant="primary" onClick={() => void migrate(legacy.inputName)} disabled={migrating}>
                  {migrating ? "Переводим…" : "Перевести на localhost"}
                </Button>
              </div>
            );
          })()}
          {phase.result.state === "missing" && (
            <div>
              <Badge tone="danger" dot>PreReborn Browser Source не найден — добавьте его в OBS вручную</Badge>
              <p className="obs-panel__hint">
                URL для нового Browser Source: <code>{LOCAL_OVERLAY_URL}</code>
              </p>
            </div>
          )}
          {phase.result.state === "ambiguous" && (
            <div>
              <Badge tone="warning" dot>Найдено несколько похожих источников — выберите вручную</Badge>
              <p className="obs-panel__hint">
                URL для локального оверлея: <code>{LOCAL_OVERLAY_URL}</code>
              </p>
              <ul>
                {phase.result.candidates.map((name) => <li key={name}>{name}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
