
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
import type { AccountStatus, DiagnosticsStatusSnapshot, HeroLocalStats, LifecycleStatus, LocalSessionSummary, ObsConfig, OverlayLayoutDoc, QueueSettingsDoc, RuntimeHealth, StatusSnapshot, SyncOutboxStatus } from "../types/status";
import type { StreamSessionSummary } from "../session/session-prompt";

export const getStatus = () => invoke<StatusSnapshot>("get_status");
// WK-126 - Diagnostics v2 canonical health projection (see types/status.ts).
export const getRuntimeHealth = () => invoke<RuntimeHealth>("get_runtime_health");
export const findDota = () => invoke<StatusSnapshot>("find_dota");
export const pickDotaFolder = () => invoke<StatusSnapshot>("pick_dota_folder");
export const installGsi = () => invoke<StatusSnapshot>("install_gsi");
export const openLogsFolder = () => invoke<void>("open_logs_folder");
export const openDotaFolder = () => invoke<void>("open_dota_folder");
export const clearLog = () => invoke<StatusSnapshot>("clear_log");
export const saveCompanionToken = (token: string) =>
  invoke<StatusSnapshot>("save_companion_token", { token });

// WK-122 §7 - Companion account (email/password login), replacing the
// copy/paste Companion Token as the normal user-facing flow.
export const getAccountStatus = () => invoke<AccountStatus>("get_account_status");
export const accountLogin = (email: string, password: string) =>
  invoke<AccountStatus>("account_login", { email, password });
export const accountLogout = () => invoke<AccountStatus>("account_logout");

// WK-122 §17-19 - Оформление editor. `layout` is deliberately typed loosely
// (see types/status.ts's OverlayLayoutDoc) - Companion only interprets the
// session/recentMatches widget fields it actually renders an editor for, and
// must round-trip everything else (cameraZone, minimapCover,
// recentMatches/companionStatus widgets, draftProtection, aspectRatio)
// byte-for-byte, never reconstructing the object from scratch, or a save
// here would silently reset every other field to its default (see
// apps/api's normalizeOverlayLayout - fields missing from the PUT body fall
// back to defaults, not to what was already saved).
export const getOverlayLayout = () => invoke<OverlayLayoutDoc>("get_overlay_layout");
export const saveOverlayLayout = (layout: OverlayLayoutDoc) =>
  invoke<OverlayLayoutDoc>("save_overlay_layout", { layout });
export const getQueueSettings = () => invoke<QueueSettingsDoc>("get_queue_settings");
export const saveQueueSettings = (settings: QueueSettingsDoc) => invoke<QueueSettingsDoc>("save_queue_settings", { settings });
export const chooseQueueWebcamFallback = () => invoke<string>("choose_queue_webcam_fallback");
export const removeQueueWebcamFallback = () => invoke<void>("remove_queue_webcam_fallback");
export const getGameplayReference = () => invoke<string | null>("get_gameplay_reference");
export const chooseGameplayReference = () => invoke<string>("choose_gameplay_reference");
export const removeGameplayReference = () => invoke<void>("remove_gameplay_reference");
export const getTwitchChat = () => invoke<TwitchChatStatus>("get_twitch_chat");
// WK-133 rename - was `openTwitchSettings`: opens the web dashboard's
// `/stream` settings page, where Twitch AND Steam account linking both live
// (see IntegrationsPanel.tsx, which reuses this same call for Steam).
export const openStreamSettings = () => invoke<void>("open_stream_settings");

// WK-83 - startup "продолжить прошлый стрим?" prompt.
export const getStreamSession = () => invoke<StreamSessionSummary>("get_stream_session");
export const resetStreamSession = () => invoke<StreamSessionSummary>("reset_stream_session");
// WK-100 - "Завершить стрим" action on the main screen.
export const endStreamSession = () => invoke<StreamSessionSummary>("end_stream_session");

// WK-121 - "Герои" favorites, same stream_queue_settings.favoriteHeroIds row
// the web cabinet's Favorite Heroes picker owns (see backend/mod.rs's doc
// comment) - not a local-only store.
export const getFavoriteHeroes = () => invoke<number[]>("get_favorite_heroes");
export const saveFavoriteHeroes = (heroIds: number[]) => invoke<number[]>("save_favorite_heroes", { heroIds });

// WK-112 - OBS-driven local stream lifecycle (see local_runtime::lifecycle).
// No "start"/"end" calls here on purpose - normal lifecycle is automatic,
// driven by OBS Start/Stop Streaming; these two actions only ever apply to
// the rare stale-session manual-recovery prompt.
export const getLocalLifecycleStatus = () => invoke<LifecycleStatus>("get_local_lifecycle_status");
export const staleRecoveryContinue = () => invoke<void>("local_lifecycle_stale_continue");
export const staleRecoveryEnd = () => invoke<void>("local_lifecycle_stale_end");

// WK-114 - read-only local session/match/MMR data for Главная.
export const getLocalSessionSummary = () => invoke<LocalSessionSummary>("get_local_session_summary");
// WK-140 - Hero Detail's local statistics zone (device-wide per-hero
// aggregate, distinct from the session-scoped summary above).
export const getHeroLocalStats = (heroId: number) => invoke<HeroLocalStats>("get_hero_local_stats", { heroId });

