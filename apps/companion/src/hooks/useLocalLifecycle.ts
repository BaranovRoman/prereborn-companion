import { useCallback, useEffect, useRef, useState } from "react";
import { getLocalLifecycleStatus, staleRecoveryContinue, staleRecoveryEnd } from "../services/dotaCompanionApi";
import type { LifecycleStatus } from "../types/status";

// WK-112 - OBS-driven local stream lifecycle status, polled the same way
// useStatus polls get_status (see that hook) - normal lifecycle needs no
// user action at all here; this hook only ever surfaces something to do
// when session_state is "needs_manual_recovery" (a suspiciously old open
// session - see local_runtime::lifecycle::is_stale).
export interface LocalLifecycleState {
  status: LifecycleStatus | null;
  busy: boolean;
  error: string | null;
  onContinue: () => Promise<void>;
  onEnd: () => Promise<void>;
}

export function useLocalLifecycle(): LocalLifecycleState {
  const [status, setStatus] = useState<LifecycleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getLocalLifecycleStatus();
      setStatus(next);
    } catch (cause) {
      // The local runtime failing to open is treated the same way WK-111
      // designed it to fail - inert, never blocking the rest of Companion -
      // so this hook just leaves `status` as-is rather than showing an error
      // banner for something the user can't act on anyway.
      console.warn("useLocalLifecycle: status fetch failed", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runRecoveryAction = useCallback(
    async (action: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (cause) {
        setError(String(cause));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refresh]
  );

  const onContinue = useCallback(() => runRecoveryAction(staleRecoveryContinue), [runRecoveryAction]);
  const onEnd = useCallback(() => runRecoveryAction(staleRecoveryEnd), [runRecoveryAction]);

  return { status, busy, error, onContinue, onEnd };
}
