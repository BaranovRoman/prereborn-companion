// WK-126 - Diagnostics v2: a single read-only projection of Companion's
// existing subsystem state, normalized into one compact status vocabulary.
//
// This is explicitly NOT a new state machine: every field here is derived
// from state some other module already owns and already updates (GSI's
// `server_running`/`gsi_last_received_at`, OBS's `obs_connected`/
// `obs_watcher_connected`, `local_runtime::sync`'s outbox counters,
// `silero::status`, ...) - this module only reads and normalizes, never
// writes to any of them, and introduces no new retry/backoff/timer of its
// own. See docs/research/wk-126-runtime-health.md for the full source-of-
// truth mapping and status semantics this file implements.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::backend::{self, AccountMethod};
use crate::local_runtime::{lifecycle::LifecycleSessionState, sync::SyncOutboxStatus, LocalRuntimeState};
use crate::overlay_server::OVERLAY_PORT;
use crate::silero::SileroEngineState;
use crate::state::{AppState, ConnectionState, COMPANION_VERSION};
use crate::{game_sounds, local_runtime, silero};

pub const RUNTIME_REPORT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthStatus {
    /// Enabled/expected and working.
    Healthy,
    /// Working partially, or a transient/recoverable problem.
    Degraded,
    /// Expected to be available but is not.
    Unavailable,
    /// Intentionally turned off by the user, or not configured - never a
    /// problem on its own.
    Disabled,
    /// Not enough data to honestly say any of the above.
    Unknown,
}

