export interface LastEvent {
  timestamp: string;
  remote_addr: string;
  summary: string;
}

export interface DiagnosticsStatusSnapshot {
  active: boolean;
  has_session: boolean;
  session_id: string | null;
  started_at: string | null;
  request_count: number;
  snapshot_count: number;
  error_count: number;
  observed_game_states: string[];
  observed_match_ids: string[];
  bytes_written: number;
  size_limit_bytes: number;
  size_limit_reached: boolean;
  tts_trace_count: number;
}

export type ConnectionState = "waiting" | "connected" | "recovering" | "unavailable";

export interface StatusSnapshot {
  dota_found: boolean;
  dota_path: string | null;
  dota_source: "auto" | "manual" | null;
  gsi_installed: boolean;
  gsi_config_path: string | null;
  server_running: boolean;
  gsi_state: ConnectionState;
  gsi_last_error: string | null;
  server_port: number;
  request_count: number;
  last_event: LastEvent | null;
  log_dir: string | null;
  legacy_cleanup_in_progress: boolean;
  backend_url: string;
  companion_token_configured: boolean;
  backend_state: ConnectionState;
  backend_last_sent_at: string | null;
  backend_last_error: string | null;
  obs_config: ObsConfig;
  obs_connected: boolean;
  obs_state: ConnectionState;
  obs_active_scene: "betweenMatches" | "draft" | "gameplay" | "postStream" | null;
  obs_last_error: string | null;
  // WK-112 - OBS's own last-known streaming truth, separate from
  // obs_state/obs_connected above (connectivity vs. streaming - see
  // obs.rs). `null` until the stream-state watcher has learned it at least
  // once (e.g. OBS unreachable since Companion started).
  obs_streaming: boolean | null;
  // WK-114 - "Итоги стрима": true while the user has manually pinned OBS to
  // Post Stream without ending the local session (see obs.rs's
  // `resolve_desired_scene`). Purely a display concern for the shell's
  // "Вернуться к трансляции" affordance.
  obs_manual_summary_active: boolean;
  // WK-124 - global runtime visibility override for the local overlay
  // renderer (see src-tauri/src/commands.rs's toggle_overlay_visible). This
  // is NOT BroadcastState - it only controls whether the Browser Source's
  // final rendered output is transparent; scene resolution keeps running
  // unaffected. In-memory only: always `true` on a fresh Companion process.
  overlay_visible: boolean;
  companion_version: string;
}

// WK-112 - OBS-driven local stream lifecycle (see local_runtime::lifecycle).
export type LifecycleSessionState = "none" | "open" | "pending_end" | "needs_manual_recovery";

export interface LifecycleStatus {
  session_state: LifecycleSessionState;
  session_started_at: string | null;
  pending_end_at: string | null;
  obs_streaming: boolean | null;
  // WK-122 P0 diagnostics - last time the OBS stream-state watcher actually
  // confirmed streaming truth (event, initial fetch, or heartbeat re-probe).
  obs_streaming_confirmed_at: string | null;
}

// WK-122 §7 - Companion account (email/password login), replacing the
// copy/paste Companion Token. Mirrors backend::AccountStatus/AccountMethod
// field-for-field - never carries the token/refresh-token/password.
export type AccountMethod = "none" | "session" | "legacy_token";

export interface AccountStatus {
  connected: boolean;
  method: AccountMethod;
  email: string | null;
}

// WK-122 §17-19 - mirrors apps/api's stream-overlay-layout-service.ts
// (OVERLAY_ANCHORS/OverlayWidgetLayout) for the subset Companion's editor
// actually edits: the session/recentMatches widgets in gameplay
// scenes (the only two widgets the local renderer visualizes - see
// overlay-renderer/OverlayApp.tsx). `OverlayLayoutDoc` intentionally keeps
// every other real field (cameraZone, minimapCover, recentMatches/
// companionStatus widgets, draftProtection, aspectRatio, version) as
// untyped passthrough via the index signatures - the editor must round-trip
// them byte-for-byte on save, never reconstruct the document from just the
// fields it understands (apps/api's normalizeOverlayLayout falls back to
// DEFAULTS for anything missing from a PUT body, not to what was already
// saved - a naive "only send what I edited" save would silently wipe
// everything else).
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
  };
}

// WK-114 - local-first Home page data (session MMR/W-L/current+recent
// matches), mirrors local_runtime::summary's Rust structs field-for-field.
export type LocalMatchResultValue = "win" | "loss" | "abandon";
export type LocalRankedModeValue = "unknown" | "ranked" | "unranked";
export type LocalMatchStateValue = "in_progress" | "post_game_pending" | "finalized" | "needs_review" | "interrupted";

export interface LocalMatchSummary {
  localId: string;
  matchId: string | null;
  heroId: number;
  result: LocalMatchResultValue | null;
  rankedMode: LocalRankedModeValue;
  rankedModeDetected: LocalRankedModeValue;
  state: LocalMatchStateValue;
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

// WK-140 - Hero Detail's local statistics zone: a device-wide, per-hero
// aggregate (not session-scoped like LocalSessionSummary above), mirrors
// local_runtime::summary::HeroLocalStats field-for-field. Explicitly local/
// Companion-observed data, not lifetime Dota stats - see HeroDetailPage.
export interface HeroLocalStats {
  matches: number;
  wins: number;
  losses: number;
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
  recentResults: LocalMatchResultValue[];
}

export interface SyncOutboxStatus {
  pendingCount: number;
  retryingCount: number;
  failedCount: number;
  oldestPendingAt: string | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

// WK-126 - Diagnostics v2: RuntimeHealth, the one canonical read-only
// projection of Local Runtime/Integrations/Cloud health. Mirrors
// src-tauri/src/runtime_health.rs field-for-field - see that module's doc
// comment for the full status semantics (healthy/degraded/unavailable/
// disabled/unknown) and aggregation rules.
export type HealthStatusValue = "healthy" | "degraded" | "unavailable" | "disabled" | "unknown";

export interface HealthComponent {
  status: HealthStatusValue;
  reason: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
}

export interface LocalRuntimeHealth {
  status: HealthStatusValue;
  gsi: HealthComponent;
  localSession: HealthComponent;
  sqlite: HealthComponent;
  // WK-127 - the local runtime DB's own PRAGMA user_version; null iff
  // `sqlite` above isn't healthy (no open connection to read it from).
  sqliteSchemaVersion: number | null;
  overlayServer: HealthComponent;
}

export interface IntegrationsHealth {
  status: HealthStatusValue;
  obs: HealthComponent;
  obsSceneAutomation: HealthComponent;
  twitch: HealthComponent;
  tts: HealthComponent;
  gameSounds: HealthComponent;
}

export interface CloudHealth {
  status: HealthStatusValue;
  backend: HealthComponent;
  sync: HealthComponent;
  account: HealthComponent;
}

export interface RuntimeHealth {
  schemaVersion: number;
  generatedAt: string;
  app: { version: string; platform: string };
  localRuntime: LocalRuntimeHealth;
  integrations: IntegrationsHealth;
  cloud: CloudHealth;
}

export interface ObsConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  between_matches_scene: string;
  draft_scene: string;
  gameplay_scene: string;
  // WK-99 - fourth scene binding, on equal footing with the other three -
  // the real OBS scene Companion switches to once the stream session
  // becomes `ended` (see obs.rs's BroadcastScene::PostStream).
  post_stream_scene: string;
}
