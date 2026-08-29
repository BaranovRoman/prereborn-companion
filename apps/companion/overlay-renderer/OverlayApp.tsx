import { useEffect, useState } from "react";
import { AnchoredBox } from "./AnchoredBox";
import { Scene, SCENE_HEIGHT, SCENE_WIDTH } from "./Scene";
import { CurrentGameWidget } from "./widgets/CurrentGameWidget";
import { SessionWidget } from "./widgets/SessionWidget";
import type { OverlayLayout, OverlayStateSnapshot } from "./types";

const SCENE_LABEL: Record<OverlayStateSnapshot["scene"], string> = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
  postStream: "Итоги стрима",
};

// WK-121/WK-122 §19 - the real production local-overlay renderer, replacing
// WK-120's explicitly-labeled dev-preview page. Served at GET /overlay by
// the same Rust server (overlay_server.rs) that owns /overlay/state and
// /overlay/events - this is the ONE renderer both a real OBS Browser
// Source AND the "Оформление" editor's live preview (DesignPage.tsx, same
// iframe src) point at, per this slice's explicit "not a second preview
// implementation" requirement.
//
// WK-122 §19 closes WK-121's own documented gap: Draft/Gameplay's
// Session/CurrentGame widgets now position themselves from the user's REAL
// saved OverlayLayout (`GET /overlay/layout`, re-fetched only when
// `layoutVersion` moves - see AnchoredBox.tsx for the position math, ported
// from apps/web's AnchoredWidget) instead of a fixed `.ov-anchor--X` class.
// Falls back to those original fixed positions when no layout has been
// fetched yet (a brand new install, or Companion not yet connected to an
// account) - never a blank/broken widget just because the layout request
// hasn't resolved. Между матчами/Итоги don't have a saved widget layout at
// all in the real data model (OverlayLayout only defines draft/gameplay
// scenes) - their big centered SessionWidget treatment is unchanged.
export function OverlayApp() {
  const [snapshot, setSnapshot] = useState<OverlayStateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [layout, setLayout] = useState<OverlayLayout | null>(null);

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

  // Re-fetches only when the server-reported version actually moves (never
  // on every snapshot/tick) - see OverlayStateSnapshot.layoutVersion's doc
  // comment in types.ts for why this is a separate, coarser-grained fetch
  // rather than embedding the whole layout in every SSE frame.
  useEffect(() => {
    if (snapshot === null) return;
    let cancelled = false;
    fetch("/overlay/layout")
      .then((response) => response.json())
      .then((data: OverlayLayout | null) => { if (!cancelled) setLayout(data); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.layoutVersion]);

  if (!snapshot) return <Scene><div className="ov-loading" /></Scene>;

  const { scene, session, currentGame } = snapshot;
  const sceneWidgets = scene === "draft" || scene === "gameplay" ? layout?.scenes[scene].widgets : undefined;

  return (
    <Scene>
      <div className={`ov-background ov-background--${scene}`} />

      {(scene === "draft" || scene === "gameplay") && (
        sceneWidgets ? (
          <>
            <AnchoredBox layout={sceneWidgets.currentGame} sceneWidth={SCENE_WIDTH} sceneHeight={SCENE_HEIGHT}>
              <CurrentGameWidget game={currentGame} />
            </AnchoredBox>
            <AnchoredBox layout={sceneWidgets.session} sceneWidth={SCENE_WIDTH} sceneHeight={SCENE_HEIGHT}>
              <SessionWidget session={session} />
            </AnchoredBox>
          </>
        ) : (
          // No saved layout fetched yet - same fixed fallback positions
          // WK-121 originally shipped, not a blank scene.
          <>
            <div className="ov-anchor ov-anchor--bottom-center">
              <CurrentGameWidget game={currentGame} />
            </div>
            <div className="ov-anchor ov-anchor--top-left">
              <SessionWidget session={session} />
            </div>
          </>
        )
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
