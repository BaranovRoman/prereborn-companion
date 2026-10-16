// Existing overlay editor documents, moved intact; unknown fields round-trip.
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
  [key: string]: unknown;
}

export interface RecentMatchesWidgetLayout extends OverlayWidgetLayout {
  recentMatches: {
    limit: number;
    source: "current-stream" | "recent-matches";
    direction: "newest-first" | "oldest-first";
    compact: boolean;
  };
}

export interface MinimapCoverSettings {
  enabled: boolean;
  preset: "clean" | "random-a" | "random-b" | "random-dense" | "interactive";
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  x: number;
  y: number;
  size: number;
}

export interface CameraZoneSettings {
  enabled: boolean;
  anchor: OverlayAnchor;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftProtectionTextSettings extends OverlayWidgetLayout { content: string; }

export interface OverlaySceneWidgets {
  session: OverlayWidgetLayout;
  recentMatches: RecentMatchesWidgetLayout;
  companionStatus: OverlayWidgetLayout;
}

export interface OverlaySceneLayoutDoc {
  widgets: OverlaySceneWidgets;
  cameraZone: CameraZoneSettings;
  minimapCover: MinimapCoverSettings;
}

export interface OverlayLayoutDoc {
  version: number;
  scenes: {
    draft: OverlaySceneLayoutDoc;
    gameplay: OverlaySceneLayoutDoc;
    [key: string]: unknown;
  };
  draftProtection: { mode: "off" | "cover"; text: DraftProtectionTextSettings };
  aspectRatio: { preset: string; widthRatio: number; heightRatio: number; width: number; height: number };
}

export interface QueueSettingsDoc {
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
    // WK-157 - lets a streamer disable the Between Matches viewer quiz while
    // the Twitch Extension interaction layer is still being stabilized.
    viewerQuizEnabled: boolean;
  };
}
