import { useCallback, useEffect, useState } from "react";
import { getSyncOutboxStatus } from "../services/dotaCompanionApi";
import type { SyncOutboxStatus } from "../types/status";

// WK-119 - sync_outbox (WK-113) visibility, polled the same way
// useLocalSessionSummary polls session data - read-only, never blocks on
// the backend (see local_runtime::sync::status).
// `refresh` is exposed (same shape as useDiagnostics) so the Диагностика
// "Повторить сейчас" button can pull the fresh status immediately after
// triggering a drain, instead of waiting up to 3s for the next poll tick.
export function useSyncOutboxStatus(): { status: SyncOutboxStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<SyncOutboxStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getSyncOutboxStatus());
    } catch (cause) {
      console.warn("useSyncOutboxStatus: fetch failed", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { status, refresh };
}
