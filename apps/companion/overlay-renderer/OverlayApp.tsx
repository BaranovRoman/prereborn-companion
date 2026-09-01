import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnchoredBox } from "./AnchoredBox";
import { Scene } from "./Scene";
import { AntiSnipeLayer } from "./AntiSnipeLayer";
import { DraftProtectionLayer } from "./draft-protection/DraftProtectionLayer";
import { RecentMatchesWidget } from "./widgets/RecentMatchesWidget";
import { SessionWidget } from "./widgets/SessionWidget";
import { BetweenMatchesScene } from "./between-matches/BetweenMatchesScene";
import type { OverlayLayout, OverlayStateSnapshot, QueueSettings } from "./types";
import { resolveSceneDimensions } from "./sceneDimensions";

const SCENE_LABEL: Record<OverlayStateSnapshot["scene"], string> = {
  betweenMatches: "Между матчами",
  draft: "Драфт",
  gameplay: "Игра",
  postStream: "Итоги стрима",
};

const VALID_SCENES = Object.keys(SCENE_LABEL) as OverlayStateSnapshot["scene"][];

function cameraAnchorFraction(anchor: string) {
  const x = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 1 : 0.5;
  const y = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 1 : 0.5;
  return { x, y };
}

function CameraZoneEditor({ zone, sceneWidth, sceneHeight, onChange }: { zone: NonNullable<OverlayLayout["scenes"]["gameplay"]>["cameraZone"]; sceneWidth: number; sceneHeight: number; onChange: (patch: Record<string, number>) => void }) {
  const gesture = useRef<{ mode: "move" | "resize"; x: number; y: number; zone: typeof zone } | null>(null);
  const fraction = cameraAnchorFraction(zone.anchor);
  const begin = (event: ReactPointerEvent<HTMLElement>, mode: "move" | "resize") => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { mode, x: event.clientX, y: event.clientY, zone };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active) return;
    const root = event.currentTarget.closest<HTMLElement>("[data-scene-root]");
    const scale = root ? root.getBoundingClientRect().width / root.offsetWidth : 1;
    const dx = (event.clientX - active.x) / (scale || 1), dy = (event.clientY - active.y) / (scale || 1);
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    onChange(active.mode === "move"
      ? { x: Math.round(clamp(active.zone.x + dx, 0, sceneWidth)), y: Math.round(clamp(active.zone.y + dy, 0, sceneHeight)) }
      : { width: Math.round(clamp(active.zone.width + dx, 80, sceneWidth)), height: Math.round(clamp(active.zone.height + dy, 80, sceneHeight)) });
  };
  return <div className="ov-camera-zone" style={{ left: zone.x - fraction.x * zone.width, top: zone.y - fraction.y * zone.height, width: zone.width, height: zone.height }} onPointerDown={(event) => begin(event, "move")} onPointerMove={move} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }}>
    Камера в OBS
    <span aria-label="Изменить размер области камеры" onPointerDown={(event) => begin(event, "resize")} />
  </div>;
}

// WK-122 §18 - Оформление's editor (DesignPage.tsx) needs to preview
// whichever scene tab the user is currently editing, not only whatever the
// real GSI/OBS state happens to be right now (a streamer isn't necessarily
// mid-draft while adjusting Draft's widget positions). `?previewScene=` is
// read ONLY here, client-side - a real OBS Browser Source URL
// (127.0.0.1:3666/overlay, no query string) is completely unaffected; this
// never changes what `overlay_server.rs` resolves or serves. Session/
// current-game DATA stays real either way - only which scene's layout/
// background is shown is overridden.
function readPreviewScene(): OverlayStateSnapshot["scene"] | null {
  const value = new URLSearchParams(window.location.search).get("previewScene");
  return VALID_SCENES.includes(value as OverlayStateSnapshot["scene"]) ? (value as OverlayStateSnapshot["scene"]) : null;
}

function isEditorPreview() {
  return new URLSearchParams(window.location.search).get("editor") === "1";
}

