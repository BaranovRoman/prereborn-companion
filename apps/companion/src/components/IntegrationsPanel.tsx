import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "./ui";
import * as api from "../services/dotaCompanionApi";
import type {
  DonationAlertsIntegrationStatus,
  SteamIntegrationStatus,
  TwitchIntegrationStatus,
} from "../services/dotaCompanionApi";

type Load<T> = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: T };

// WK-133/WK-149 - Settings → Интеграции: the account-level integrations
// Companion has - Steam, Twitch, DonationAlerts - all three connected and
// disconnected from Companion itself (see this task's product direction:
// Companion is the primary account/integration UI, the web cabinet is not
// required for ordinary management). OAuth itself still happens in the
// system browser (existing endpoints, not reimplemented - see WK-149's
// audit) - connect fetches the provider's redirectUrl from the backend and
// opens it via the same opener `open_stream_settings` already used, and the
// existing window-focus refetch below picks up completion when the user
// returns. OBS is deliberately NOT here - see ObsScenePanel, it's local
// runtime config, not an account link.
export function IntegrationsPanel() {
  const [steam, setSteam] = useState<Load<SteamIntegrationStatus>>({ kind: "loading" });
  const [twitch, setTwitch] = useState<Load<TwitchIntegrationStatus>>({ kind: "loading" });
  const [donationAlerts, setDonationAlerts] = useState<Load<DonationAlertsIntegrationStatus>>({ kind: "loading" });

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
  const loadDonationAlerts = useCallback(() => {
    void api
      .getDonationAlertsIntegrationStatus()
      .then((value) => setDonationAlerts({ kind: "ready", value }))
      .catch(() => setDonationAlerts({ kind: "error" }));
  }, []);

  useEffect(() => {
    loadSteam();
    loadTwitch();
    loadDonationAlerts();
  }, [loadSteam, loadTwitch, loadDonationAlerts]);

  // WK-133 §6 - linking happens in the system browser (existing OAuth
  // flow - Companion has no deep-link callback to land back in the app).
  // Refetching on window focus is how this panel picks up a completed
  // link/unlink when the user returns to Companion, without a restart.
  useEffect(() => {
    const onFocus = () => {
      loadSteam();
      loadTwitch();
      loadDonationAlerts();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadSteam, loadTwitch, loadDonationAlerts]);

  return (
    <div className="integrations-panel">
      <h2>Интеграции</h2>

      <ManagedIntegrationRow
        provider="Steam"
        state={steam}
        identity={steam.kind === "ready" && steam.value.connected
          ? steam.value.profile?.displayName ?? `SteamID ${steam.value.steamId64 ?? ""}`
          : null}
        hint="Используется для: идентификации Dota-аккаунта и статистики OpenDota в Hero Detail."
        errorLabel="Не удалось получить статус Steam."
        disconnectWarning="Статистика OpenDota станет недоступна до повторной привязки. Локальная история Companion, GSI, OBS и MMR не затрагиваются."
        onConnect={api.openStreamSettings}
        onDisconnect={api.disconnectSteam}
        onReload={loadSteam}
        connectLabel="Привязать Steam"
        disconnectLabel="Отвязать"
        confirmLabel="Подтвердить отвязку"
        connectHint="Привязка открывает страницу PreReborn в браузере. После подтверждения вернитесь в Companion."
      />

      <ManagedIntegrationRow
        provider="Twitch"
        state={twitch}
        identity={twitch.kind === "ready" && twitch.value.connected
          ? twitch.value.displayName ?? twitch.value.login ?? "Twitch подключён"
          : null}
        hint="Используется для: чата и озвучки сообщений (TTS)."
        errorLabel="Не удалось получить статус Twitch."
        disconnectWarning="Чат и озвучка сообщений (TTS) станут недоступны до повторного подключения."
        onConnect={api.connectTwitch}
        onDisconnect={api.disconnectTwitch}
        onReload={loadTwitch}
      />

      <ManagedIntegrationRow
        provider="DonationAlerts"
        state={donationAlerts}
        identity={donationAlerts.kind === "ready" && donationAlerts.value.connected
          ? donationAlerts.value.displayName ?? "DonationAlerts подключён"
          : null}
        hint="Используется для: панели донатеров в оверлее «Между матчами»."
        errorLabel="Не удалось получить статус DonationAlerts."
        disconnectWarning="Панель донатеров в оверлее «Между матчами» станет недоступна до повторного подключения."
        onConnect={api.connectDonationAlerts}
        onDisconnect={api.disconnectDonationAlerts}
        onReload={loadDonationAlerts}
      />
    </div>
  );
}

// WK-149 - one connect/disconnect row shared by all three providers (was:
// Steam's own inline JSX plus a separate status-only WebManagedIntegrationRow
// for Twitch/DonationAlerts that only ever linked out to the website). Each
// provider keeps its own per-row busy/confirm/error state so one provider's
// action or failure never touches another row (this task's isolation
// requirement) - hence state lives here, not lifted to IntegrationsPanel.
function ManagedIntegrationRow({
  provider,
  state,
  identity,
  hint,
  errorLabel,
  disconnectWarning,
  onConnect,
  onDisconnect,
  onReload,
  connectLabel = "Подключить",
  disconnectLabel = "Отключить",
  confirmLabel = "Подтвердить отключение",
  connectHint,
}: {
  provider: string;
  state: Load<{ connected: boolean }>;
  identity: string | null;
  hint: string;
  errorLabel: string;
  disconnectWarning: string;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onReload: () => void;
  connectLabel?: string;
  disconnectLabel?: string;
  confirmLabel?: string;
  connectHint?: string;
}) {
  const resolvedConnectHint =
    connectHint ??
    `Подключение откроет страницу авторизации ${provider} в браузере. После подтверждения вернитесь в Companion.`;
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true);
    setActionError(null);
    try {
      await onConnect();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setActionError(null);
    try {
      await onDisconnect();
      setConfirmDisconnect(false);
      onReload();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <section className="integrations-panel__row">
      <div className="integrations-panel__row-header">
        <span className="integrations-panel__provider">{provider}</span>
        {state.kind === "ready" && (
          <Badge tone={state.value.connected ? "success" : "default"}>
            {state.value.connected ? "Подключено" : "Не подключено"}
          </Badge>
        )}
      </div>

      {state.kind === "loading" && <p className="matches-panel__empty">Загрузка…</p>}
      {state.kind === "error" && <p className="app__error">{errorLabel}</p>}

      {state.kind === "ready" && state.value.connected && (
        <>
          <p className="integrations-panel__identity">{identity}</p>
          <p className="integrations-panel__hint">{hint}</p>
          <div className="integrations-panel__actions">
            {!confirmDisconnect ? (
              <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                {disconnectLabel}
              </Button>
            ) : (
              <div className="integrations-panel__confirm">
                <p className="integrations-panel__confirm-text">{disconnectWarning}</p>
                <div className="integrations-panel__actions">
                  <Button variant="ghost" onClick={() => setConfirmDisconnect(false)} disabled={disconnecting}>
                    Отмена
                  </Button>
                  <Button variant="danger" onClick={() => void disconnect()} disabled={disconnecting}>
                    {confirmLabel}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {state.kind === "ready" && !state.value.connected && (
        <>
          <p className="integrations-panel__hint">{resolvedConnectHint}</p>
          <div className="integrations-panel__actions">
            <Button variant="primary" onClick={() => void connect()} disabled={connecting}>
              {connectLabel}
            </Button>
          </div>
        </>
      )}

      {actionError && <p className="app__error">Ошибка: {actionError}</p>}
    </section>
  );
}
