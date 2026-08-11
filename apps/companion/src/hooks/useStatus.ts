import { useCallback, useEffect, useState } from "react";
import { getStatus } from "../services/dotaCompanionApi";
import type { StatusSnapshot } from "../types/status";

export function useStatus() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const snapshot = await getStatus();
    setStatus(snapshot);
    return snapshot;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, setStatus, refresh, loading };
}
