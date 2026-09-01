import type { OverlayLayout } from "./types";

// Mirrors apps/web/src/entities/stream-overlay-layout/model/default-layout.ts
// and the API's DEFAULT_OVERLAY_LAYOUT. The standalone OBS renderer needs
// the same immediate fallback because its Browser Source can load before an
// authenticated layout fetch has populated the Rust cache. Missing config
// must preserve the established enabled widgets, never hide the scene.
const gameplayWidgets: OverlayLayout["scenes"]["gameplay"]["widgets"] = {
  session: { xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" },
  recentMatches: {
    xVw: 3,
    yVh: 22,
    scale: 1,
    visible: true,
    anchor: "top-left",
    recentMatches: {
      limit: 5,
      source: "current-stream",
      direction: "newest-first",
      compact: true,
    },
  },
  companionStatus: { xVw: 3, yVh: 92, scale: 1, visible: true, anchor: "top-left" },
};

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = {
  version: 5,
  scenes: {
    gameplay: {
      widgets: gameplayWidgets,
      cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 },
      minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
    },
    draft: {
      widgets: {
        ...gameplayWidgets,
        recentMatches: {
          ...gameplayWidgets.recentMatches,
          xVw: 3,
          yVh: 70,
          recentMatches: { ...gameplayWidgets.recentMatches.recentMatches },
        },
      },
      cameraZone: { enabled: true, anchor: "bottom-left", x: 60, y: 1013, width: 400, height: 300 },
      minimapCover: { enabled: false, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
    },
  },
  aspectRatio: { preset: "16:9", widthRatio: 16, heightRatio: 9, width: 1920, height: 1080 },
  draftProtection: {
    mode: "cover",
    text: { content: "", xVw: 50, yVh: 88, scale: 1, visible: true, anchor: "bottom-center" },
  },
};
