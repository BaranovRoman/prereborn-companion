import { useEffect, useRef, useState, type ReactNode } from "react";

export const SCENE_WIDTH = 1920;
export const SCENE_HEIGHT = 1080;

// WK-121 - the same cover-fit virtual-canvas scaling apps/web's
// OverlayCanvas uses (apps/web/src/components/pages/overlay/overlay-canvas.tsx):
// a fixed 1920x1080 logical scene (per this task's explicit "Virtual canvas:
// 1920×1080" instruction - no per-user aspect-ratio config on the local
// renderer yet, see docs/research/wk-121-companion-product-consolidation.md),
// scaled with Math.max (cover, not contain) and centered into however many
// real pixels the OBS Browser Source/browser viewport actually gives it, so
// a source that isn't exactly 1920x1080 never leaves an uncovered gap. Ported
// logic, not a shared import - this renderer is a standalone Vite build (see
// vite.overlay-renderer.config.ts), not something that can import a Next.js
// component tree.
export function Scene({ children, sceneWidth = SCENE_WIDTH, sceneHeight = SCENE_HEIGHT }: { children: ReactNode; sceneWidth?: number; sceneHeight?: number }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const scale = Math.max(rect.width / sceneWidth, rect.height / sceneHeight);
      setTransform({
        scale,
        offsetX: (rect.width - sceneWidth * scale) / 2,
        offsetY: (rect.height - sceneHeight * scale) / 2,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sceneWidth, sceneHeight]);

  return (
    <div ref={viewportRef} className="overlay-viewport">
      <div
        className="overlay-scene"
        style={{
          width: sceneWidth,
          height: sceneHeight,
          transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
