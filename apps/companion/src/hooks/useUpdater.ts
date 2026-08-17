import { useCallback, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; version: string; notes: string | null }
  | { phase: "downloading"; version: string; downloaded: number; total: number | null }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

// Wraps @tauri-apps/plugin-updater's check()/downloadAndInstall() into the
// checking/available/progress/restart/error/up-to-date states WK-70 calls
// for. A corrupted or unsigned download never reaches "ready" - the plugin
// itself refuses to run anything whose signature doesn't verify against the
// pubkey in tauri.conf.json, so failures land in "error" with the installed
// version left untouched.
export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({ phase: "idle" });
  const pendingUpdate = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async () => {
    setState({ phase: "checking" });
    try {
      const update = await check();
      if (!update) {
        setState({ phase: "up-to-date" });
        return;
      }
      pendingUpdate.current = update;
      setState({ phase: "available", version: update.version, notes: update.body ?? null });
    } catch (cause) {
      setState({ phase: "error", message: String(cause) });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdate.current;
    if (!update) return;
    const version = update.version;
    let downloaded = 0;
    let total: number | null = null;
    setState({ phase: "downloading", version, downloaded: 0, total: null });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setState({ phase: "downloading", version, downloaded, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setState({ phase: "downloading", version, downloaded, total });
            break;
          case "Finished":
            setState({ phase: "ready", version });
            break;
        }
      });
    } catch (cause) {
      setState({ phase: "error", message: String(cause) });
    }
  }, []);

  const restartToApply = useCallback(async () => {
    await relaunch();
  }, []);

  const dismiss = useCallback(() => {
    pendingUpdate.current = null;
    setState({ phase: "idle" });
  }, []);

  return { state, checkForUpdate, installUpdate, restartToApply, dismiss };
}
