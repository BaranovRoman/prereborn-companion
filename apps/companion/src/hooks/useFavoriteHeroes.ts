import { useCallback, useEffect, useState } from "react";
import { getFavoriteHeroes, saveFavoriteHeroes } from "../services/dotaCompanionApi";

const MAX_FAVORITES = 3;

// WK-121 - reads/writes the SAME stream_queue_settings.favoriteHeroIds row
// the web cabinet's Favorite Heroes picker already owns (via the new
// companion-token-authenticated /favorite-heroes route - see
// backend/mod.rs's doc comment). Not a local-only favorites store: this is
// Companion's one consumer of that same source of truth.
export function useFavoriteHeroes() {
  const [heroIds, setHeroIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setHeroIds(await getFavoriteHeroes());
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (heroId: number) => {
      const isFavorite = heroIds.includes(heroId);
      if (!isFavorite && heroIds.length >= MAX_FAVORITES) {
        setError(`Можно выбрать не больше ${MAX_FAVORITES} героев.`);
        return;
      }
      const next = isFavorite ? heroIds.filter((id) => id !== heroId) : [...heroIds, heroId];
      setBusyId(heroId);
      setError(null);
      const previous = heroIds;
      setHeroIds(next);
      try {
        setHeroIds(await saveFavoriteHeroes(next));
      } catch (cause) {
        setHeroIds(previous);
        setError(String(cause));
      } finally {
        setBusyId(null);
      }
    },
    [heroIds]
  );

  return { heroIds, loading, error, busyId, toggle, maxFavorites: MAX_FAVORITES, refresh };
}
