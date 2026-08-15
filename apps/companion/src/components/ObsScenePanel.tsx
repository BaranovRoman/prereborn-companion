import { useEffect, useState } from "react";
import type { ObsConfig, StatusSnapshot } from "../types/status";
import * as api from "../services/dotaCompanionApi";
import { missingMappedScenes, sceneMappings, sceneOptions } from "./obsSceneMapping";

interface Props {
  status: StatusSnapshot | null;
  onStatus: (status: StatusSnapshot) => void;
}

const sceneLabel = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
};

const mappingKey = {
  betweenMatches: "between_matches_scene",
  draft: "draft_scene",
  gameplay: "gameplay_scene",
} as const;

export function ObsScenePanel({ status, onStatus }: Props) {
  const [config, setConfig] = useState<ObsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scenes, setScenes] = useState<string[] | null>(null);

  useEffect(() => {
    if (status && !config) setConfig(status.obs_config);
  }, [status, config]);

  if (!status || !config) return null;
  const patch = (value: Partial<ObsConfig>) => setConfig({ ...config, ...value });
  const missingScenes = missingMappedScenes(config, scenes);
  const hasEmptyMapping = sceneMappings.some(({ key }) => !config[key].trim());

  const save = async () => {
    if (hasEmptyMapping) {
      setMessage("Ошибка: выберите OBS scene для каждого состояния.");
      return;
    }
    if (missingScenes.length > 0) {
      setMessage("Ошибка: выберите существующую OBS scene вместо отсутствующей.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.saveObsConfig(config);
      onStatus(updated);
      setConfig({ ...updated.obs_config, password: "" });
      const unavailable = !updated.obs_connected;
      if (unavailable) setScenes(null);
      setMessage(
        unavailable
          ? "Настройки сохранены локально. OBS сейчас недоступен, список сцен не проверен."
          : "Настройки сохранены локально."
      );
    } catch (error) {
      setMessage("Ошибка: " + String(error));
    } finally {
      setBusy(false);
    }
  };

  const refreshScenes = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const availableScenes = await api.testObsConnection();
      setScenes(availableScenes);
      onStatus(await api.getStatus());
      setMessage("OBS подключён. Найдено сцен: " + availableScenes.length + ".");
    } catch (error) {
      setScenes(null);
      setMessage("OBS сейчас недоступен, сохранённые значения не изменены: " + String(error));
    } finally {
      setBusy(false);
    }
  };

  const activeMapping = status.obs_active_scene
    ? config[mappingKey[status.obs_active_scene]]
    : null;

  return (
    <section className="obs-panel">
      <h2>Сцены OBS</h2>
      <p className="obs-panel__hint">
        Companion переключает Program Scene по фазе Dota. Пароль хранится только
        на этом компьютере.
      </p>
      <label className="obs-panel__toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        Автоматически переключать сцены
      </label>
      <div className="obs-panel__connection">
        <label>
          <span>Адрес</span>
          <input value={config.host} onChange={(event) => patch({ host: event.target.value })} />
        </label>
        <label>
          <span>Порт</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={config.port}
            onChange={(event) => patch({ port: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Пароль</span>
          <input
            type="password"
            value={config.password}
            placeholder="Не изменять"
            onChange={(event) => patch({ password: event.target.value })}
          />
        </label>
      </div>
      <div className="obs-panel__mapping">
        {sceneMappings.map(({ key, label }) => {
          const missing = scenes !== null && !!config[key] && !scenes.includes(config[key]);
          return (
            <label key={key} className={missing ? "is-invalid" : undefined}>
              <span>{label}</span>
              <select value={config[key]} onChange={(event) => patch({ [key]: event.target.value })}>
                {!config[key] && <option value="">Выберите сцену</option>}
                {sceneOptions(config[key], scenes).map((scene) => (
                  <option key={scene} value={scene}>
                    {missing && scene === config[key] ? scene + " — не найдена" : scene}
                  </option>
                ))}
              </select>
              {missing && <small>Scene удалена или переименована в OBS.</small>}
            </label>
          );
        })}
      </div>
      <div className="action-buttons">
        <button disabled={busy || hasEmptyMapping || missingScenes.length > 0} onClick={save}>Сохранить</button>
        <button disabled={busy} onClick={refreshScenes}>Обновить список сцен</button>
      </div>
      <p className="obs-panel__status">
        {status.obs_connected ? "● OBS подключён" : "○ OBS не подключён"}
        {status.obs_active_scene
          ? " · состояние: " + sceneLabel[status.obs_active_scene] + " · mapped scene: " + activeMapping
          : ""}
        {" · режим: " + (config.enabled ? "Automatic" : "Manual")}
      </p>
      {(message || status.obs_last_error) && (
        <p className={status.obs_last_error ? "obs-panel__error" : "obs-panel__message"}>
          {message ?? status.obs_last_error}
        </p>
      )}
    </section>
  );
}
