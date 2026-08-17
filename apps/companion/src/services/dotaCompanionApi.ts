
export interface TwitchChatMessage {
  id: string;
  author: string;
  color: string | null;
  text: string;
  badges: string[];
  messageType: string;
  receivedAt: string;
}
export type TwitchChatState = "connected" | "reconnecting" | "reauth_required" | "unavailable";
export interface TwitchChatStatus {
  accountConnected: boolean;
  configured: boolean;
  displayName: string | null;
  connected: boolean;
  state: TwitchChatState;
  messages: TwitchChatMessage[];
}
import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticsStatusSnapshot, ObsConfig, StatusSnapshot } from "../types/status";

export const getStatus = () => invoke<StatusSnapshot>("get_status");
export const findDota = () => invoke<StatusSnapshot>("find_dota");
export const pickDotaFolder = () => invoke<StatusSnapshot>("pick_dota_folder");
export const installGsi = () => invoke<StatusSnapshot>("install_gsi");
export const openLogsFolder = () => invoke<void>("open_logs_folder");
export const openDotaFolder = () => invoke<void>("open_dota_folder");
export const clearLog = () => invoke<StatusSnapshot>("clear_log");
export const saveCompanionToken = (token: string) =>
  invoke<StatusSnapshot>("save_companion_token", { token });
export const getTwitchChat = () => invoke<TwitchChatStatus>("get_twitch_chat");
export const openTwitchSettings = () => invoke<void>("open_twitch_settings");

export type PiperTtsEngineState = "notStarted" | "starting" | "ready" | "crashed" | "unavailable";
export interface PiperTtsStatus {
  enabled: boolean;
  state: PiperTtsEngineState;
  lastError: string | null;
  resourcesReady: boolean;
}
export const getPiperTtsStatus = () => invoke<PiperTtsStatus>("get_tts_status");
export const setPiperTtsEnabled = (enabled: boolean) =>
  invoke<PiperTtsStatus>("set_tts_enabled", { enabled });
// Returns base64-encoded WAV bytes - Tauri's default JSON IPC would blow up
// a raw Vec<u8> into one JSON number per byte (~3-4x the payload size for
// a synthesized clip), base64 is far cheaper to transport for this size.
export const synthesizePiperTts = (text: string) => invoke<string>("synthesize_piper_tts", { text });
export const resendCurrentState = () =>
  invoke<StatusSnapshot>("resend_current_state");
export const saveObsConfig = (config: ObsConfig) =>
  invoke<StatusSnapshot>("save_obs_config", { config });
export const testObsConnection = () =>
  invoke<string[]>("test_obs_connection");
export const switchObsScene = (scene: "betweenMatches" | "draft" | "gameplay") =>
  invoke<StatusSnapshot>("switch_obs_scene", { scene });

// Diagnostic-mode GSI capture - off by default, see src-tauri/src/diagnostics.
export const diagnosticsGetStatus = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_get_status");
export const diagnosticsStart = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_start");
export const diagnosticsStop = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_stop");
export const diagnosticsClear = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_clear");
export const diagnosticsExport = () => invoke<string>("diagnostics_export");
