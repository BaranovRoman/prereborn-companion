import { useCallback, useEffect, useState } from "react";
import { getFavoriteHeroes, saveFavoriteHeroes } from "../services/dotaCompanionApi";

const MAX_FAVORITES = 3;

// Same account queue-settings favoriteHeroIds the web cabinet owns. Unlike
// 0.5.94, a toggle shows the new set only after the confirmed durable save.
export function useFavoriteHeroes() {
  const [heroIds, setHeroIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setHeroIds(await getFavoriteHeroes()); setError(null); }
    catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = useCallback(async (heroId: number) => {
    if (busyId !== null) return;
    const isFavorite = heroIds.includes(heroId);
    if (!isFavorite && heroIds.length >= MAX_FAVORITES) { setError(`Можно выбрать не больше ${MAX_FAVORITES} героев.`); return; }
    const next = isFavorite ? heroIds.filter((id) => id !== heroId) : [...heroIds, heroId];
    setBusyId(heroId); setError(null);
    try { setHeroIds(await saveFavoriteHeroes(next)); }
    catch (cause) { setError(String(cause)); }
    finally { setBusyId(null); }
  }, [heroIds, busyId]);

  return { heroIds, loading, error, busyId, toggle, maxFavorites: MAX_FAVORITES, refresh };
}
