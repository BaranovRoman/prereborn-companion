import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "./ui";
import * as api from "../services/dotaCompanionApi";
import type { SteamIntegrationStatus, TwitchIntegrationStatus } from "../services/dotaCompanionApi";

type Load<T> = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: T };

// WK-133 - Settings → Интеграции: the account-level integrations Companion
// actually has (see this task's audit) - Steam (linked via the existing web
// OAuth flow, unlinked directly from here through the existing DELETE
// endpoint) and Twitch (status only - already OAuth-linked on the web, no
// second auth implementation here, "Управлять на сайте" reuses the same
// hand-off Chat's reconnect button already uses). OBS is deliberately NOT
// here - see ObsScenePanel, it's local runtime config, not an account link.
export function IntegrationsPanel() {
  const [steam, setSteam] = useState<Load<SteamIntegrationStatus>>({ kind: "loading" });
  const [twitch, setTwitch] = useState<Load<TwitchIntegrationStatus>>({ kind: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSteam = useCallback(() => {
    void api
      .getSteamIntegrationStatus()
      .then((value) => setSteam({ kind: "ready", value }))
      .catch(() => setSteam({ kind: "error" }));
  }, []);
  const loadTwitch = useCallback(() => {
    void api
      .getTwitchIntegrationStatus()
      .then((value) => setTwitch({ kind: "ready", value }))
      .catch(() => setTwitch({ kind: "error" }));
  }, []);

  useEffect(() => {
    loadSteam();
    loadTwitch();
  }, [loadSteam, loadTwitch]);

  // WK-133 §6 - Steam linking happens in the system browser (existing OpenID
  // redirect flow - Companion has no deep-link callback to land back in the
  // app, see this task's audit). Refetching on window focus is how this
  // panel picks up a completed link when the user returns to Companion,
  // without requiring a restart.
  useEffect(() => {
    const onFocus = () => {
      loadSteam();
      loadTwitch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadSteam, loadTwitch]);

  const connectSteam = async () => {
    setConnecting(true);
    setActionError(null);
    try {
      await api.openStreamSettings();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const unlinkSteam = async () => {
    setUnlinking(true);
    setActionError(null);
    try {
      await api.disconnectSteam();
      setConfirmUnlink(false);
      loadSteam();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <div className="integrations-panel">
      <h2>Интеграции</h2>

      <section className="integrations-panel__row">
        <div className="integrations-panel__row-header">
          <span className="integrations-panel__provider">Steam</span>
          {steam.kind === "ready" && (
            <Badge tone={steam.value.connected ? "success" : "default"}>
              {steam.value.connected ? "Подключено" : "Не подключено"}
            </Badge>
          )}
        </div>

        {steam.kind === "loading" && <p className="matches-panel__empty">Загрузка…</p>}
        {steam.kind === "error" && <p className="app__error">Не удалось получить статус Steam.</p>}

        {steam.kind === "ready" && steam.value.connected && (
          <>
            <p className="integrations-panel__identity">
              {steam.value.profile?.displayName ?? `SteamID ${steam.value.steamId64 ?? ""}`}
            </p>
            <p className="integrations-panel__hint">
              Используется для: идентификации Dota-аккаунта и статистики OpenDota в Hero Detail.
            </p>
            <div className="integrations-panel__actions">
              {!confirmUnlink ? (
                <Button variant="ghost" onClick={() => setConfirmUnlink(true)}>
                  Отвязать
                </Button>
              ) : (
                <div className="integrations-panel__confirm">
                  <p className="integrations-panel__confirm-text">
                    Статистика OpenDota станет недоступна до повторной привязки. Локальная история
                    Companion, GSI, OBS и MMR не затрагиваются.
                  </p>
                  <div className="integrations-panel__actions">
                    <Button variant="ghost" onClick={() => setConfirmUnlink(false)} disabled={unlinking}>
                      Отмена
                    </Button>
                    <Button variant="danger" onClick={() => void unlinkSteam()} disabled={unlinking}>
                      Подтвердить отвязку
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {steam.kind === "ready" && !steam.value.connected && (
          <>
            <p className="integrations-panel__hint">
              Привязка открывает страницу PreReborn в браузере. После подтверждения вернитесь в
              Companion.
            </p>
            <div className="integrations-panel__actions">
              <Button variant="primary" onClick={() => void connectSteam()} disabled={connecting}>
                Привязать Steam
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="integrations-panel__row">
        <div className="integrations-panel__row-header">
          <span className="integrations-panel__provider">Twitch</span>
          {twitch.kind === "ready" && (
            <Badge tone={twitch.value.connected ? "success" : "default"}>
              {twitch.value.connected ? "Подключено" : "Не подключено"}
            </Badge>
          )}
        </div>

        {twitch.kind === "loading" && <p className="matches-panel__empty">Загрузка…</p>}
        {twitch.kind === "error" && <p className="app__error">Не удалось получить статус Twitch.</p>}

        {twitch.kind === "ready" && (
          <>
            <p className="integrations-panel__identity">
              {twitch.value.connected
                ? twitch.value.displayName ?? twitch.value.login ?? "Twitch подключён"
                : "Не подключено"}
            </p>
            <p className="integrations-panel__hint">Используется для: чата и озвучки сообщений (TTS).</p>
            <div className="integrations-panel__actions">
              <Button variant="ghost" onClick={() => void api.openStreamSettings()}>
                Управлять на сайте
              </Button>
            </div>
          </>
        )}
      </section>

      {actionError && <p className="app__error">Ошибка: {actionError}</p>}
    </div>
  );
}
