import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Widget, type WidgetState } from "../src/widget/Widget";

// OBS Browser Source: transparent page, polls the worker's projection. A
// failed read keeps the last good table instead of blinking it away.
document.documentElement.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.background = "transparent";

function WidgetApp({ url = "/pubg/widget/state", interval = 2000 }: { url?: string; interval?: number }) {
  const [state, setState] = useState<WidgetState | null>(null);
  useEffect(() => {
    let disposed = false;
    let last: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as WidgetState;
        if (!disposed && Array.isArray(next.matches) && next.revision !== last) { last = next.revision; setState(next); }
      } catch { /* worker restarting: keep showing the last state */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), interval);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [url, interval]);
  return state ? <Widget state={state} /> : null;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><WidgetApp /></StrictMode>);
