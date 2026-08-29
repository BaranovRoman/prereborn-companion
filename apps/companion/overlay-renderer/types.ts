// WK-121 - mirrors apps/companion/src-tauri/src/overlay_server.rs's
// `OverlayStateSnapshot`/`CurrentGameSnapshot` and
// local_runtime/summary.rs's `LocalSessionSummary`/`LocalMatchSummary`
// field-for-field (serde `rename_all = "camelCase"` on every struct there).
// This is the ONE local overlay wire contract - no second copy of it
// anywhere else in this renderer.
export type BroadcastState = "betweenMatches" | "draft" | "gameplay" | "postStream";
export type MatchResult = "win" | "loss" | "abandon";

export interface LocalMatchSummary {
  matchId: string | null;
  heroId: number;
  result: MatchResult | null;
  rankedMode: string;
  state: string;
  ratingBefore: number | null;
  ratingAfter: number | null;
  startedAt: string;
  finalizedAt: string | null;
}

export interface LocalSessionSummary {
  hasSession: boolean;
  startedAt: string | null;
  ratingStart: number | null;
  ratingCurrent: number | null;
  wins: number;
  losses: number;
  currentMatch: LocalMatchSummary | null;
  recentMatches: LocalMatchSummary[];
}

export interface CurrentGameSnapshot {
  heroId: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

export interface OverlayStateSnapshot {
  scene: BroadcastState;
  updatedAt: string;
  session: LocalSessionSummary;
  currentGame: CurrentGameSnapshot | null;
  // WK-122 §19 - bumps whenever the cached OverlayLayout actually changes;
  // OverlayApp.tsx re-fetches GET /overlay/layout only when this moves,
  // rather than embedding the whole layout blob in every SSE frame.
  layoutVersion: number;
}

// WK-122 §19 - mirrors apps/api's stream-overlay-layout-service.ts (the
// subset this renderer actually visualizes: session/currentGame widgets in
// the draft/gameplay scenes - recentMatches/companionStatus aren't rendered
// by this renderer yet, cameraZone/minimapCover/draftProtection are a
// broadcast-composition concern for a future slice, not a widget position).
export type OverlayAnchor =
  | "top-left" | "top-center" | "top-right"
  | "center-left" | "center" | "center-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export interface OverlayWidgetLayout {
  xVw: number;
  yVh: number;
  scale: number;
  visible: boolean;
  anchor: OverlayAnchor;
}

export interface OverlaySceneWidgets {
  session: OverlayWidgetLayout;
  currentGame: OverlayWidgetLayout;
}

export interface OverlayLayout {
  version: number;
  scenes: {
    draft: { widgets: OverlaySceneWidgets };
    gameplay: { widgets: OverlaySceneWidgets };
  };
}
