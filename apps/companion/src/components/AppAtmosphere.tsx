import { RedFogBackground, type RedFogDebugState } from "../atmosphere/RedFogBackground";

// WK-116 - no debug UI consumes this in Companion, matching web's own
// AppAtmosphere usage (apps/web/src/shared/ui/app-atmosphere), which also
// discards it - the debug callback exists only for the standalone /stream/
// queue page's on-screen debug panel, not the ambient sitewide background.
const ignoreDebugState: (state: RedFogDebugState) => void = () => {};

// WK-115/WK-116 - shared Prereborn/old-Dota atmosphere (dark background +
// animated WebGL2 fog/ember shader + layered tree silhouettes + vignette).
// Ported from apps/web/src/shared/ui/app-atmosphere - same assets, same
// component (RedFogBackground, copied into ../atmosphere since Companion
// has no shared package to import web's components from), same quality
// preset (`quality="medium"`, `seed={123}`) web itself uses for this exact
// "ambient background behind everything else" role - not web's higher
// "high" quality tier, which web itself only spends on the full-immersion
// `/stream/queue` scene where the shader IS the whole screen. This is
// genuine parity with web's own choice for this role, not a Companion-
// specific downgrade.
//
// WK-116 - the WK-115 pass shipped a CSS-only fallback here on a
// performance assumption and got visible artifacts for it (a flat "halo"
// around the tree edges, see the fix below) - reversed per follow-up: the
// shader is back, layered exactly like web's queue-scene.module.scss does
// it (`.canvas` sits at z-index 2, BETWEEN the far/distant tree layers and
// the middle/near ones, not simply above or below all of them) - matching
// this interleaving is what actually depth-composites the trees into the
// fog instead of leaving their mask-feathered edges sitting on a flatter,
// lighter background. See App.css's z-index comments on each
// `.app-atmosphere__*` layer for the exact ordering.
//
// Mounted once at the app-shell root (see AppShell.tsx), as a fixed,
// z-index:0 layer inside `.app-shell`'s own isolated stacking context (see
// App.css's WK-115 stacking-context fix). It never lives inside a tab/page
// component, so switching tabs (which only swaps what's inside <main>)
// never unmounts/remounts the canvas or restarts its WebGL context - no
// flicker, no reload, no second RAF loop between tabs.
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
        <RedFogBackground quality="medium" seed={123} forceFallback={false} onDebugStateChange={ignoreDebugState} />
        <div className="app-atmosphere__fog-middle" />
        <div className="app-atmosphere__tree-layer app-atmosphere__tree-middle">
          <img className="app-atmosphere__tree-image" src="/atmosphere/trees-2.png" alt="" draggable={false} />
        </div>
        <div className="app-atmosphere__fog-front" />
        <div className="app-atmosphere__tree-layer app-atmosphere__tree-near">
          <img className="app-atmosphere__tree-image" src="/atmosphere/trees-3.png" alt="" draggable={false} />
        </div>
      </div>
      <div className="app-atmosphere__finish" />
    </div>
  );
}
