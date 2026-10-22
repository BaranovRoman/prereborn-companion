import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { emptyReason, Widget, WidgetNotice, type WidgetState } from "../src/widget/Widget";

// OBS Browser Source: transparent page, polls the worker's projection. A
// failed read keeps the last good table instead of blinking it away. Opened
// in an ordinary browser, an empty widget says why; OBS (window.obsstudio)
// never shows that text on stream.
document.documentElement.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.background = "transparent";
const inObs = "obsstudio" in window;

export function WidgetApp({ url = "/pubg/widget/state", interval = 2000, obs = inObs }: { url?: string; interval?: number; obs?: boolean }) {
  const [state, setState] = useState<WidgetState | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let disposed = false;
    let last: string | undefined;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`widget_state_${response.status}`);
        const text = await response.text();
        const next = JSON.parse(text) as WidgetState;
        if (disposed) return;
        setOffline(false);
        // Compared by content, not revision: a restarted worker counts
        // revisions from zero again and must still replace the table.
        if (Array.isArray(next.matches) && text !== last) { last = text; setState(next); }
      } catch { if (!disposed) setOffline(true); /* worker restarting: keep the last state */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), interval);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [url, interval]);
  const reason = emptyReason(state, offline);
  if (reason === null) return state && <Widget state={state} />;
  return obs ? null : <WidgetNotice reason={reason} />;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><WidgetApp /></StrictMode>);
