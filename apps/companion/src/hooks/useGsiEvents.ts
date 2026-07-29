import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LastEvent } from "../types/status";
import { appendEventHistory, loadEventHistory } from "../storage/eventHistory";

/** Live GSI event feed: appends every "gsi-event" emitted by the Rust HTTP server. */
export function useGsiEvents() {
  const [history, setHistory] = useState<LastEvent[]>(() => loadEventHistory());

  useEffect(() => {
    const unlistenPromise = listen<LastEvent>("gsi-event", (event) => {
      setHistory(appendEventHistory(event.payload));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return history;
}
