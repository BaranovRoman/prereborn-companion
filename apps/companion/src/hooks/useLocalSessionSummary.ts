import { useCallback, useEffect, useState } from "react";
import { getLocalSessionSummary } from "../services/dotaCompanionApi";
import type { LocalSessionSummary } from "../types/status";

// WK-114 - local-first Главная data (session MMR/W-L/current+recent
// matches), polled the same way useLocalLifecycle polls lifecycle status -
// read-only, never blocks on the backend (see local_runtime::summary).
//
// WK-115 - also returns `refresh` (mirrors useStatus's own shape) so the
// Dashboard's match-correction actions can force an immediate re-read
// straight after a correction command resolves, instead of waiting up to
// 3s for the next poll tick.
export function useLocalSessionSummary(): { summary: LocalSessionSummary | null; refresh: () => Promise<void> } {
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

  return { summary, refresh };
}
