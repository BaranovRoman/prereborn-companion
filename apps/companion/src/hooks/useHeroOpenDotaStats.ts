import { useEffect, useState } from "react";
import { getHeroOpenDotaStats, type HeroOpenDotaStats } from "../services/dotaCompanionApi";

// WK-133 - Hero Detail's OpenDota panel. Modeled directly on
// useHeroLocalStats.ts (re-fetch on hero change, no polling), plus a
// window-focus refetch: unlike the local history this data can change out
// from under the user while this screen stays mounted (linking Steam in the
// system browser via Settings → Интеграции, then returning to Companion) -
// see this task's "no restart required" requirement.
export function useHeroOpenDotaStats(heroId: number): HeroOpenDotaStats | null {
  const [stats, setStats] = useState<HeroOpenDotaStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    const load = () => {
      getHeroOpenDotaStats(heroId)
        .then((value) => {
          if (!cancelled) setStats(value);
        })
        .catch((cause) => {
          console.warn("useHeroOpenDotaStats: fetch failed", cause);
          if (!cancelled) setStats({ status: "unavailable" });
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [heroId]);

  return stats;
}
