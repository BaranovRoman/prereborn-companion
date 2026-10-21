import { useEffect, useState } from "react";
import type { AccountStatus } from "../core/contracts";
import type { ErrorDescription } from "../utils/errorDescription";
import { describeAuthError } from "../utils/authErrorCopy";
import { Badge, Button, Field, Input, Panel, Tooltip } from "./ui";
import * as api from "../core/api";

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
  const [error, setError] = useState<ErrorDescription | null>(null);

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
      setError(describeAuthError(String(cause)));
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
      setError(describeAuthError(String(cause)));
    } finally {
      setBusy(false);
    }
  };

  const title = compact ? undefined : "Аккаунт PreReborn";
  if (!status) {
    return (
      <Panel className="account-form" title={title}>
        <p className="ui-text-muted">Загрузка…</p>
      </Panel>
    );
  }

  return (
    <Panel
      className="account-form"
      title={title}
      description={mode === "login" ? "Войдите с тем же email и паролем, что и на сайте PreReborn." : undefined}
      aside={status.connected && mode === "view" ? <Badge tone={status.method === "legacy_token" ? "warning" : "success"} dot>{status.method === "legacy_token" ? "Устаревший вход" : "Подключено"}</Badge> : undefined}
    >
      {status.connected && mode === "view" && (
        <div className="account-form__connected">
          <div className="account-form__identity">
            <strong>{status.email ?? "Companion подключён"}</strong>
            <span className="ui-text-muted">
              {status.method === "legacy_token"
                ? "Подключено устаревшим способом — он всё ещё работает."
                : "Companion использует этот аккаунт для интеграций и оверлея."}
            </span>
          </div>
          <div className="ui-button-row">
            <Button variant={status.method === "legacy_token" ? "primary" : "default"} onClick={() => setMode("login")} disabled={busy}>
              {status.method === "legacy_token" ? "Войти через аккаунт" : "Переподключить"}
            </Button>
            <Button variant="danger" onClick={() => void handleLogout()} disabled={busy}>
              Выйти
            </Button>
          </div>
        </div>
      )}

      {mode === "login" && (
        <form className="account-form__login" onSubmit={(event) => { event.preventDefault(); void handleLogin(); }}>
          <Field label="Email">
            <Input
              type="email"
              autoComplete="username"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Пароль">
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="Пароль"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <div className="ui-button-row">
            <Button type="submit" variant="primary" disabled={busy || !email.trim() || !password}>
              Войти
            </Button>
            {status.connected && (
              <Button variant="ghost" onClick={() => setMode("view")} disabled={busy}>
                Отмена
              </Button>
            )}
          </div>
        </form>
      )}

      {error && (
        <p className="ui-notice ui-notice--danger" role="alert">
          <span className="ui-notice__body">
            <strong>{error.title}.</strong> {error.message}
            {error.detail && (
              <Tooltip content={error.detail}>
                <span className="error-detail-trigger" aria-label="Технические детали"> ⓘ</span>
              </Tooltip>
            )}
          </span>
        </p>
      )}
    </Panel>
  );
}
