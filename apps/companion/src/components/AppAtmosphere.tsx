// WK-115 audit - shared Prereborn/old-Dota atmosphere (dark background +
// layered tree silhouettes + CSS fog + vignette). Reuses the same assets and
// color language apps/web already built for this exact look (see
// apps/web/src/shared/ui/app-atmosphere and
// apps/web/src/components/pages/stream/queue/queue-tree-layers.tsx /
// queue-scene.module.scss) rather than inventing a new visual language for
// Companion - the tree PNGs are literally the same files (copied into
// public/atmosphere, since Companion is a separate Vite app with no shared
// package to import web's components from). The web version's animated
// WebGL2 fog canvas is deliberately NOT ported here - Companion runs
// continuously alongside Dota/OBS during a stream, so this sticks to the
// same reference's plain-CSS fog gradients (.treeFogMiddle/.treeFogFront
// there), which already are that component's own no-WebGL fallback path -
// cheap, GPU-composited transform animations only, nothing per-frame.
//
// Mounted once at the app-shell root (see AppShell.tsx), as a fixed,
// negative-z-index layer - the same technique this file's App.css already
// uses for `body::before`. It never lives inside a tab/page component, so
// switching tabs (which only swaps what's inside <main>) never unmounts or
// restarts it - no flicker, no reload between tabs.
export function AppAtmosphere() {
  return (
    <div className="app-atmosphere" aria-hidden="true">
      <div className="app-atmosphere__fallback" />
      <div className="app-atmosphere__tree-stage">
        <div className="app-atmosphere__tree-layer app-atmosphere__tree-distant">
          <img className="app-atmosphere__tree-image" src="/atmosphere/trees-2.png" alt="" draggable={false} />
        </div>
        <div className="app-atmosphere__tree-layer app-atmosphere__tree-far">
          <img className="app-atmosphere__tree-image" src="/atmosphere/trees-1.png" alt="" draggable={false} />
        </div>
        <div className="app-atmosphere__tree-layer app-atmosphere__tree-middle">
          <img className="app-atmosphere__tree-image" src="/atmosphere/trees-2.png" alt="" draggable={false} />
        </div>
        <div className="app-atmosphere__tree-layer app-atmosphere__tree-near">
          <img className="app-atmosphere__tree-image" src="/atmosphere/trees-3.png" alt="" draggable={false} />
        </div>
        <div className="app-atmosphere__fog-middle" />
        <div className="app-atmosphere__fog-front" />
      </div>
      <div className="app-atmosphere__finish" />
    </div>
  );
}
