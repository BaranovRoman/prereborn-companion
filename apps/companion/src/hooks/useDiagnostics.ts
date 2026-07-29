import { useCallback, useEffect, useState } from "react";
import * as dotaCompanionApi from "../services/dotaCompanionApi";
import type { DiagnosticsStatusSnapshot } from "../types/status";

const POLL_INTERVAL_MS = 5000;

/**
 * Diagnostics has no push events like "gsi-event" (see useGsiEvents) - it's
 * an opt-in, rarely-used panel, so a slow poll while mounted is simpler than
 * wiring a new Tauri event for it and cheap either way (diagnostics_get_status
 * is just a mutex lock + small struct clone on the Rust side).
 */
export function useDiagnostics() {
  const [status, setStatus] = useState<DiagnosticsStatusSnapshot | null>(null);

  const refresh = useCallback(async () => {
    const snapshot = await dotaCompanionApi.diagnosticsGetStatus();
    setStatus(snapshot);
    return snapshot;
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return { status, refresh, setStatus };
}
