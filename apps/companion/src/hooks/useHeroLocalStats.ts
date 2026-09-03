import { useEffect, useState } from "react";
import { getHeroLocalStats } from "../services/dotaCompanionApi";
import type { HeroLocalStats } from "../types/status";

// WK-140 - Hero Detail's local statistics zone. Re-fetches whenever the
// viewed hero changes; unlike useLocalSessionSummary this doesn't poll - a
// hero's local match history doesn't change while the user is just looking
// at it (nothing writes new matches from this screen).
export function useHeroLocalStats(heroId: number): HeroLocalStats | null {
  const [stats, setStats] = useState<HeroLocalStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    getHeroLocalStats(heroId)
      .then((value) => {
        if (!cancelled) setStats(value);
      })
      .catch((cause) => {
        console.warn("useHeroLocalStats: fetch failed", cause);
      });
    return () => {
      cancelled = true;
    };
  }, [heroId]);

  return stats;
}
