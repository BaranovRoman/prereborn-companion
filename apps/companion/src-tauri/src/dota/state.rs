use std::time::Instant;
use crate::broadcast_state::BroadcastState;
use crate::obs::{BroadcastScene, ObsConfig};
use crate::state::LastEvent;

#[derive(Debug, Default)]
pub struct DotaState {

    pub dota_path: Option<String>,
    pub dota_source: Option<String>,
    pub gsi_installed: bool,
    pub gsi_config_path: Option<String>,
    pub server_running: bool,
    pub gsi_last_error: Option<String>,
    pub gsi_last_received_at: Option<Instant>,
    pub request_count: u32,
    pub last_event: Option<LastEvent>,
    // Последнее распарсенное (valid JSON) GSI-состояние - независимо от
    // того, было ли оно уже отправлено. `dirty` отличает "есть новое,
    // ещё не отправленное состояние" (используется фоновым троттлингом раз
    // в ~1с) от "отправить то же самое состояние ещё раз" (ручная кнопка
    // Resend всегда шлёт last_gsi_payload, даже если dirty=false).
    pub last_gsi_payload: Option<serde_json::Value>,
    pub dirty: bool,
    // Monotonic generation of last_gsi_payload. The sender records the
    // generation it started sending and only clears dirty if no newer GSI
    // payload arrived while the HTTP request was in flight.
    pub payload_version: u64,
    pub obs_config: ObsConfig,
    pub obs_connected: bool,
    pub obs_active_scene: Option<BroadcastScene>,
    pub obs_active_scene_name: Option<String>,
    pub obs_switch_pending: Option<BroadcastScene>,
    pub obs_retry_scene: Option<BroadcastScene>,
    pub obs_retry_attempt: u32,
    pub obs_retry_at: Option<Instant>,
    pub obs_last_checked_at: Option<Instant>,
    pub obs_check_pending: bool,
    pub obs_last_error: Option<String>,
    // WK-126 - RuntimeHealth: the stream-state watcher (obs.rs's
    // start_stream_state_watcher) is a SECOND, independent OBS WebSocket
    // connection that runs unconditionally (see its own WK-116 doc comment),
    // unlike `obs_connected` above, which only ever gets probed when scene
    // automation is enabled. Without this, RuntimeHealth's OBS component
    // would incorrectly read "unknown/unavailable" whenever automation is
    // off even though OBS is actually reachable - these two fields expose
    // that watcher's own connectivity truth, mirroring `obs_connected`/
    // `obs_last_error`'s shape but sourced from the other socket.
    pub obs_watcher_connected: bool,
    pub obs_watcher_last_error: Option<String>,
    // WK-99, now set by local_runtime::lifecycle::apply (WK-113) whenever
    // the local, OBS-driven session lifecycle finalizes an end/start - no
    // longer by a backend poll (see backend/mod.rs's removed
    // poll_session_state). Also still set by the legacy manual "Завершить
    // стрим" button on success (backend::end_stream_session). Read by
    // obs::resolve_desired_scene. Defaults to `false` (Default derive),
    // matching "unknown session state behaves like active" - automation
    // runs normally until told otherwise, never the reverse.
    pub session_ended: bool,
    // WK-106 - Custom Game Sounds. Persisted settings/bindings/managed asset
    // registry (see game_sounds/config.rs), loaded once at startup
    // (game_sounds::init) and kept here the same way obs_config is. The
    // detector's diff baseline is deliberately *not* persisted - it lives
    // only in memory, so every Companion restart (and every hero-swap reset,
    // see events::hero_identity_changed) starts from `None`/"no previous
    // snapshot", which is exactly the initial-snapshot-safety the task
    // requires: nothing on the very first tick is ever treated as a new
    // item/ability use.
    pub game_sounds_settings: crate::game_sounds::config::GameSoundSettings,
    pub game_sounds_previous_gsi: Option<serde_json::Value>,
    // WK-138 - item-vanish candidates awaiting bounded multi-tick
    // confirmation (see game_sounds::events::PendingConfirmations). In
    // memory only, same lifecycle as `game_sounds_previous_gsi` immediately
    // above: reset on every Companion restart and on every hero-identity
    // change (see game_sounds::mod's handle_gsi), so a candidate can never
    // resolve into a ghost event against a different match's inventory.
    pub game_sounds_pending_item_confirmations: crate::game_sounds::events::PendingConfirmations,
    // WK-112 - see the field doc on StatusSnapshot::obs_streaming above.
    pub obs_streaming: Option<bool>,
    // WK-122 P0 diagnostics - see the field doc on
    // StatusSnapshot::obs_streaming_confirmed_at above.
    pub obs_streaming_confirmed_at: Option<String>,
    // WK-136 - "Стрим не запущен" Draft reminder (see draft_reminder.rs).
    // `draft_reminder_last_state` is the raw GSI-derived BroadcastState as of
    // the previous tick (not `broadcast_state::resolve()`'s session-ended/
    // manual-override-adjusted value - "entered Draft" is a game-state fact,
    // independent of stream/session bookkeeping), diffed against the current
    // tick to detect a fresh non-Draft -> Draft transition. `draft_reminder_fired`
    // latches once the reminder has fired for the current Draft, and is
    // cleared the moment we leave Draft (any other state), so the very next
    // real Draft can fire again - see draft_reminder.rs's should_fire.
    pub draft_reminder_last_state: Option<BroadcastState>,
    pub draft_reminder_fired: bool,
    // WK-114 - "Итоги стрима" manual scene pin (see obs.rs's
    // `resolve_desired_scene`): while true, every automatic scene resolution
    // (GSI ticks, remote commands, config reapply) resolves to Post Stream
    // instead of the normally-derived scene, exactly like `session_ended`
    // already does - this is a second, independent reason to force Post
    // Stream, not a replacement for it. Cleared automatically whenever a new
    // local session starts (`obs::handle_session_state(_, false)`) so it can
    // never leak into the next stream, and manually via `resume_live_scene`.
    // Defaults to `false` (Default derive) - automation is unaffected until
    // the user explicitly asks to see the summary scene.
    pub obs_manual_summary_override: bool,
    // WK-115 audit - Post Stream is an optional OBS binding: the streamer
    // may never have created that scene in OBS at all. Set by
    // obs::schedule_switch when a switch to Post Stream fails specifically
    // because OBS reports the mapped scene doesn't exist (obs-websocket
    // RESOURCE_NOT_FOUND, see obs::is_resource_not_found) - from then on,
    // obs::resolve_desired_scene falls back to BetweenMatches instead of
    // repeatedly retrying a switch that can only fail the same way, so an
    // ended/manually-pinned session never leaves OBS stuck on a stale
    // gameplay/draft scene just because Post Stream isn't set up. Cleared
    // by obs::handle_session_state on the next local session start and by
    // commands::save_obs_config, so fixing the scene (or the mapping) gets
    // a fresh attempt without requiring a Companion restart. Defaults to
    // `false` (Default derive) - unaffected until a real "scene not found"
    // failure is observed.
    pub obs_post_stream_unavailable: bool,
    // WK-153 P0 - see StatusSnapshot::overlay_server_running/overlay_last_error's
    // doc comment. Written only by overlay_server.rs's init() (the bind-retry
    // supervisor), same single-writer shape as server_running/gsi_last_error.
    pub overlay_server_running: bool,
    pub overlay_last_error: Option<String>,
    // WK-122 §19 - OverlayLayout cache. Kept as an opaque `serde_json::Value`
    // (same "pass through untyped" pattern `last_gsi_payload`/
    // `get_stream_session`'s return type already use in this codebase) since
    // Rust never needs to interpret individual widget fields - it only
    // fetches/caches/serves the same JSON blob apps/api's
    // `/account/me/overlay-layout` and `/companion/overlay-layout` already
    // exchange with a real browser editor. `overlay_layout_version` is
    // bumped on every successful fetch/save so overlay_server.rs's SSE
    // stream (already pushing OverlayStateSnapshot on every scene change)
    // can tell the local renderer "the layout changed, re-fetch it" without
    // a second push channel.
    pub overlay_layout: Option<serde_json::Value>,
    pub overlay_layout_version: u64,
    pub queue_settings: Option<serde_json::Value>,
    pub account_overlay_data: Option<serde_json::Value>,
    // WK-148 - Between Matches OpenDota enrichment (favorite-hero lifetime/
    // patch line + "ПРОФИЛЬ ИГРОКА" радар) for the LOCAL renderer
    // (127.0.0.1:3666/overlay), which has no Tauri IPC access (see
    // opendota_overlay_cache.rs) - populated by that module's background
    // poll loop, read synchronously by overlay_server.rs's snapshot builder.
    // Same "opaque serde_json::Value, Rust never interprets fields" pattern
    // as queue_settings/account_overlay_data above.
    pub opendota_favorite_heroes: Option<serde_json::Value>,
    pub opendota_radar: Option<serde_json::Value>,
    // WK-116 - Between Matches quiz round state, populated by
    // quiz_overlay.rs's background poll (same "opaque serde_json::Value,
    // Rust never interprets fields, the renderer owns the typed DTO"
    // pattern as opendota_favorite_heroes/opendota_radar above). `None`
    // whenever there is no active round (never in Between Matches, or the
    // active round was just cancelled - quiz_overlay.rs clears this
    // immediately on leaving, not waiting for the next poll response).
    pub quiz: Option<serde_json::Value>,
    pub last_history_log_signature: Option<String>,
    // WK-124 - global runtime visibility override for the local overlay
    // renderer: OFF makes the final renderer output fully transparent
    // without touching BroadcastState, the local overlay server, SSE, GSI,
    // LocalSession, OBS scene automation, or any other runtime subsystem -
    // see overlay_server.rs's OverlayStateSnapshot and
    // commands::toggle_overlay_visible. Deliberately in-memory only (not
    // persisted to SQLite/config/localStorage): a fresh Companion process
    // always starts with the overlay visible, so a streamer can never begin
    // a new stream with an unexpectedly hidden Browser Source just because
    // they forgot to turn it back on last time. `#[derive(Default)]` above
    // gives this `false`; `AppState::new()` below explicitly forces it to
    // `true` immediately after construction so the derive's per-field
    // default never has to special-case one bool among many.
    pub overlay_visible: bool,
}
