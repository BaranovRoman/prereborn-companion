import { useEffect, useState } from "react";
import type { ObsConfig, StatusSnapshot } from "../types/status";
import * as api from "../services/dotaCompanionApi";

interface Props {
  status: StatusSnapshot | null;
  onStatus: (status: StatusSnapshot) => void;
}

const sceneLabel = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
};

export function ObsScenePanel({ status, onStatus }: Props) {
  const [config, setConfig] = useState<ObsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status && !config) setConfig(status.obs_config);
  }, [status, config]);

  if (!status || !config) return null;
  const patch = (value: Partial<ObsConfig>) => setConfig({ ...config, ...value });

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.saveObsConfig(config);
      onStatus(updated);
      setConfig({ ...updated.obs_config, password: "" });
      setMessage("Настройки сохранены локально.");
    } catch (error) {
      setMessage("Ошибка: " + String(error));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const scenes = await api.testObsConnection();
      onStatus(await api.getStatus());
      setMessage("OBS подключён. Найдено сцен: " + scenes.length + ".");
    } catch (error) {
      setMessage("Ошибка подключения: " + String(error));
    } finally {
      setBusy(false);
    }
  };

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
        <label>
          <span>Между матчами</span>
          <input value={config.between_matches_scene} onChange={(event) => patch({ between_matches_scene: event.target.value })} />
        </label>
        <label>
          <span>Драфт</span>
          <input value={config.draft_scene} onChange={(event) => patch({ draft_scene: event.target.value })} />
        </label>
        <label>
          <span>Игра</span>
          <input value={config.gameplay_scene} onChange={(event) => patch({ gameplay_scene: event.target.value })} />
        </label>
      </div>
      <div className="action-buttons">
        <button disabled={busy} onClick={save}>Сохранить</button>
        <button disabled={busy} onClick={test}>Проверить подключение</button>
      </div>
      <p className="obs-panel__status">
        {status.obs_connected ? "● OBS подключён" : "○ OBS не подключён"}
        {status.obs_active_scene
          ? " · активна: " + sceneLabel[status.obs_active_scene]
          : ""}
      </p>
      {(message || status.obs_last_error) && (
        <p className={status.obs_last_error ? "obs-panel__error" : "obs-panel__message"}>
          {message ?? status.obs_last_error}
        </p>
      )}
    </section>
  );
}
