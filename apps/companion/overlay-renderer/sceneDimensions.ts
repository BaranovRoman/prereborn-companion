import type { OverlayLayout } from "./types";

export const DEFAULT_SCENE_DIMENSIONS = { width: 1920, height: 1080 } as const;

export function resolveSceneDimensions(layout: OverlayLayout | null) {
  const ratio = layout?.aspectRatio;
  if (!ratio || ratio.width <= 0 || ratio.height <= 0) return DEFAULT_SCENE_DIMENSIONS;
  return { width: ratio.width, height: ratio.height };
}
