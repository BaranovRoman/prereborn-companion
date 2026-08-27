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
  companion_version: string;
}

// WK-112 - OBS-driven local stream lifecycle (see local_runtime::lifecycle).
export type LifecycleSessionState = "none" | "open" | "pending_end" | "needs_manual_recovery";

export interface LifecycleStatus {
  session_state: LifecycleSessionState;
  session_started_at: string | null;
  pending_end_at: string | null;
  obs_streaming: boolean | null;
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
