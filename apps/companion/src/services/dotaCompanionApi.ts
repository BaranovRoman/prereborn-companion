
export interface TwitchChatMessage {
  id: string;
  author: string;
  // Stable Twitch identity for this chatter, independent of the cosmetic
  // display name in `author` - see the matching comment in
  // apps/api's twitch-eventsub-chat.ts. Nullable: older cached
  // messages/backends may not carry these yet.
  authorId: string | null;
  authorLogin: string | null;
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
import type { DiagnosticsStatusSnapshot, LifecycleStatus, LocalSessionSummary, ObsConfig, StatusSnapshot, SyncOutboxStatus } from "../types/status";
import type { StreamSessionSummary } from "../session/session-prompt";

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

// WK-83 - startup "продолжить прошлый стрим?" prompt.
export const getStreamSession = () => invoke<StreamSessionSummary>("get_stream_session");
export const resetStreamSession = () => invoke<StreamSessionSummary>("reset_stream_session");
// WK-100 - "Завершить стрим" action on the main screen.
export const endStreamSession = () => invoke<StreamSessionSummary>("end_stream_session");

// WK-112 - OBS-driven local stream lifecycle (see local_runtime::lifecycle).
// No "start"/"end" calls here on purpose - normal lifecycle is automatic,
// driven by OBS Start/Stop Streaming; these two actions only ever apply to
// the rare stale-session manual-recovery prompt.
export const getLocalLifecycleStatus = () => invoke<LifecycleStatus>("get_local_lifecycle_status");
export const staleRecoveryContinue = () => invoke<void>("local_lifecycle_stale_continue");
export const staleRecoveryEnd = () => invoke<void>("local_lifecycle_stale_end");

// WK-114 - read-only local session/match/MMR data for Главная.
export const getLocalSessionSummary = () => invoke<LocalSessionSummary>("get_local_session_summary");

// WK-119 - read-only sync_outbox visibility (pending/dead-lettered counts).
export const getSyncOutboxStatus = () => invoke<SyncOutboxStatus>("get_sync_outbox_status");

// WK-81 - local Silero TTS sidecar, the primary (and, since WK-80 removed
// Piper, only local) synthesis engine - system speechSynthesis is the
// fallback, handled entirely on the frontend (see useTwitchChatSession.ts).
// Returns base64-encoded WAV bytes - Tauri's default JSON IPC would blow up
// a raw Vec<u8> into one JSON number per byte (~3-4x the payload size for
// a synthesized clip), base64 is far cheaper to transport for this size.
// `messageId` is diagnostics-only (see diagnostics_trace_tts_frontend below)
// - omitting it changes nothing about synthesis itself.
export type SileroTtsEngineState = "notStarted" | "starting" | "ready" | "crashed" | "unavailable";
export type SileroVoice = "aidar" | "baya" | "kseniya" | "xenia" | "eugene";
export interface SileroTtsStatus {
  enabled: boolean;
  state: SileroTtsEngineState;
  lastError: string | null;
  resourcesReady: boolean;
  voice: SileroVoice;
}
export const getSileroTtsStatus = () => invoke<SileroTtsStatus>("get_silero_status");
export const setSileroTtsEnabled = (enabled: boolean) =>
  invoke<SileroTtsStatus>("set_silero_enabled", { enabled });
export const setSileroVoice = (voice: SileroVoice) =>
  invoke<SileroTtsStatus>("set_silero_voice", { voice });
export const synthesizeSileroTts = (text: string, voice: SileroVoice, messageId?: string) =>
  invoke<string>("synthesize_silero_tts", { text, voice, messageId });

// TTS pipeline diagnostics trace - the frontend-owned half (queue/playback
// stage timestamps; the Rust/Silero side writes its own half directly from
// silero.rs). No-op unless a diagnostics session is active
// (diagnostics::observe_tts_stage), so this is safe to call unconditionally
// - callers should fire-and-forget it (`void diagnosticsTraceTtsFrontend(...)`)
// rather than await it, so a diagnostics IPC round-trip can never add
// latency to the TTS path it's measuring.
export interface TtsTraceEventInput {
  messageId: string;
  engine?: string;
  stages: Record<string, number>;
  detail?: unknown;
}
export const diagnosticsTraceTtsFrontend = (event: TtsTraceEventInput) =>
  invoke<void>("diagnostics_trace_tts_frontend", { event });
export const resendCurrentState = () =>
  invoke<StatusSnapshot>("resend_current_state");
export const saveObsConfig = (config: ObsConfig) =>
  invoke<StatusSnapshot>("save_obs_config", { config });
export const testObsConnection = () =>
  invoke<string[]>("test_obs_connection");
export const switchObsScene = (scene: "betweenMatches" | "draft" | "gameplay") =>
  invoke<StatusSnapshot>("switch_obs_scene", { scene });

// WK-114 - "Итоги стрима": manual, reversible OBS scene action, independent
// of the local session/OBS-stream lifecycle (see obs.rs's doc comments on
// show_stream_summary_scene/resume_live_scene). Does not start/end anything.
export const showStreamSummaryScene = () => invoke<StatusSnapshot>("show_stream_summary_scene");
export const resumeLiveScene = () => invoke<StatusSnapshot>("resume_live_scene");

// Global "skip current TTS" hotkey (WK-83 - see src-tauri/src/hotkeys.rs).
// The hotkey press itself arrives as a "hotkeys://skip-tts" event (listened
// for in useTwitchChatSession.ts), not through these commands - these only
// read/change which combo is registered.
export interface SkipHotkeyStatus {
  enabled: boolean;
  shortcut: string;
  registered: boolean;
  lastError: string | null;
}
export const getSkipHotkeyStatus = () => invoke<SkipHotkeyStatus>("get_skip_hotkey_status");
export const setSkipHotkey = (enabled: boolean, shortcut: string) =>
  invoke<SkipHotkeyStatus>("set_skip_hotkey", { enabled, shortcut });

// WK-106 - Custom Game Sounds. Types mirror the `#[serde(rename_all =
// "camelCase")]` Rust structs/enums in src-tauri/src/game_sounds - see that
// module's catalog.rs/config.rs/mod.rs for the authoritative shape.
export type GameSoundEventKind = "itemUsed" | "abilityCast";
export type ItemSignal = "cooldown" | "chargesOrConsumed";
// WK-107 - two signals added alongside Techies (real production capture):
// a charge-based ultimate (Proximity Mines) and a toggle ability whose GSI
// `name` itself flips to a "_stop"-suffixed variant while active (Reactive
// Tazer) instead of pulsing a cooldown - see game_sounds/catalog.rs.
export type AbilitySignal = "cooldown" | "charges" | "toggleActivateRename";
// WK-108 - abilities carry a tri-state status instead of a plain boolean:
// `supported` (real production capture proves the signal), `experimental`
// (metadata-plausible, real GSI behavior not verified - see catalog.rs's
// module doc comment for why metadata alone can never earn "supported"),
// `unsupported` (no usable GSI signal exists at all). Items stay a plain
// boolean - that side of the catalog is unchanged by WK-108.
export type AbilityStatus = "supported" | "experimental" | "unsupported";

export interface TrackedItem {
  id: string;
  displayName: string;
  iconUrl: string;
  supported: boolean;
  signal: ItemSignal | null;
  reason: string | null;
}
export interface TrackedAbility {
  id: string;
  displayName: string;
  iconUrl: string;
  status: AbilityStatus;
  signal: AbilitySignal | null;
  // Only set for `toggleActivateRename` abilities - not needed by the UI
  // (bindings always use `id`, the canonical name), present for parity with
  // the Rust catalog shape.
  toggleActiveAlias: string | null;
  reason: string | null;
}
export interface TrackedHero {
  id: string;
  displayName: string;
  iconUrl: string;
  abilities: TrackedAbility[];
}
export interface GameSoundCatalog {
  items: TrackedItem[];
  heroes: TrackedHero[];
}

export interface ManagedSoundAsset {
  id: string;
  fileName: string;
  originalName: string;
  sizeBytes: number;
}
export interface SoundBinding {
  eventId: string;
  kind: GameSoundEventKind;
  assetId: string;
}
export interface GameSoundSettings {
  schemaVersion: number;
  enabled: boolean;
  masterVolume: number;
  bindings: SoundBinding[];
  assets: ManagedSoundAsset[];
}
export interface GameSoundPreviewPayload {
  base64: string;
  mime: string;
}
// Emitted on every detected item/ability transition, independent of the
// master toggle (see game_sounds/mod.rs's handle_gsi) - "event detection
// может продолжать работать" even while audio playback is off.
export interface GameSoundEventNotification {
  kind: GameSoundEventKind;
  id: string;
  timestamp: string;
}
// Emitted only when the master toggle is on AND a binding exists for the
// detected event - the one event useGameSoundEngine.ts actually plays.
export interface GameSoundPlayNotification {
  eventId: string;
  base64: string;
  mime: string;
  volume: number;
  // WK-108 latency addendum - correlates this payload's frontend-side
  // timing stages with Rust's own gsi-received/detected/play-request-emitted
  // stages in the shared rolling log; emittedAtMs is a wall-clock timestamp
  // (same clock source as the frontend's Date.now()) so useGameSoundEngine.ts
  // can measure real IPC/decode/play transit time - see
  // game_sounds/mod.rs's now_ms doc comment.
  correlationId: string;
  emittedAtMs: number;
}

export const getGameSoundCatalog = () => invoke<GameSoundCatalog>("get_game_sound_catalog");
export const getGameSoundSettings = () => invoke<GameSoundSettings>("get_game_sound_settings");
export const updateGameSoundMaster = (enabled: boolean, volume: number) =>
  invoke<GameSoundSettings>("update_game_sound_master", { enabled, volume });
export const setGameSoundBinding = (eventId: string, kind: GameSoundEventKind, assetId: string) =>
  invoke<GameSoundSettings>("set_game_sound_binding", { eventId, kind, assetId });
export const removeGameSoundBinding = (eventId: string) =>
  invoke<GameSoundSettings>("remove_game_sound_binding", { eventId });
// Import + bind happen as one Tauri command (see game_sounds/mod.rs's
// import_and_bind) - a bind failure right after a successful import can
// never leave an orphaned managed file with nothing pointing at it, since
// there's no separate awaited step in between for it to happen in.
export const importAndBindGameSound = (eventId: string, kind: GameSoundEventKind) =>
  invoke<GameSoundSettings>("import_and_bind_game_sound", { eventId, kind });
export const previewGameSound = (assetId: string) =>
  invoke<GameSoundPreviewPayload>("preview_game_sound", { assetId });
// WK-108 latency addendum - fire-and-forget timing breadcrumb, one call per
// pipeline stage useGameSoundEngine.ts observes for an actually-played
// sound (never per GSI tick) - appended to the same shared rolling log as
// the Rust-side stages (see game_sounds/mod.rs's log_frontend_timing).
export const logGameSoundTiming = (correlationId: string, stage: string, elapsedMs: number) =>
  invoke<void>("log_game_sound_timing", { correlationId, stage, elapsedMs: Math.max(0, Math.round(elapsedMs)) });

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
