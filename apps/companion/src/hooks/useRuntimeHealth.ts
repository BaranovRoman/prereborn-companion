import { useCallback, useEffect, useState } from "react";
import { getRuntimeHealth } from "../services/dotaCompanionApi";
import type { RuntimeHealth } from "../types/status";

// WK-126 - Diagnostics v2. Deliberately a slower cadence than useStatus's 3s
// (get_runtime_health does a live loopback probe of the local overlay
// server on every call, see runtime_health.rs) and only mounted on the
// Диагностика page itself, not AppShell - this is a troubleshooting surface,
// not something every screen needs to keep fresh in the background.
const POLL_INTERVAL_MS = 10_000;

export function useRuntimeHealth(): { health: RuntimeHealth | null; refresh: () => Promise<void> } {
  const [health, setHealth] = useState<RuntimeHealth | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHealth(await getRuntimeHealth());
    } catch (cause) {
      console.warn("useRuntimeHealth: fetch failed", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { health, refresh };
}
