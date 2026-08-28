import { useCallback, useEffect, useState } from "react";
import { getLocalSessionSummary } from "../services/dotaCompanionApi";
import type { LocalSessionSummary } from "../types/status";

// WK-114 - local-first Главная data (session MMR/W-L/current+recent
// matches), polled the same way useLocalLifecycle polls lifecycle status -
// read-only, never blocks on the backend (see local_runtime::summary).
export function useLocalSessionSummary(): LocalSessionSummary | null {
  const [summary, setSummary] = useState<LocalSessionSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await getLocalSessionSummary());
    } catch (cause) {
      console.warn("useLocalSessionSummary: fetch failed", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return summary;
}
