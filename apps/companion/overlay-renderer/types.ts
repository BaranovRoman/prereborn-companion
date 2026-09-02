// WK-121 - mirrors apps/companion/src-tauri/src/overlay_server.rs's
// `OverlayStateSnapshot` and
// local_runtime/summary.rs's `LocalSessionSummary`/`LocalMatchSummary`
// field-for-field (serde `rename_all = "camelCase"` on every struct there).
// This is the ONE local overlay wire contract - no second copy of it
// anywhere else in this renderer.
export type BroadcastState = "betweenMatches" | "draft" | "gameplay" | "postStream";
export type MatchResult = "win" | "loss" | "abandon";

export interface LocalMatchSummary {
  localId: string;
  matchId: string | null;
  heroId: number;
  result: MatchResult | null;
  rankedMode: string;
  rankedModeDetected: string;
  state: string;
  ratingBefore: number | null;
  ratingAfter: number | null;
  detectedRatingDelta: number | null;
  ratingDeltaCorrection: number;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  inventory: Array<string | null>;
  startedAt: string;
  finalizedAt: string | null;
}

export interface LocalSessionSummary {
  hasSession: boolean;
  startedAt: string | null;
  ratingStart: number | null;
  ratingCurrent: number | null;
  ratingAdjustment: number;
  sessionDelta: number | null;
  wins: number;
  losses: number;
  currentMatch: LocalMatchSummary | null;
  recentMatches: LocalMatchSummary[];
}

export interface OverlayStateSnapshot {
  scene: BroadcastState;
  updatedAt: string;
  session: LocalSessionSummary;
  // WK-122 §19 - bumps whenever the cached OverlayLayout actually changes;
  // OverlayApp.tsx re-fetches GET /overlay/layout only when this moves,
  // rather than embedding the whole layout blob in every SSE frame.
  layoutVersion: number;
  account: {
    steam?: { connected: boolean; profile: { displayName: string; avatarUrl: string | null; profileUrl: string | null } | null };
    twitch?: { connected: boolean; login?: string; displayName?: string; profileImageUrl?: string | null; live?: { title: string; viewerCount: number; gameName: string } | null; recentFollowers?: Array<{ id: string; name: string }>; recentSubscribers?: Array<{ id: string; name: string; tier: string }> };
    donationAlerts?: { connected: boolean; topDonors?: Array<{ username: string; amount: number; currency: string }> } | null;
  } | null;
  twitchChat: {
    accountConnected: boolean;
    configured: boolean;
    displayName: string | null;
    connected: boolean;
    state: "connected" | "reconnecting" | "reauth_required" | "unavailable";
    messages: Array<{ id: string; author: string; color: string | null; text: string; receivedAt: string }>;
  } | null;
}

// WK-122 §19 - mirrors apps/api's stream-overlay-layout-service.ts (the
// subset this renderer visualizes: session/recentMatches in Gameplay plus
// the scene-specific camera/minimap/draft-protection contracts.
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
  recentMatches: RecentMatchesWidgetLayout;
  companionStatus: OverlayWidgetLayout;
}

export interface RecentMatchesSettings {
  limit: number;
  source: "current-stream" | "recent-matches";
  direction: "newest-first" | "oldest-first";
  compact: boolean;
}

export interface RecentMatchesWidgetLayout extends OverlayWidgetLayout {
  recentMatches: RecentMatchesSettings;
}

export interface OverlayAspectRatio {
  preset: "16:9" | "16:10" | "21:9" | "32:9" | "4:3" | "custom";
  widthRatio: number;
  heightRatio: number;
  width: number;
  height: number;
}

export interface MinimapCoverSettings {
  enabled: boolean;
  preset: "clean" | "random-a" | "random-b" | "random-dense" | "interactive";
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  x: number;
  y: number;
  size: number;
}

export interface CameraZone {
  enabled: boolean;
  anchor: OverlayAnchor;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftProtectionTextSettings extends OverlayWidgetLayout {
  content: string;
}

export interface OverlaySceneLayout {
  widgets: OverlaySceneWidgets;
  cameraZone: CameraZone;
  minimapCover: MinimapCoverSettings;
}

export interface OverlayLayout {
  version: number;
  scenes: {
    draft: OverlaySceneLayout;
    gameplay: OverlaySceneLayout;
  };
  aspectRatio: OverlayAspectRatio;
  draftProtection: {
    mode: "off" | "cover";
    text: DraftProtectionTextSettings;
  };
}

export interface QueueSettings {
  version: number;
  visibility: Record<"playerProfile" | "streamProfile" | "featuredMatch" | "webcam" | "favoriteHeroes" | "recentGames" | "twitchChat" | "systemStatus", boolean>;
  favoriteHeroIds: number[];
  webcamImageUrl: string | null;
  channelGoal: { type: "none" | "rating" | "custom"; label: string; startValue: number; targetValue: number };
  widgets: {
    titles: Record<"playerProfile" | "streamProfile" | "featuredMatch" | "webcam" | "favoriteHeroes" | "recentGames" | "twitchChat" | "friends", string>;
    recentGamesLimit: number;
    chatMessagesLimit: number;
    friends: { showDonaters: boolean; showSubscribers: boolean; showFollowers: boolean; socialLinks: Array<{ id: string; platform: string; label: string; url: string }> };
  };
}
