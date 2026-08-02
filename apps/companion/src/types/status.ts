export interface LastEvent {
  timestamp: string;
  remote_addr: string;
  summary: string;
  payload_file: string;
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
}

export interface StatusSnapshot {
  dota_found: boolean;
  dota_path: string | null;
  dota_source: "auto" | "manual" | null;
  gsi_installed: boolean;
  gsi_config_path: string | null;
  server_running: boolean;
  server_port: number;
  request_count: number;
  last_event: LastEvent | null;
  log_dir: string | null;
  backend_url: string;
  companion_token_configured: boolean;
  backend_connected: boolean;
  backend_last_sent_at: string | null;
  backend_last_error: string | null;
  obs_config: ObsConfig;
  obs_connected: boolean;
  obs_active_scene: "betweenMatches" | "draft" | "gameplay" | null;
  obs_last_error: string | null;
}

export interface ObsConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  between_matches_scene: string;
  draft_scene: string;
  gameplay_scene: string;
}
