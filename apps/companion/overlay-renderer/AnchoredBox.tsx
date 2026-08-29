import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { OverlayAnchor, OverlayWidgetLayout } from "./types";

type AnchorAxisX = "left" | "center" | "right";
type AnchorAxisY = "top" | "center" | "bottom";

const AXIS_X_FRACTION: Record<AnchorAxisX, number> = { left: 0, center: 0.5, right: 1 };
const AXIS_Y_FRACTION: Record<AnchorAxisY, number> = { top: 0, center: 0.5, bottom: 1 };

// Ported from apps/web/src/entities/stream-overlay-layout/lib/anchor.ts's
// `anchorFraction` (same "{y}-{x}" scheme, "center" alone means both axes
// centered) - this renderer is a standalone Vite build (see
// vite.overlay-renderer.config.ts), not something that can import a
// Next.js-adjacent entity module, so the small pure function is ported
// rather than shared.
function anchorFraction(anchor: OverlayAnchor): { x: number; y: number } {
  if (anchor === "center") return { x: 0.5, y: 0.5 };
  const [y, x] = anchor.split("-") as [AnchorAxisY, AnchorAxisX];
  return { x: AXIS_X_FRACTION[x], y: AXIS_Y_FRACTION[y] };
}

// WK-122 §19 - the non-interactive half of apps/web's `AnchoredWidget`
// (anchored-widget.tsx): turns `layout.xVw/yVh/scale/anchor` into a real
// `left`/`top` position within the scene, the same math the web overlay's
// live renderer and its drag-editor both already share - just without the
// drag/snap machinery, which only the web editor (a mouse-driven UI) needs.
// `sceneWidth`/`sceneHeight` are the SAME 1920x1080 logical scene Scene.tsx
// already scales into real pixels.
export function AnchoredBox({
  layout,
  sceneWidth,
  sceneHeight,
  children,
}: {
  layout: OverlayWidgetLayout;
  sceneWidth: number;
  sceneHeight: number;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!layout.visible) return null;

  const frac = anchorFraction(layout.anchor);
  const anchorPointXPx = (layout.xVw / 100) * sceneWidth;
  const anchorPointYPx = (layout.yVh / 100) * sceneHeight;
  const scaledWidth = size.width * layout.scale;
  const scaledHeight = size.height * layout.scale;
  const left = anchorPointXPx - frac.x * scaledWidth;
  const top = anchorPointYPx - frac.y * scaledHeight;

  return (
    <div style={{ position: "absolute", left, top }}>
      <div ref={contentRef} style={{ display: "inline-block", transform: `scale(${layout.scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
