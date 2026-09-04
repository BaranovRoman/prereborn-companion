import { useEffect, useState } from "react";
import { getHeroOpenDotaInsights, type HeroOpenDotaInsights } from "../services/dotaCompanionApi";

// WK-148 - same shape as useHeroOpenDotaStats.ts (WK-133): re-fetch on hero
// change, refetch on window focus (Steam re-link via system browser).
// Separate hook/state from useHeroOpenDotaStats - the lifetime panel keeps
// working even if this additive-enrichment call fails independently.
export function useHeroOpenDotaInsights(heroId: number): HeroOpenDotaInsights | null {
  const [insights, setInsights] = useState<HeroOpenDotaInsights | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInsights(null);
    const load = () => {
      getHeroOpenDotaInsights(heroId)
        .then((value) => {
          if (!cancelled) setInsights(value);
        })
        .catch((cause) => {
          console.warn("useHeroOpenDotaInsights: fetch failed", cause);
          if (!cancelled) setInsights({ status: "unavailable" });
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [heroId]);

  return insights;
}
