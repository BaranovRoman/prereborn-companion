import { useCallback, useEffect, useState } from "react";
import * as api from "../services/dotaCompanionApi";

const OPACITY_KEY = "gameplay-reference-opacity";

// Local Companion adapter for Web's useReferenceBackground contract. The
// image itself lives in app_data; only the editor opacity lives in WebView
// localStorage. Neither value is part of the OBS layout or SSE snapshot.
export function useGameplayReferenceBackground() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [opacity, setOpacityState] = useState(() => Number(localStorage.getItem(OPACITY_KEY) ?? "0.65"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getGameplayReference().then(setImageUrl).catch(() => {}); }, []);

  const upload = useCallback(async () => {
    setError(null);
    try { setImageUrl(await api.chooseGameplayReference()); }
    catch (cause) { if (!String(cause).includes("отменён")) setError(String(cause)); }
  }, []);

  const remove = useCallback(async () => {
    setError(null);
    await api.removeGameplayReference();
    setImageUrl(null);
  }, []);

  const setOpacity = useCallback((value: number) => {
    setOpacityState(value);
    localStorage.setItem(OPACITY_KEY, String(value));
  }, []);

  return { imageUrl, opacity, error, upload, remove, setOpacity };
}