// WK-121/WK-122 §19 - the real production local-overlay renderer, replacing
// WK-120's explicitly-labeled dev-preview page. Served at GET /overlay by
// the same Rust server (overlay_server.rs) that owns /overlay/state and
// /overlay/events - this is the ONE renderer both a real OBS Browser
// Source AND the "Оформление" editor's live preview (DesignPage.tsx, same
// iframe src) point at, per this slice's explicit "not a second preview
// implementation" requirement.
//
// WK-122 §19 closes WK-121's own documented gap: Draft/Gameplay's
// Session/RecentMatches widgets position themselves from the user's REAL
// saved OverlayLayout (`GET /overlay/layout`, re-fetched only when
// `layoutVersion` moves - see AnchoredBox.tsx for the position math, ported
// from apps/web's AnchoredWidget) instead of a fixed `.ov-anchor--X` class.
// Falls back to those original fixed positions when no layout has been
// fetched yet (a brand new install, or Companion not yet connected to an
// account) - never a blank/broken widget just because the layout request
// hasn't resolved. Между матчами/Итоги don't have a saved widget layout at
// all in the real data model (OverlayLayout only defines draft/gameplay
// scenes). Between Matches has its own fixed production-HUD composition;
// PostStream keeps the existing centered SessionWidget treatment.
export function OverlayApp() {
  const [snapshot, setSnapshot] = useState<OverlayStateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [layout, setLayout] = useState<OverlayLayout | null>(null);
  const [queueSettings, setQueueSettings] = useState<QueueSettings | null>(null);
  const [selectedWidget, setSelectedWidget] = useState<string | null>("session");

  useEffect(() => {
    if (!isEditorPreview()) return;
    const receive = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === "prereborn-overlay-layout-preview" && event.data.layout) {
        setLayout(event.data.layout as OverlayLayout);
        if (event.data.queueSettings) setQueueSettings(event.data.queueSettings as QueueSettings);
      }
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "prereborn-overlay-preview-ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, []);

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
    fetch("/overlay/queue-settings")
      .then((response) => response.json())
      .then((data: QueueSettings | null) => { if (!cancelled) setQueueSettings(data); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.layoutVersion]);

  if (!snapshot) return <Scene><div className="ov-loading" /></Scene>;

  const { session } = snapshot;
  const scene = readPreviewScene() ?? snapshot.scene;
  const sceneLayout = scene === "draft" || scene === "gameplay" ? layout?.scenes[scene] : undefined;
  const sceneWidgets = sceneLayout?.widgets;
  const dimensions = resolveSceneDimensions(layout);
  const editor = isEditorPreview();
  const patchWidget = (key: "session" | "recentMatches", patch: Record<string, unknown>) => {
    if (!layout || (scene !== "draft" && scene !== "gameplay")) return;
    const next = {
      ...layout,
      scenes: {
        ...layout.scenes,
        [scene]: {
          ...layout.scenes[scene],
          widgets: {
            ...layout.scenes[scene].widgets,
            [key]: { ...layout.scenes[scene].widgets[key], ...patch },
          },
        },
      },
    };
    setLayout(next);
    window.parent.postMessage({ type: "prereborn-overlay-widget-change", scene, widget: key, patch }, "*");
  };

  return (
    <Scene sceneWidth={dimensions.width} sceneHeight={dimensions.height}>
      <div className={`ov-background ov-background--${scene}`} />

      {scene === "gameplay" && <AntiSnipeLayer settings={sceneLayout?.minimapCover} />}
      {scene === "draft" && layout && <DraftProtectionLayer mode={layout.draftProtection.mode} text={layout.draftProtection.text} sceneWidth={dimensions.width} sceneHeight={dimensions.height} editable={isEditorPreview()} />}

      {scene === "gameplay" && (
        sceneWidgets ? (
          <>
            <AnchoredBox layout={sceneWidgets.session} sceneWidth={dimensions.width} sceneHeight={dimensions.height} editable={editor} selected={selectedWidget === "session"} onSelect={() => setSelectedWidget("session")} onChange={(patch) => patchWidget("session", patch)}>
              <SessionWidget session={session} />
            </AnchoredBox>
            <AnchoredBox layout={sceneWidgets.recentMatches} sceneWidth={dimensions.width} sceneHeight={dimensions.height} editable={editor} selected={selectedWidget === "recentMatches"} onSelect={() => setSelectedWidget("recentMatches")} onChange={(patch) => patchWidget("recentMatches", patch)}>
              <RecentMatchesWidget matches={session.recentMatches} settings={sceneWidgets.recentMatches.recentMatches} anchor={sceneWidgets.recentMatches.anchor} />
            </AnchoredBox>
          </>
        ) : (
          // No saved layout fetched yet - same fixed fallback positions
          // WK-121 originally shipped, not a blank scene.
          <>
            <div className="ov-anchor ov-anchor--top-left">
              <SessionWidget session={session} />
            </div>
          </>
        )
      )}

      {editor && scene === "gameplay" && sceneLayout?.cameraZone.enabled && (
        <CameraZoneEditor zone={sceneLayout.cameraZone} sceneWidth={dimensions.width} sceneHeight={dimensions.height} onChange={(patch) => {
          if (!layout || scene !== "gameplay") return;
          const next = { ...layout, scenes: { ...layout.scenes, [scene]: { ...layout.scenes[scene], cameraZone: { ...layout.scenes[scene].cameraZone, ...patch } } } };
          setLayout(next);
          window.parent.postMessage({ type: "prereborn-overlay-camera-change", scene, patch }, "*");
        }} />
      )}

      {scene === "betweenMatches" && (
        <BetweenMatchesScene session={session} settings={queueSettings} account={snapshot.account} twitchChat={snapshot.twitchChat} />
      )}

      {scene === "postStream" && (
        <div className="ov-anchor ov-anchor--center">
          <div className="ov-scene-title">{SCENE_LABEL[scene]}</div>
          <SessionWidget session={session} big />
          <RecentMatchesWidget matches={session.recentMatches} />
        </div>
      )}

      {!connected && <div className="ov-anchor ov-anchor--top-right"><span className="ov-reconnecting">Переподключение…</span></div>}
    </Scene>
  );
}
