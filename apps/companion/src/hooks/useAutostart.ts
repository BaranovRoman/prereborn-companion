import { useCallback, useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

export type AutostartState =
  | { phase: "loading" }
  | { phase: "ready"; enabled: boolean }
  | { phase: "error"; message: string; enabled: boolean };

// Companion UI 2.0 - "Запускать вместе с Windows" (Settings). Always reads
// the real OS autostart state via the plugin's isEnabled() (registry on
// Windows) rather than a localStorage flag - the задача is explicit that the
// toggle must reflect the actual OS state, not a cached guess that could
// drift if the user removed the entry outside Companion (e.g. Windows'
// own Startup Apps settings). No persisted app-side state at all: nothing
// here can be "lost" across an update, the OS entry itself is the only
// source of truth.
export function useAutostart() {
  const [state, setState] = useState<AutostartState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const on = await isEnabled();
      setState({ phase: "ready", enabled: on });
    } catch (cause) {
      setState((prev) => ({
        phase: "error",
        message: String(cause),
        enabled: prev.phase === "loading" ? false : prev.enabled,
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setAutostart = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        if (next) await enable();
        else await disable();
        await refresh();
      } catch (cause) {
        setState((prev) => ({
          phase: "error",
          message: String(cause),
          enabled: prev.phase === "loading" ? false : prev.enabled,
        }));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return { state, busy, setAutostart, refresh };
}