impl Default for HealthStatus {
    fn default() -> Self {
        HealthStatus::Unknown
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthComponent {
    pub status: HealthStatus,
    pub reason: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error_at: Option<String>,
}

impl HealthComponent {
    fn healthy() -> Self {
        Self { status: HealthStatus::Healthy, ..Default::default() }
    }

    fn disabled(reason: impl Into<String>) -> Self {
        Self { status: HealthStatus::Disabled, reason: Some(reason.into()), ..Default::default() }
    }

    fn degraded(reason: impl Into<String>) -> Self {
        Self { status: HealthStatus::Degraded, reason: Some(reason.into()), ..Default::default() }
    }

    fn unavailable(reason: impl Into<String>) -> Self {
        Self { status: HealthStatus::Unavailable, reason: Some(reason.into()), ..Default::default() }
    }

    fn unknown(reason: impl Into<String>) -> Self {
        Self { status: HealthStatus::Unknown, reason: Some(reason.into()), ..Default::default() }
    }

    fn with_last_success_at(mut self, at: Option<String>) -> Self {
        self.last_success_at = at;
        self
    }

    fn with_last_error_at(mut self, at: Option<String>) -> Self {
        self.last_error_at = at;
        self
    }
}

/// Deterministic aggregation of a group's components into one status.
///
/// `critical` marks a component the group genuinely expects to be working
/// right now (see each call site) - an optional component being merely
/// `Disabled` never affects the group at all, and an optional component
/// actually failing (`Degraded`/`Unavailable`) can only ever pull the group
/// down to `Degraded`, never `Unavailable` - a broken TTS engine must never
/// read the same as a broken GSI listener.
fn aggregate(components: &[(&HealthComponent, bool)]) -> HealthStatus {
    let has = |status: HealthStatus, critical: bool| {
        components.iter().any(|(component, is_critical)| component.status == status && *is_critical == critical)
    };

    if has(HealthStatus::Unavailable, true) {
        HealthStatus::Unavailable
    } else if has(HealthStatus::Degraded, true) {
        HealthStatus::Degraded
    } else if has(HealthStatus::Unavailable, false) || has(HealthStatus::Degraded, false) {
        HealthStatus::Degraded
    } else if has(HealthStatus::Unknown, true) {
        HealthStatus::Unknown
    } else {
        HealthStatus::Healthy
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeHealth {
    pub status: HealthStatus,
    pub gsi: HealthComponent,
    pub local_session: HealthComponent,
    pub sqlite: HealthComponent,
    // WK-127 - the local runtime DB's own `PRAGMA user_version`, `None` iff
    // `sqlite` above isn't healthy (no open connection to query it from).
    // Cheap (one already-open-connection pragma read, no scan) and useful
    // for support to know which schema an install is on without needing
    // app.log - see the SQLite runtime audit doc for what was and wasn't
    // added here.
    pub sqlite_schema_version: Option<i64>,
    pub overlay_server: HealthComponent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsHealth {
    pub status: HealthStatus,
    pub obs: HealthComponent,
    pub obs_scene_automation: HealthComponent,
    pub twitch: HealthComponent,
    pub tts: HealthComponent,
    pub game_sounds: HealthComponent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHealth {
    pub status: HealthStatus,
    pub backend: HealthComponent,
    pub sync: HealthComponent,
    pub account: HealthComponent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub schema_version: u32,
    pub generated_at: String,
    pub app: AppInfo,
    pub local_runtime: LocalRuntimeHealth,
    pub integrations: IntegrationsHealth,
    pub cloud: CloudHealth,
}

// --- LOCAL RUNTIME -----------------------------------------------------

/// C.14 - the GSI listener being bound is what matters; Dota not currently
/// sending anything is completely normal (Companion is healthy between
/// matches, or before Dota is even launched) and must never itself read as
/// a problem.
fn gsi_component(gsi_state: ConnectionState) -> HealthComponent {
    match gsi_state {
        ConnectionState::Connected | ConnectionState::Waiting => HealthComponent::healthy(),
        ConnectionState::Recovering => HealthComponent::degraded("GSI listener bind failing, retrying"),
        ConnectionState::Unavailable => HealthComponent::unavailable("Local GSI listener (:3665) is not running"),
    }
}

/// C.16/C.17 - no open session is a completely normal state (not
/// streaming); only a stale session flagged for manual recovery is an
/// actual actionable problem.
fn local_session_component(session_state: LifecycleSessionState, session_started_at: Option<String>) -> HealthComponent {
    match session_state {
        LifecycleSessionState::None => HealthComponent::healthy(),
        LifecycleSessionState::Open | LifecycleSessionState::PendingEnd => {
            HealthComponent::healthy().with_last_success_at(session_started_at)
        }
        LifecycleSessionState::NeedsManualRecovery => {
            HealthComponent::degraded("Local session is stale and needs manual recovery").with_last_error_at(session_started_at)
        }
    }
}

/// C.18 - a successfully opened connection is healthy; `local_runtime::init`
/// only ever leaves the connection `None` after a real open/migrate
/// failure (logged to app.log at the time) - see that module's own doc
/// comment for why this is deliberately not a retry loop.
fn sqlite_component(local_runtime_open: bool) -> HealthComponent {
    if local_runtime_open {
        HealthComponent::healthy()
    } else {
        HealthComponent::unavailable("Local runtime database failed to open this run (see app.log)")
    }
}

/// C.15 - overlay_visible (WK-124's runtime ON/OFF switch) must never
/// affect this: it only gates the renderer's final visibility, the HTTP
/// server underneath keeps running unaffected either way.
///
/// WK-153 P0 - this used to do a live loopback TCP probe instead of reading
/// `AppState` (see the removed doc comment on why - avoiding a second piece
/// of mutable state). That reasoning was wrong in practice: a bare "is
/// :3666 accepting connections" probe can only ever report a generic
/// "not accepting connections", the exact same non-answer the frontend's
/// own health-endpoint fetch already got - so a real bind failure (port
/// occupied by another process, OS error, ...) surfaced identically to
/// "still starting" or "GSI genuinely down", with no way for the user (or
/// support reading a diagnostics export) to tell them apart. Now mirrors
/// `gsi_component` exactly - `overlay_server::init` is this field's one
/// writer (see its own doc comment), and it already logs the real
/// `io::Error` it got from `tiny_http::Server::http`.
fn overlay_server_component(overlay_state: ConnectionState, overlay_last_error: Option<String>) -> HealthComponent {
    match overlay_state {
        ConnectionState::Connected => HealthComponent::healthy(),
        ConnectionState::Recovering => HealthComponent::unavailable(
            overlay_last_error.unwrap_or_else(|| format!("Local overlay server (127.0.0.1:{OVERLAY_PORT}) bind failing, retrying")),
        ),
        ConnectionState::Waiting | ConnectionState::Unavailable => {
            HealthComponent::unavailable(format!("Local overlay server (127.0.0.1:{OVERLAY_PORT}) has not started yet"))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn local_runtime_health(
    gsi_state: ConnectionState,
    session_state: LifecycleSessionState,
    session_started_at: Option<String>,
    local_runtime_open: bool,
    sqlite_schema_version: Option<i64>,
    overlay_state: ConnectionState,
    overlay_last_error: Option<String>,
) -> LocalRuntimeHealth {
    let gsi = gsi_component(gsi_state);
    let local_session = local_session_component(session_state, session_started_at);
    let sqlite = sqlite_component(local_runtime_open);
    let overlay_server = overlay_server_component(overlay_state, overlay_last_error);
    let status = aggregate(&[(&gsi, true), (&local_session, true), (&sqlite, true), (&overlay_server, true)]);
    LocalRuntimeHealth { status, gsi, local_session, sqlite, sqlite_schema_version, overlay_server }
}

// --- INTEGRATIONS --------------------------------------------------------

/// D.19/D.20 - `obs_connected` (the scene-automation socket) only ever gets
/// probed while automation is enabled (see obs.rs's `retry_pending`), so it
/// alone cannot tell "OBS connected, automation off" apart from "OBS never
/// even checked". `obs_watcher_connected` is sourced from the OTHER OBS
/// socket (obs.rs's `start_stream_state_watcher`), which runs unconditionally
/// - combining both is what lets this stay honest either way, without
/// starting a new connection attempt from here.
fn obs_component(
    obs_connected: bool,
    obs_watcher_connected: bool,
    obs_enabled: bool,
    obs_last_error: Option<String>,
    obs_watcher_last_error: Option<String>,
    obs_streaming_confirmed_at: Option<String>,
) -> HealthComponent {
    if obs_connected || obs_watcher_connected {
        HealthComponent::healthy().with_last_success_at(obs_streaming_confirmed_at)
    } else if obs_enabled {
        let reason = obs_last_error.or(obs_watcher_last_error).unwrap_or_else(|| "OBS not connected".to_string());
        HealthComponent::unavailable(reason)
    } else if let Some(error) = obs_watcher_last_error {
        HealthComponent::degraded(error)
    } else {
        HealthComponent::unknown("OBS connectivity not observed yet this run")
    }
}

/// D.19/D.20 - purely the user's preference for automatic scene switching,
/// never OBS's actual connectivity (that's `obs_component` above) - an OBS
/// outage must always surface on `obs`, never get relabeled as "automation
/// disabled".
fn obs_scene_automation_component(obs_enabled: bool) -> HealthComponent {
    if obs_enabled {
        HealthComponent::healthy()
    } else {
        HealthComponent::disabled("Automatic scene switching is turned off")
    }
}

/// Twitch chat has no typed local state machine (see the audit) - Companion
/// only caches whatever JSON the backend last returned. Best-effort read of
/// that cache's `configured`/`connected`/`state` fields; anything malformed
/// or never-fetched honestly reports `Unknown` rather than guessing.
fn twitch_component(twitch_chat: Option<serde_json::Value>) -> HealthComponent {
    let Some(value) = twitch_chat else {
        return HealthComponent::unknown("No Twitch chat status observed yet this run");
    };
    if value.get("configured").and_then(|v| v.as_bool()) == Some(false) {
        return HealthComponent::disabled("Twitch chat is not configured");
    }
    if value.get("connected").and_then(|v| v.as_bool()) == Some(true) {
        return HealthComponent::healthy();
    }
    match value.get("state").and_then(|v| v.as_str()) {
        Some("reconnecting") => HealthComponent::degraded("Twitch chat reconnecting"),
        Some("reauth_required") => HealthComponent::unavailable("Twitch chat needs re-authorization"),
        Some("unavailable") => HealthComponent::unavailable("Twitch chat unavailable"),
        _ => HealthComponent::unknown("Twitch chat status not recognized"),
    }
}

/// E.21/E.23 - `enabled` alone is never a health signal; `resources_ready`
/// (the installed sidecar/model files) and `state` (the actual engine
/// state machine, see silero.rs) are what decide healthy vs degraded vs
/// unavailable once TTS is turned on at all.
fn tts_component(enabled: bool, resources_ready: bool, state: SileroEngineState, last_error: Option<String>) -> HealthComponent {
    if !enabled {
        return HealthComponent::disabled("TTS is turned off");
    }
    if !resources_ready {
        return HealthComponent::unavailable("TTS resources are not installed");
    }
    match state {
        SileroEngineState::Ready => HealthComponent::healthy(),
        SileroEngineState::Starting => HealthComponent::degraded("TTS engine starting"),
        SileroEngineState::NotStarted => HealthComponent::unknown("TTS engine not attempted yet this run"),
        SileroEngineState::Crashed | SileroEngineState::Unavailable => {
            HealthComponent::unavailable(last_error.unwrap_or_else(|| "TTS engine unavailable".to_string()))
        }
    }
}

/// E.22 - Game Sounds has no persisted runtime error signal at all today
/// (see the audit) - `Unknown` is the honest status once enabled (we can
/// only confirm the user turned it on, not that it's actually working),
/// never a false `Healthy`. A follow-up ticket adding real playback-error
/// tracking (mirroring Silero's shape) would let this become a real
/// healthy/degraded/unavailable component.
fn game_sounds_component(enabled: bool) -> HealthComponent {
    if enabled {
        HealthComponent::unknown("Game Sounds has no runtime health signal yet")
    } else {
        HealthComponent::disabled("Game Sounds is turned off")
    }
}

#[allow(clippy::too_many_arguments)]
fn integrations_health(
    obs_connected: bool,
    obs_watcher_connected: bool,
    obs_enabled: bool,
    obs_last_error: Option<String>,
    obs_watcher_last_error: Option<String>,
    obs_streaming_confirmed_at: Option<String>,
    twitch_chat: Option<serde_json::Value>,
    tts_enabled: bool,
    tts_resources_ready: bool,
    tts_state: SileroEngineState,
    tts_last_error: Option<String>,
    game_sounds_enabled: bool,
) -> IntegrationsHealth {
    let obs = obs_component(obs_connected, obs_watcher_connected, obs_enabled, obs_last_error, obs_watcher_last_error, obs_streaming_confirmed_at);
    let obs_scene_automation = obs_scene_automation_component(obs_enabled);
    let twitch = twitch_component(twitch_chat);
    let tts = tts_component(tts_enabled, tts_resources_ready, tts_state, tts_last_error);
    let game_sounds = game_sounds_component(game_sounds_enabled);
    let status = aggregate(&[
        (&obs, obs_enabled),
        (&obs_scene_automation, false),
        (&twitch, false),
        (&tts, false),
        (&game_sounds, false),
    ]);
    IntegrationsHealth { status, obs, obs_scene_automation, twitch, tts, game_sounds }
}

// --- CLOUD ---------------------------------------------------------------

/// B.12 - `backend_state` already treats 401/403/other 4xx as proof of
/// connectivity (see backend::classify_status) - this only maps that
/// already-correct enum, it never re-derives connectivity from raw HTTP
/// statuses itself.
fn backend_component(backend_state: ConnectionState, last_sent_at: Option<String>, last_error: Option<String>) -> HealthComponent {
    match backend_state {
        ConnectionState::Waiting => HealthComponent::unknown("No backend request attempted yet this run"),
        ConnectionState::Connected => HealthComponent::healthy().with_last_success_at(last_sent_at),
        ConnectionState::Recovering => HealthComponent::degraded(last_error.unwrap_or_else(|| "Backend recovering".to_string())),
        ConnectionState::Unavailable => {
            HealthComponent::unavailable(last_error.unwrap_or_else(|| "PreReborn backend unreachable".to_string()))
        }
    }
}

/// B.9/B.10/B.11 - deliberately independent of `backend_component` above:
/// a dead-lettered (permanently rejected) sync event is a real, standing
/// problem even while the backend itself is perfectly reachable, and a
/// backend outage alone (nothing dead-lettered yet, just queued) is not a
/// sync failure. Never escalates to `Unavailable` - a subset of events
/// failing/retrying is always "working partially", per the DEGRADED
/// semantics, not a full outage of sync itself.
fn sync_component(sync_status: &SyncOutboxStatus) -> HealthComponent {
    if sync_status.failed_count > 0 {
        HealthComponent::degraded(format!(
            "{} event(s) permanently rejected by the backend",
            sync_status.failed_count
        ))
        .with_last_success_at(sync_status.last_delivered_at.clone())
        .with_last_error_at(sync_status.last_error_at.clone())
    } else if sync_status.retrying_count > 0 {
        HealthComponent::degraded("Retrying delivery of queued events")
            .with_last_success_at(sync_status.last_delivered_at.clone())
    } else {
        HealthComponent::healthy().with_last_success_at(sync_status.last_delivered_at.clone())
    }
}

/// Section 9 - "backend reachable" and "user authenticated" are
/// deliberately different questions; `account_status` never distinguishes
/// "configured but the session was just revoked" from "never configured"
/// (a revoked session is cleared, not flagged - see backend::account_status),
/// so this stays a two-state signal matching what's actually tracked today.
fn account_component(method: AccountMethod) -> HealthComponent {
    match method {
        AccountMethod::None => HealthComponent::disabled("No PreReborn account configured"),
        AccountMethod::Session | AccountMethod::LegacyToken => HealthComponent::healthy(),
    }
}

fn cloud_health(
    backend_state: ConnectionState,
    backend_last_sent_at: Option<String>,
    backend_last_error: Option<String>,
    sync_status: &SyncOutboxStatus,
    account_method: AccountMethod,
) -> CloudHealth {
    let backend = backend_component(backend_state, backend_last_sent_at, backend_last_error);
    let sync = sync_component(sync_status);
    let account = account_component(account_method);
    let status = aggregate(&[(&backend, true), (&sync, true), (&account, false)]);
    CloudHealth { status, backend, sync, account }
}

// --- TOP LEVEL -------------------------------------------------------------

/// The one read-only entry point - reads already-existing state from
/// `AppState`, `local_runtime`, `silero`, `game_sounds` and `backend`, never
/// writes to any of it. Safe to call at any cadence a caller likes (see
/// `commands::get_runtime_health` and `diagnostics::export`), including
/// concurrently, since it never blocks on anything but the same short
/// mutex locks every other status command already takes.
pub fn compute(app: &AppHandle) -> RuntimeHealth {
    let state = app.state::<AppState>();
    let snapshot = state.snapshot();
    let (obs_connected, obs_watcher_connected, obs_enabled, obs_last_error, obs_watcher_last_error, twitch_chat) = {
        let inner = state.0.lock().unwrap();
        (
            inner.obs_connected,
            inner.obs_watcher_connected,
            inner.obs_config.enabled,
            inner.obs_last_error.clone(),
            inner.obs_watcher_last_error.clone(),
            inner.twitch_chat.clone(),
        )
    };

    let lifecycle = local_runtime::lifecycle::status(app);
    let (local_runtime_open, sqlite_schema_version) = {
        let local_runtime_state = app.state::<LocalRuntimeState>();
        let guard = local_runtime_state.lock();
        match guard.as_ref() {
            Some(conn) => (true, conn.query_row("PRAGMA user_version", [], |row| row.get(0)).ok()),
            None => (false, None),
        }
    };
    let local_runtime = local_runtime_health(
        snapshot.gsi_state,
        lifecycle.session_state,
        lifecycle.session_started_at,
        local_runtime_open,
        sqlite_schema_version,
        snapshot.overlay_state,
        snapshot.overlay_last_error,
    );

    let tts_status = silero::status(app);
    let game_sounds_enabled = game_sounds::get_settings(app).enabled;
    let integrations = integrations_health(
        obs_connected,
        obs_watcher_connected,
        obs_enabled,
        obs_last_error,
        obs_watcher_last_error,
        snapshot.obs_streaming_confirmed_at,
        twitch_chat,
        tts_status.enabled,
        tts_status.resources_ready,
        tts_status.state,
        tts_status.last_error,
        game_sounds_enabled,
    );

    let sync_status = local_runtime::sync::status(app);
    let account = backend::account_status(app);
    let cloud = cloud_health(snapshot.backend_state, snapshot.backend_last_sent_at, snapshot.backend_last_error, &sync_status, account.method);

    RuntimeHealth {
        schema_version: RUNTIME_REPORT_SCHEMA_VERSION,
        generated_at: chrono::Local::now().to_rfc3339(),
        app: AppInfo { version: COMPANION_VERSION.to_string(), platform: std::env::consts::OS.to_string() },
        local_runtime,
        integrations,
        cloud,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- A. status semantics / aggregation ---------------------------

    #[test]
    fn a_healthy_only_group_aggregates_to_healthy() {
        let a = HealthComponent::healthy();
        let b = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&a, true), (&b, false)]), HealthStatus::Healthy);
    }

    #[test]
    fn a_critical_degraded_component_degrades_the_group() {
        let critical = HealthComponent::degraded("x");
        let ok = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&critical, true), (&ok, true)]), HealthStatus::Degraded);
    }

    #[test]
    fn a_critical_unavailable_component_makes_the_group_unavailable() {
        let critical = HealthComponent::unavailable("x");
        let ok = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&critical, true), (&ok, false)]), HealthStatus::Unavailable);
    }

    #[test]
    fn a_disabled_optional_component_never_degrades_the_group() {
        let disabled = HealthComponent::disabled("off");
        let ok = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&ok, true), (&disabled, false)]), HealthStatus::Healthy);
    }

    #[test]
    fn a_disabled_critical_component_never_degrades_the_group_either() {
        // "Disabled" means "not expected right now" regardless of criticality
        // - only an actually-failing (Degraded/Unavailable) critical
        // component should pull the group down.
        let disabled = HealthComponent::disabled("off");
        let ok = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&ok, true), (&disabled, true)]), HealthStatus::Healthy);
    }

    #[test]
    fn a_failing_optional_component_caps_at_degraded_never_unavailable() {
        let optional = HealthComponent::unavailable("broken optional thing");
        let ok = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&ok, true), (&optional, false)]), HealthStatus::Degraded);
    }

    #[test]
    fn an_unknown_critical_component_with_nothing_worse_leaves_the_group_unknown() {
        let unknown = HealthComponent::unknown("no data");
        let ok = HealthComponent::healthy();
        assert_eq!(aggregate(&[(&unknown, true), (&ok, false)]), HealthStatus::Unknown);
    }

    #[test]
    fn aggregation_is_deterministic_regardless_of_component_order() {
        let unavailable = HealthComponent::unavailable("x");
        let degraded = HealthComponent::degraded("y");
        let ok = HealthComponent::healthy();
        let forward = aggregate(&[(&ok, true), (&degraded, true), (&unavailable, true)]);
        let reversed = aggregate(&[(&unavailable, true), (&degraded, true), (&ok, true)]);
        assert_eq!(forward, HealthStatus::Unavailable);
        assert_eq!(forward, reversed);
    }

    // --- B. backend / sync ---------------------------------------------

    #[test]
    fn backend_healthy_and_sync_healthy() {
        let backend = backend_component(ConnectionState::Connected, Some("t".into()), None);
        let sync = sync_component(&SyncOutboxStatus::default());
        assert_eq!(backend.status, HealthStatus::Healthy);
        assert_eq!(sync.status, HealthStatus::Healthy);
    }

    #[test]
    fn backend_healthy_but_sync_has_a_dead_letter_is_sync_degraded_not_unavailable() {
        let backend = backend_component(ConnectionState::Connected, Some("t".into()), None);
        let sync = sync_component(&SyncOutboxStatus { failed_count: 1, ..Default::default() });
        assert_eq!(backend.status, HealthStatus::Healthy);
        assert_eq!(sync.status, HealthStatus::Degraded);
    }

    #[test]
    fn backend_unavailable_with_pending_sync_reports_both_independently() {
        let backend = backend_component(ConnectionState::Unavailable, None, Some("network down".into()));
        let sync = sync_component(&SyncOutboxStatus { retrying_count: 2, pending_count: 2, ..Default::default() });
        assert_eq!(backend.status, HealthStatus::Unavailable);
        assert_eq!(sync.status, HealthStatus::Degraded);
    }

    #[test]
    fn a_401_or_403_never_reads_as_backend_unavailable() {
        // classify_status (backend/mod.rs) already treats 401/403 as
        // ConnectivitySignal::Success, so backend_state itself never
        // reflects them as a failure - this pins that this mapping doesn't
        // second-guess that and turn a Connected state into anything else.
        let backend = backend_component(ConnectionState::Connected, Some("t".into()), None);
        assert_eq!(backend.status, HealthStatus::Healthy);
    }

    #[test]
    fn recovery_updates_the_projection() {
        let degraded = backend_component(ConnectionState::Recovering, None, Some("timeout".into()));
        assert_eq!(degraded.status, HealthStatus::Degraded);
        let recovered = backend_component(ConnectionState::Connected, Some("t".into()), None);
        assert_eq!(recovered.status, HealthStatus::Healthy);
    }

    // --- C. local runtime ------------------------------------------------

    #[test]
    fn gsi_listener_up_with_no_current_game_is_not_a_failure() {
        assert_eq!(gsi_component(ConnectionState::Waiting).status, HealthStatus::Healthy);
    }

    #[test]
    fn no_local_session_while_not_streaming_is_normal() {
        assert_eq!(local_session_component(LifecycleSessionState::None, None).status, HealthStatus::Healthy);
    }

    #[test]
    fn a_stale_session_needing_manual_recovery_is_degraded() {
        assert_eq!(
            local_session_component(LifecycleSessionState::NeedsManualRecovery, Some("t".into())).status,
            HealthStatus::Degraded
        );
    }

    #[test]
    fn sqlite_normal_init_is_healthy() {
        assert_eq!(sqlite_component(true).status, HealthStatus::Healthy);
        assert_eq!(sqlite_component(false).status, HealthStatus::Unavailable);
    }

    // WK-127 - schema_version is only ever meaningful when there's an open
    // connection to have read it from; a failed-to-open runtime must report
    // `None`, never a stale/fabricated number.
    #[test]
    fn sqlite_schema_version_is_none_when_the_local_runtime_failed_to_open() {
        let health = local_runtime_health(ConnectionState::Waiting, LifecycleSessionState::None, None, false, None, ConnectionState::Connected, None);
        assert_eq!(health.sqlite_schema_version, None);
        assert_eq!(health.sqlite.status, HealthStatus::Unavailable);
    }

    #[test]
    fn sqlite_schema_version_is_reported_when_the_local_runtime_is_open() {
        let health = local_runtime_health(ConnectionState::Waiting, LifecycleSessionState::None, None, true, Some(6), ConnectionState::Connected, None);
        assert_eq!(health.sqlite_schema_version, Some(6));
        assert_eq!(health.sqlite.status, HealthStatus::Healthy);
    }

    // --- C.2 overlay server (WK-153 P0) --------------------------------

    #[test]
    fn overlay_server_healthy_once_bound() {
        assert_eq!(overlay_server_component(ConnectionState::Connected, None).status, HealthStatus::Healthy);
    }

    #[test]
    fn overlay_server_surfaces_the_real_bind_failure_reason_not_a_generic_message() {
        let component = overlay_server_component(
            ConnectionState::Recovering,
            Some("Could not bind 127.0.0.1:3666: Address already in use (os error 48)".into()),
        );
        assert_eq!(component.status, HealthStatus::Unavailable);
        assert_eq!(
            component.reason.as_deref(),
            Some("Could not bind 127.0.0.1:3666: Address already in use (os error 48)")
        );
    }

    #[test]
    fn overlay_server_before_the_first_bind_attempt_is_unavailable_not_a_guess() {
        let component = overlay_server_component(ConnectionState::Unavailable, None);
        assert_eq!(component.status, HealthStatus::Unavailable);
        assert!(component.reason.is_some(), "must always say something actionable, never a silent Unavailable");
    }

    // Critical component: the local runtime as a whole must never read
    // healthy while the overlay server the Оформление preview and OBS
    // Browser Source both depend on is actually down.
    #[test]
    fn local_runtime_group_is_unavailable_when_the_overlay_server_bind_is_failing() {
        let health = local_runtime_health(
            ConnectionState::Connected,
            LifecycleSessionState::None,
            None,
            true,
            Some(6),
            ConnectionState::Recovering,
            Some("Could not bind 127.0.0.1:3666: Address already in use (os error 48)".into()),
        );
        assert_eq!(health.overlay_server.status, HealthStatus::Unavailable);
        assert_eq!(health.status, HealthStatus::Unavailable);
    }

    // --- D. OBS ------------------------------------------------------------

    #[test]
    fn obs_connected_with_automation_disabled_is_healthy_and_automation_is_disabled_not_broken() {
        let obs = obs_component(false, true, false, None, None, Some("t".into()));
        let automation = obs_scene_automation_component(false);
        assert_eq!(obs.status, HealthStatus::Healthy, "watcher-confirmed connectivity must count even without the automation socket");
        assert_eq!(automation.status, HealthStatus::Disabled);
    }

    #[test]
    fn obs_unavailable_is_never_masked_as_automation_disabled() {
        let obs = obs_component(false, false, true, Some("connection refused".into()), None, None);
        let automation = obs_scene_automation_component(true);
        assert_eq!(obs.status, HealthStatus::Unavailable);
        // automation is a preference, not OBS's connectivity - it must stay
        // whatever the user actually set it to, not silently flip.
        assert_eq!(automation.status, HealthStatus::Healthy);
    }

    // --- E. optional features -----------------------------------------

    #[test]
    fn tts_disabled_is_disabled() {
        assert_eq!(tts_component(false, true, SileroEngineState::Ready, None).status, HealthStatus::Disabled);
    }

    #[test]
    fn game_sounds_disabled_is_disabled() {
        assert_eq!(game_sounds_component(false).status, HealthStatus::Disabled);
    }

    #[test]
    fn enabled_but_broken_tts_is_unavailable_not_disabled() {
        assert_eq!(
            tts_component(true, true, SileroEngineState::Crashed, Some("sidecar crashed".into())).status,
            HealthStatus::Unavailable
        );
    }

    #[test]
    fn twitch_with_no_messages_is_not_a_failure_by_itself() {
        // Message history is deliberately never consulted - only
        // configured/connected/state - so an idle chat with zero messages
        // must read the same as a busy one.
        let value = serde_json::json!({ "configured": true, "connected": true, "state": "connected", "messages": [] });
        assert_eq!(twitch_component(Some(value)).status, HealthStatus::Healthy);
    }

    #[test]
    fn twitch_never_fetched_is_unknown_not_unavailable() {
        assert_eq!(twitch_component(None).status, HealthStatus::Unknown);
    }

    // --- component-level aggregation wiring -----------------------------

    #[test]
    fn integrations_group_stays_healthy_when_every_optional_feature_is_simply_off() {
        let health = integrations_health(
            false, false, false, None, None, None, // OBS: nothing tried, automation off
            None,  // twitch never fetched -> Unknown, but optional -> must not affect group
            false, true, SileroEngineState::NotStarted, None, // TTS off
            false, // game sounds off
        );
        assert_eq!(health.status, HealthStatus::Healthy);
        assert_eq!(health.obs.status, HealthStatus::Unknown);
        assert_eq!(health.twitch.status, HealthStatus::Unknown);
        assert_eq!(health.tts.status, HealthStatus::Disabled);
        assert_eq!(health.game_sounds.status, HealthStatus::Disabled);
    }

    #[test]
    fn integrations_group_becomes_unavailable_when_automation_is_on_and_obs_is_unreachable() {
        let health = integrations_health(
            false, false, true, Some("refused".into()), None, None, None, false, true, SileroEngineState::NotStarted, None, false,
        );
        assert_eq!(health.status, HealthStatus::Unavailable);
    }

    #[test]
    fn cloud_group_reflects_backend_and_sync_independently() {
        let sync_status = SyncOutboxStatus { failed_count: 1, ..Default::default() };
        let health = cloud_health(ConnectionState::Connected, Some("t".into()), None, &sync_status, AccountMethod::Session);
        assert_eq!(health.backend.status, HealthStatus::Healthy);
        assert_eq!(health.sync.status, HealthStatus::Degraded);
        assert_eq!(health.status, HealthStatus::Degraded);
        assert_eq!(health.account.status, HealthStatus::Healthy);
    }

    #[test]
    fn account_none_is_disabled_not_unavailable() {
        assert_eq!(account_component(AccountMethod::None).status, HealthStatus::Disabled);
    }

    // --- F. report shape -------------------------------------------------

    #[test]
    fn report_serializes_to_deterministic_valid_json_with_expected_top_level_keys() {
        let health = RuntimeHealth {
            schema_version: RUNTIME_REPORT_SCHEMA_VERSION,
            generated_at: "2026-01-01T00:00:00+00:00".to_string(),
            app: AppInfo { version: "0.5.69".to_string(), platform: "windows".to_string() },
            local_runtime: local_runtime_health(ConnectionState::Connected, LifecycleSessionState::None, None, true, Some(6), ConnectionState::Connected, None),
            integrations: integrations_health(false, false, false, None, None, None, None, false, true, SileroEngineState::NotStarted, None, false),
            cloud: cloud_health(ConnectionState::Connected, Some("t".into()), None, &SyncOutboxStatus::default(), AccountMethod::None),
        };
        let value = serde_json::to_value(&health).expect("must serialize");
        for key in ["schemaVersion", "generatedAt", "app", "localRuntime", "integrations", "cloud"] {
            assert!(value.get(key).is_some(), "missing top-level key {key}");
        }
        assert_eq!(value["schemaVersion"], serde_json::json!(RUNTIME_REPORT_SCHEMA_VERSION));

        let reserialized = serde_json::to_string(&value).unwrap();
        let parsed_again: serde_json::Value = serde_json::from_str(&reserialized).unwrap();
        assert_eq!(value, parsed_again, "report JSON must round-trip deterministically");
    }
}
