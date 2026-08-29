import { useEffect, useState } from "react";
import type { AccountStatus } from "../types/status";
import { Button, Input } from "./ui";
import * as api from "../services/dotaCompanionApi";

// WK-122 §7 - replaces CompanionTokenForm (the opaque copy/paste-from-website
// token) with a real desktop login: the same email/password session (access +
// rotating refresh token) the web cabinet already uses - see
// backend::login's doc comment in src-tauri. The raw token/refresh-token is
// never fetched or displayed here; `AccountStatus` only ever carries
// connected/method/email.
interface Props {
  /** Omits the "Аккаунт" heading - used when embedded inside a labeled
   *  parent (e.g. HomePage's first-run checklist item), not standalone. */
  compact?: boolean;
}

export function AccountForm({ compact = false }: Props) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [mode, setMode] = useState<"view" | "login">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Never left unhandled: outside a real Tauri webview (Storybook-less
    // browser preview, or a genuine backend hiccup) `invoke` rejects - the
    // safe, honest default is simply "not connected yet", the same state a
    // brand new install starts from, not a thrown/unhandled error.
    void api
      .getAccountStatus()
      .then((result) => {
        setStatus(result);
        setMode(result.connected ? "view" : "login");
      })
      .catch(() => {
        setStatus({ connected: false, method: "none", email: null });
        setMode("login");
      });
  }, []);

  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.accountLogin(email.trim(), password);
      setStatus(result);
      setMode("view");
      setPassword("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.accountLogout();
      setStatus(result);
      setMode("login");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <section className="account-form">
        {!compact && <h2>Аккаунт</h2>}
        <p className="matches-panel__empty">Загрузка…</p>
      </section>
    );
  }

  return (
    <section className="account-form">
      {!compact && <h2>Аккаунт</h2>}

      {status.connected && mode === "view" && (
        <div className="account-form__connected">
          <p className="account-form__identity">
            {status.email ?? "Companion подключён"}
          </p>
          <p className="account-form__status">
            {status.method === "legacy_token"
              ? "Подключено (устаревший способ, всё ещё работает)."
              : "Подключено."}
          </p>
          <div className="account-form__actions">
            <Button variant="ghost" onClick={() => setMode("login")} disabled={busy}>
              {status.method === "legacy_token" ? "Войти через аккаунт" : "Переподключить"}
            </Button>
            <Button variant="danger" onClick={() => void handleLogout()} disabled={busy}>
              Выйти
            </Button>
          </div>
        </div>
      )}

      {mode === "login" && (
        <div className="account-form__login">
          <p className="account-form__hint">
            Войдите с тем же email и паролем, что и на сайте PreReborn.
          </p>
          <Input
            type="email"
            autoComplete="username"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Пароль"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleLogin();
            }}
          />
          <div className="account-form__actions">
            {status.connected && (
              <Button variant="ghost" onClick={() => setMode("view")} disabled={busy}>
                Отмена
              </Button>
            )}
            <Button variant="primary" onClick={() => void handleLogin()} disabled={busy || !email.trim() || !password}>
              Войти
            </Button>
          </div>
        </div>
      )}

      {error && <p className="app__error">Ошибка: {error}</p>}
    </section>
  );
}
