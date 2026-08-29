import { useEffect, useState } from "react";
import type { AccountStatus } from "../types/status";
import * as api from "../services/dotaCompanionApi";

// WK-122 §7 - Diagnostics is only ever allowed to show a STATUS word, never
// the credential itself (opaque token / JWT / refresh token) - this is the
// one place Diagnostics touches the account system at all, and it reuses
// the exact same `get_account_status` command Settings -> Аккаунт uses, not
// a second, diagnostics-only read of the stored secret.
export function DeviceCredentialPanel() {
  const [status, setStatus] = useState<AccountStatus | null>(null);

  useEffect(() => {
    void api
      .getAccountStatus()
      .then(setStatus)
      .catch(() => setStatus({ connected: false, method: "none", email: null }));
  }, []);

  const label = !status
    ? "проверка…"
    : status.connected
      ? "active"
      : "missing";

  return (
    <div className="diagnostic-card">
      <h2>Device credential</h2>
      <p className="obs-panel__status">Device credential: {label}</p>
    </div>
  );
}
