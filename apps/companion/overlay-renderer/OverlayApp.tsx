import { useEffect, useState } from "react";
import { Scene } from "./Scene";
import { CurrentGameWidget } from "./widgets/CurrentGameWidget";
import { SessionWidget } from "./widgets/SessionWidget";
import type { OverlayStateSnapshot } from "./types";

const SCENE_LABEL: Record<OverlayStateSnapshot["scene"], string> = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
  postStream: "Итоги стрима",
};

// WK-121 - the real production local-overlay renderer, replacing WK-120's
// explicitly-labeled dev-preview page. Served at GET /overlay by the same
// Rust server (overlay_server.rs) that owns /overlay/state and
// /overlay/events - this is the ONE renderer both a real OBS Browser
// Source AND the "Оформление" foundation preview (DesignPage.tsx, same
// iframe src) point at, per this slice's explicit "not a second preview
// implementation" requirement.
//
// Scope note (see docs/research/wk-121-companion-product-consolidation.md):
// this renders real local data (session record/MMR delta, current hero+KDA)
// using the same Dota-like visual language as the rest of Companion, for
// all 4 BroadcastStates - it is NOT a pixel-identical port of apps/web's
// OverlayCanvas/AnchoredWidget widget set (that depends on the user's saved
// OverlayLayout positions and a cross-app extraction out of Next.js, both
// explicitly deferred, see that doc's "Remaining" section). Fixed, sensible
// widget positions are used instead of per-user xVw/yVh/scale/anchor.
export function OverlayApp() {
  const [snapshot, setSnapshot] = useState<OverlayStateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/overlay/state")
      .then((response) => response.json())
      .then((data: OverlayStateSnapshot) => { if (!cancelled) setSnapshot(data); })
      .catch(() => {});

    const source = new EventSource("/overlay/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      setConnected(true);
      try {
        setSnapshot(JSON.parse(event.data) as OverlayStateSnapshot);
      } catch {
        // malformed frame - keep showing the last good snapshot
      }
    };
    return () => { cancelled = true; source.close(); };
  }, []);

  if (!snapshot) return <Scene><div className="ov-loading" /></Scene>;

  const { scene, session, currentGame } = snapshot;

  return (
    <Scene>
      <div className={`ov-background ov-background--${scene}`} />

      {(scene === "draft" || scene === "gameplay") && (
        <>
          <div className="ov-anchor ov-anchor--bottom-center">
            <CurrentGameWidget game={currentGame} />
          </div>
          <div className="ov-anchor ov-anchor--top-left">
            <SessionWidget session={session} />
          </div>
        </>
      )}

      {scene === "betweenMatches" && (
        <div className="ov-anchor ov-anchor--center">
          <div className="ov-scene-title">{SCENE_LABEL[scene]}</div>
          <SessionWidget session={session} big />
        </div>
      )}

      {scene === "postStream" && (
        <div className="ov-anchor ov-anchor--center">
          <div className="ov-scene-title">{SCENE_LABEL[scene]}</div>
          <SessionWidget session={session} big />
        </div>
      )}

      {!connected && <div className="ov-anchor ov-anchor--top-right"><span className="ov-reconnecting">Переподключение…</span></div>}
    </Scene>
  );
}