// WK-133 - Settings → Интеграции + Hero Detail's OpenDota panel. Response
// shapes mirror the backend's product contracts (see apps/api's
// controllers/stream/steam.ts, twitch.ts, opendota.ts) - passed through as
// `serde_json::Value` on the Rust side (same convention as
// getStreamSession/getAccountOverlayData), typed here on the frontend.
export interface SteamIntegrationStatus {
  connected: boolean;
  steamId64?: string;
  connectedAt?: string;
  lastSyncedAt?: string | null;
  lastSyncStatus?: string | null;
  profile?: { displayName: string; avatarUrl: string | null; profileUrl: string | null } | null;
}
export const getSteamIntegrationStatus = () =>
  invoke<SteamIntegrationStatus>("get_steam_integration_status");
export const disconnectSteam = () => invoke<void>("disconnect_steam");

export interface TwitchIntegrationStatus {
  connected: boolean;
  login?: string;
  displayName?: string;
}
export const getTwitchIntegrationStatus = () =>
  invoke<TwitchIntegrationStatus>("get_twitch_integration_status");

export type HeroOpenDotaStats =
  | {
      status: "ok";
      source: "opendota";
      heroId: number;
      games: number;
      wins: number;
      losses: number;
      winRate: number | null;
      fetchedAt: string;
    }
  | { status: "steam_not_connected" }
  | { status: "no_data" }
  | { status: "rate_limited" }
  | { status: "unavailable" };
export const getHeroOpenDotaStats = (heroId: number) =>
  invoke<HeroOpenDotaStats>("get_hero_opendota_stats", { heroId });
export const setCurrentMmr = (rating: number) =>
  invoke<LocalSessionSummary>("set_current_mmr", { rating });

// WK-115 - Dashboard per-match correction. `effectiveDelta: null` clears an
// existing correction, reverting to the match's detected delta.
export const correctLocalMatchDelta = (localId: string, effectiveDelta: number | null) =>
  invoke<LocalSessionSummary>("correct_local_match_delta", { localId, effectiveDelta });

// WK-115 - Dashboard Ranked <-> Unranked correction. `ranked: null` clears
// the override, restoring the match's detected classification.
export const correctLocalMatchRankedMode = (localId: string, ranked: boolean | null) =>
  invoke<LocalSessionSummary>("correct_local_match_ranked_mode", { localId, ranked });

// WK-119 - read-only sync_outbox visibility (pending/dead-lettered counts).
export const getSyncOutboxStatus = () => invoke<SyncOutboxStatus>("get_sync_outbox_status");
// Диагностика "Повторить сейчас" - runs the existing sync worker's own drain
// on demand (see local_runtime::sync::drain_outbox). Returns the fresh
// status so the caller can update immediately, without waiting for the next
// poll tick.
export const triggerSyncDrain = () => invoke<SyncOutboxStatus>("trigger_sync_drain");

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

// WK-121 - OBS Browser Source migration (legacy prereborn.ru overlay URL ->
// local 127.0.0.1:3666/overlay). See obs.rs's BrowserSourceDetection doc
// comment for what each state means.
export type BrowserSourceDetection =
  | { state: "localConnected"; inputName: string }
  | { state: "legacyDetected"; inputName: string; currentUrl: string }
  | { state: "missing" }
  | { state: "ambiguous"; candidates: string[] };
export const detectObsBrowserSource = () =>
  invoke<BrowserSourceDetection>("detect_obs_browser_source");
export const migrateObsBrowserSource = (inputName: string) =>
  invoke<void>("migrate_obs_browser_source", { inputName });

// WK-114 - "Итоги стрима": manual, reversible OBS scene action, independent
// of the local session/OBS-stream lifecycle (see obs.rs's doc comments on
// show_stream_summary_scene/resume_live_scene). Does not start/end anything.
export const showStreamSummaryScene = () => invoke<StatusSnapshot>("show_stream_summary_scene");
export const resumeLiveScene = () => invoke<StatusSnapshot>("resume_live_scene");

// WK-124 - global runtime visibility override for the local overlay
// renderer (see src-tauri/src/commands.rs's toggle_overlay_visible). Purely
// a rendering override: does not touch BroadcastState, OBS, GSI,
// LocalSession, MMR, sync, or the local HTTP/SSE server itself. Toggle-only
// so this same command can later be bound to a hotkey without the caller
// needing to first read current state.
export const toggleOverlayVisible = () => invoke<StatusSnapshot>("toggle_overlay_visible");

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

// WK-135 - global "show/hide overlay" hotkey (see src-tauri/src/hotkeys.rs),
// the primary control for WK-124's overlay visibility switch. Same shape as
// the skip-TTS pair above, but its OS-shortcut callback flips
// InnerState::overlay_visible directly (see toggle_overlay_visible_now) -
// there's no frontend-side event to listen for, only status to read/change.
export interface OverlayToggleHotkeyStatus {
  enabled: boolean;
  shortcut: string;
  registered: boolean;
  lastError: string | null;
}
export const getOverlayToggleHotkeyStatus = () => invoke<OverlayToggleHotkeyStatus>("get_overlay_toggle_hotkey_status");
export const setOverlayToggleHotkey = (enabled: boolean, shortcut: string) =>
  invoke<OverlayToggleHotkeyStatus>("set_overlay_toggle_hotkey", { enabled, shortcut });

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
