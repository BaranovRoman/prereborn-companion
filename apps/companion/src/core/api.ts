import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";
import type { AccountStatus, TwitchChatStatus, TwitchIntegrationStatus, SileroTtsStatus, SileroVoice, TtsTraceEventInput, SkipHotkeyStatus } from "./contracts";
export type * from "./contracts";

// Stock Update owns signature/download/install behavior and resource lifecycle.
// Native check adds only the host-generation before-exit fence, with the same
// configured endpoint, key and default version comparator.
export async function checkCompanionUpdate():Promise<Update|null>{
  const metadata=await invoke<ConstructorParameters<typeof Update>[0]|null>("check_companion_update");
  return metadata?new Update(metadata):null;
}

// Companion account commands never expose the persisted credentials.
export const getAccountStatus = () => invoke<AccountStatus>("get_account_status");
export const accountLogin = (email: string, password: string) =>
  invoke<AccountStatus>("account_login", { email, password });
export const accountLogout = () => invoke<AccountStatus>("account_logout");

export const getTwitchChat = () => invoke<TwitchChatStatus>("get_twitch_chat");

export const getTwitchIntegrationStatus = () =>
  invoke<TwitchIntegrationStatus>("get_twitch_integration_status");
// WK-149 - connect opens the provider's OAuth URL (fetched from the backend)
// in the system browser, same as Steam's connectSteam/openStreamSettings;
// disconnect hits the existing DELETE endpoint directly, same as Steam's
// disconnectSteam.
export const connectTwitch = () => invoke<void>("connect_twitch");
export const disconnectTwitch = () => invoke<void>("disconnect_twitch");

export const getSileroTtsStatus = () => invoke<SileroTtsStatus>("get_silero_status");
export const setSileroTtsEnabled = (enabled: boolean) =>
  invoke<SileroTtsStatus>("set_silero_enabled", { enabled });
export const setSileroVoice = (voice: SileroVoice) =>
  invoke<SileroTtsStatus>("set_silero_voice", { voice });
// Returns base64-encoded WAV bytes. messageId is diagnostics-only; omitting
// it does not change synthesis. System speechSynthesis fallback stays in chat.
export const synthesizeSileroTts = (text: string, voice: SileroVoice, messageId?: string) =>
  invoke<string>("synthesize_silero_tts", { text, voice, messageId });

// TTS pipeline diagnostics trace - the frontend-owned half (queue/playback
// stage timestamps; the Rust/Silero side writes its own half directly from
// silero.rs). No-op unless a diagnostics session is active
// (diagnostics::observe_tts_stage), so this is safe to call unconditionally
// - callers should fire-and-forget it (`void diagnosticsTraceTtsFrontend(...)`)
// rather than await it, so a diagnostics IPC round-trip can never add
// latency to the TTS path it's measuring.
export const diagnosticsTraceTtsFrontend = (event: TtsTraceEventInput) =>
  invoke<void>("diagnostics_trace_tts_frontend", { event });
// Global "skip current TTS" hotkey (WK-83 - see src-tauri/src/hotkeys.rs).
// The hotkey press itself arrives as a "hotkeys://skip-tts" event (listened
// for in useTwitchChatSession.ts), not through these commands - these only
// read/change which combo is registered.
export const getSkipHotkeyStatus = () => invoke<SkipHotkeyStatus>("get_skip_hotkey_status");
export const setSkipHotkey = (enabled: boolean, shortcut: string) =>
  invoke<SkipHotkeyStatus>("set_skip_hotkey", { enabled, shortcut });

export const openStreamSettings = () => invoke<void>("open_stream_settings");
export const getSteamIntegrationStatus = () => invoke<import("./contracts").SteamIntegrationStatus>("get_steam_integration_status");
export const disconnectSteam = () => invoke<void>("disconnect_steam");
export const getDonationAlertsIntegrationStatus = () => invoke<import("./contracts").DonationAlertsIntegrationStatus>("get_donation_alerts_integration_status");
export const connectDonationAlerts = () => invoke<void>("connect_donation_alerts");
export const disconnectDonationAlerts = () => invoke<void>("disconnect_donation_alerts");

// WK-178 - Twitch clip hotkey (see src-tauri/src/clips.rs). Progress of a
// clip started by the global hotkey arrives as "clips://state" events.
export const CLIPS_STATE_EVENT = "clips://state";
export const getClipsStatus = () => invoke<import("./contracts").ClipsStatus>("get_clips_status");
export const getClipsAccess = () => invoke<import("./contracts").ClipsAccess>("get_clips_access");
export const setClipsHotkey = (enabled: boolean, shortcut: string) =>
  invoke<import("./contracts").ClipsStatus>("set_clips_hotkey", { enabled, shortcut });
export const setClipDuration = (durationSeconds: number) =>
  invoke<import("./contracts").ClipsStatus>("set_clip_duration", { durationSeconds });
export const createClipNow = () => invoke<boolean>("create_clip_now");
export const openClip = (id: string) => invoke<void>("open_clip", { id });
export const clearClipsHistory = () => invoke<import("./contracts").ClipsStatus>("clear_clips_history");
