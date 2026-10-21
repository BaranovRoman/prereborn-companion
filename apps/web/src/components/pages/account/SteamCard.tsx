"use client";

import { useEffect, useState } from "react";
import { steamIntegrationApi } from "@/entities/steam-integration/api/steam-integration";
import type { SteamIntegrationStatus } from "@/entities/steam-integration/model/types";
import styles from "./account.module.scss";

type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; status: SteamIntegrationStatus };

// WK-189 - kept on the site on purpose: Companion's "Привязать Steam" opens
// this page (Steam OpenID returns to the site), and the Dota 2 plugin's
// profile and hero widgets read the linked account. No Dota sync here.
export const SteamCard = () => {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    steamIntegrationApi
      .getStatus()
      .then((status) => !cancelled && setLoad({ kind: "ready", status }))
      .catch(() => !cancelled && setLoad({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const connect = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await steamIntegrationApi.connect();
    } catch {
      setActionError("Не удалось начать привязку Steam.");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await steamIntegrationApi.disconnect();
      setConfirming(false);
      setReload((n) => n + 1);
    } catch {
      setActionError("Не удалось отвязать Steam.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="steam-title">
      <h2 id="steam-title">Steam для плагина Dota 2</h2>
      <p>Нужен для статистики профиля и героев в виджетах Dota 2. Привязку открывает Companion, подтверждается она здесь.</p>

      {load.kind === "loading" && <p className={styles.subtle} role="status">Проверяем привязку…</p>}
      {load.kind === "error" && <p className={styles.error} role="alert">Не удалось получить статус Steam.</p>}

      {load.kind === "ready" && !load.status.connected && (
        <>
          <p className={styles.state}>Steam не привязан</p>
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.primary}`} onClick={connect} disabled={busy}>
              Привязать Steam
            </button>
          </div>
        </>
      )}

      {load.kind === "ready" && load.status.connected && (
        <>
          <p className={styles.state}>
            <span className={styles.ok}>Привязан</span>{" "}
            {load.status.profile?.displayName ?? `SteamID ${load.status.steamId64 ?? ""}`}
          </p>
          {confirming ? (
            <div className={styles.confirm} role="group" aria-label="Подтверждение отвязки Steam">
              <p>Виджеты Dota 2, которым нужен Steam, перестанут обновляться до повторной привязки.</p>
              <div className={styles.actions}>
                <button type="button" className={`${styles.button} ${styles.danger}`} onClick={disconnect} disabled={busy}>
                  Отвязать
                </button>
                <button type="button" className={styles.button} onClick={() => setConfirming(false)} disabled={busy}>
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <button type="button" className={styles.button} onClick={() => setConfirming(true)}>
                Отвязать Steam
              </button>
            </div>
          )}
        </>
      )}

      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
    </section>
  );
};
