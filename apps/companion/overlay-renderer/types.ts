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
}
