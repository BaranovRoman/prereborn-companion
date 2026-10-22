"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DownloadButton } from "@/components/public-site/PublicShell";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { SteamCard } from "./SteamCard";
import { callbackNotice } from "./callback-notice";
import styles from "./account.module.scss";

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

// WK-189 - minimal account page. Stream, OBS, TTS, chat and widget settings
// live in Companion; the site keeps only what Companion still sends users
// here for: the account itself, how Companion connects, the Steam link the
// Dota 2 plugin needs, and signing out.
export const AccountPage = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, user } = useStreamSession();
  const notice = callbackNotice(searchParams);
  // WK-192 - set right before the session is dropped after a deletion, so
  // the guest redirect below doesn't race the navigation to "/".
  const leavingRef = useRef(false);

  useEffect(() => {
    // An OAuth callback started in Companion may land here in a browser that
    // is not signed in to the site - show its result instead of bouncing.
    if (status === "guest" && !notice && !leavingRef.current) router.replace("/stream/login?next=/account");
  }, [status, notice, router]);

  if (status !== "user" || !user) {
    return (
      <div className={styles.page}>
        {notice && <p className={`${styles.notice} ${styles[notice.tone]}`} role="status">{notice.text}</p>}
        {status === "guest" && notice ? (
          <p className={styles.muted}>
            <Link href="/stream/login?next=/account">Войдите</Link>, чтобы открыть личный кабинет.
          </p>
        ) : (
          <p className={styles.muted} role="status">Загрузка…</p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1>Личный кабинет</h1>
        <p>Стрим, чат, озвучка, OBS и плагины настраиваются в самом Companion.</p>
      </header>

      {notice && <p className={`${styles.notice} ${styles[notice.tone]}`} role="status">{notice.text}</p>}

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="account-title">
          <h2 id="account-title">Аккаунт</h2>
          <dl className={styles.facts}>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>ID аккаунта</dt>
            <dd>{user.id}</dd>
            <dt>Зарегистрирован</dt>
            <dd>{formatDate(user.createdAt)}</dd>
          </dl>
          <div className={styles.actions}>
            <SignOutButton />
            {user.isAdmin && <Link className={styles.linkButton} href="/admin">Администрирование</Link>}
          </div>
          <DeleteAccount onDeleted={() => (leavingRef.current = true)} />
        </section>

        <section className={styles.card} aria-labelledby="companion-title">
          <h2 id="companion-title">Подключение Companion</h2>
          <p>
            Companion подключается обычным входом: <b>Настройки → Аккаунт → Войти</b> с этим же email и паролем.
            Копировать токен не нужно.
          </p>
          <div className={styles.actions}>
            <DownloadButton size="small" label="Скачать Companion" />
          </div>
          <LegacyToken createdAt={user.companionTokenConfigured ? user.companionTokenCreatedAt : null} />
        </section>

        <SteamCard />
      </div>
    </div>
  );
};

const SignOutButton = () => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={styles.button}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await streamAuthApi.logout();
        router.replace("/");
      }}
    >
      Выйти из аккаунта
    </button>
  );
};

// The pre-login static Companion token (WK-122 replaced it with email and
// password). Never shown again after creation, so the page only offers to
// revoke one that still exists; issuing a new one would give the current
// Companion nothing to paste it into.
const LegacyToken = ({ createdAt: initialCreatedAt }: { createdAt: string | null }) => {
  const [createdAt, setCreatedAt] = useState(initialCreatedAt);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "revoked" | "error">("idle");

  if (state === "revoked") {
    return <p className={styles.subtle} role="status">Старый токен подключения отозван.</p>;
  }
  if (!createdAt) {
    return <p className={styles.subtle}>Старых токенов подключения нет.</p>;
  }

  const revoke = async () => {
    setState("busy");
    try {
      await streamAuthApi.revokeCompanionToken();
      setCreatedAt(null);
      setState("revoked");
    } catch {
      setState("error");
    }
  };

  return (
    <div className={styles.sub}>
      <h3>Старый токен подключения</h3>
      <p className={styles.subtle}>Создан {formatDate(createdAt)}</p>
      <p>
        Такими токенами подключались версии Companion до входа по паролю. Если вы ими не пользуетесь, токен лучше
        отозвать.
      </p>
      {confirming ? (
        <div className={styles.confirm} role="group" aria-label="Подтверждение отзыва токена">
          <p>Companion, подключённый этим токеном, сразу отключится. Вход по email и паролю продолжит работать.</p>
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.danger}`} onClick={revoke} disabled={state === "busy"}>
              Отозвать
            </button>
            <button type="button" className={styles.button} onClick={() => setConfirming(false)} disabled={state === "busy"}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => setConfirming(true)}>
            Отозвать токен
          </button>
        </div>
      )}
      {state === "error" && <p className={styles.error} role="alert">Не удалось отозвать токен. Попробуйте ещё раз.</p>}
    </div>
  );
};

// WK-192 - self-service deletion (152-ФЗ). Two steps: open the warning, then
// confirm with the password - the server re-checks it before erasing the
// account, its streams, Companion history, integrations and uploaded files.
const DeleteAccount = ({ onDeleted }: { onDeleted: () => void }) => {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "wrong-password" | "error">("idle");

  const cancel = () => {
    setConfirming(false);
    setPassword("");
    setState("idle");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState("busy");
    try {
      await streamAuthApi.deleteAccount(password);
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      setState(status === 403 ? "wrong-password" : "error");
      return;
    }
    onDeleted();
    streamAuthApi.endLocalSession();
    router.replace("/");
  };

  return (
    <div className={styles.sub}>
      <h3>Удаление аккаунта</h3>
      {confirming ? (
        <form className={styles.confirm} onSubmit={submit} aria-label="Подтверждение удаления аккаунта">
          <p>
            <b>Это действие необратимо.</b> Будут удалены аккаунт, история стримов и матчей, данные Companion, привязки
            Steam, Twitch и DonationAlerts и загруженные изображения. Восстановить их будет нельзя.
          </p>
          <label className={styles.field}>
            <span>Пароль от аккаунта</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <div className={styles.actions}>
            <button type="submit" className={`${styles.button} ${styles.danger}`} disabled={state === "busy" || !password}>
              Удалить навсегда
            </button>
            <button type="button" className={styles.button} onClick={cancel} disabled={state === "busy"}>
              Отмена
            </button>
          </div>
          {state === "wrong-password" && <p className={styles.error} role="alert">Неверный пароль.</p>}
          {state === "error" && <p className={styles.error} role="alert">Не удалось удалить аккаунт. Попробуйте позже.</p>}
        </form>
      ) : (
        <>
          <p className={styles.subtle}>Аккаунт и все связанные с ним данные будут удалены без возможности восстановления.</p>
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.danger}`} onClick={() => setConfirming(true)}>
              Удалить аккаунт
            </button>
          </div>
        </>
      )}
    </div>
  );
};
