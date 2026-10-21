import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../core/api";
import type { ClipsAccess, ClipsStatus } from "../core/contracts";

// WK-178 - state for the «Клипы Twitch» settings block. The native side owns
// the hotkey, the in-flight guard and the local history; this hook only
// mirrors its status (pushed via "clips://state") and forwards edits.
export function useTwitchClips() {
  const [status, setStatus] = useState<ClipsStatus | null>(null);
  const [access, setAccess] = useState<ClipsAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAccess = useCallback(() => {
    void api
      .getClipsAccess()
      .then((value) => { setAccess(value); setAccessError(null); })
      .catch((cause) => setAccessError(String(cause)));
  }, []);

  useEffect(() => {
    let mounted = true;
    void api.getClipsStatus().then((value) => { if (mounted) setStatus(value); }).catch(() => {});
    loadAccess();
    const unlisten = listen<ClipsStatus>(api.CLIPS_STATE_EVENT, (event) => setStatus(event.payload));
    // Re-auth happens in the browser; re-check scopes when the user returns.
    window.addEventListener("focus", loadAccess);
    return () => {
      mounted = false;
      window.removeEventListener("focus", loadAccess);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [loadAccess]);

  const run = useCallback(async (action: () => Promise<ClipsStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } finally {
      setBusy(false);
    }
  }, []);

  const updateHotkey = useCallback(
    (enabled: boolean, shortcut: string) => run(() => api.setClipsHotkey(enabled, shortcut)),
    [run],
  );
  const updateDuration = useCallback(
    (durationSeconds: number) => run(() => api.setClipDuration(durationSeconds)),
    [run],
  );
  const clearHistory = useCallback(() => run(() => api.clearClipsHistory()), [run]);

  return {
    status,
    access,
    accessError,
    busy,
    updateHotkey,
    updateDuration,
    clearHistory,
    createNow: api.createClipNow,
    openClip: api.openClip,
    reconnectTwitch: api.connectTwitch,
    reloadAccess: loadAccess,
  };
}
