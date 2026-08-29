use std::net::TcpStream;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

use crate::broadcast_state;
use crate::state::AppState;
use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ObsConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub password: String,
    pub between_matches_scene: String,
    pub draft_scene: String,
    pub gameplay_scene: String,
    // WK-99 - fourth scene binding, on equal footing with the other three
    // (see mapped_scene_names/validate_mapping below) rather than a special
    // case: the streamer builds this scene themselves in OBS (existing
    // public overlay Browser Source + their own webcam + whatever else),
    // Companion just needs a real OBS scene name to switch to once the
    // stream session becomes `ended` - see BroadcastScene::PostStream.
    pub post_stream_scene: String,
}

impl Default for ObsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: "127.0.0.1".into(),
            port: 4455,
            password: String::new(),
            between_matches_scene: "Dota — Между матчами".into(),
            draft_scene: "Dota — Драфт".into(),
            gameplay_scene: "Dota — Игра".into(),
            post_stream_scene: "Dota — Post Stream".into(),
        }
    }
}

impl ObsConfig {
    pub fn mapped_scene_names(&self) -> [&str; 4] {
        [
            self.between_matches_scene.as_str(),
            self.draft_scene.as_str(),
            self.gameplay_scene.as_str(),
            self.post_stream_scene.as_str(),
        ]
    }

    fn is_active_mapping(
        &self,
        desired: BroadcastScene,
        active_scene: Option<BroadcastScene>,
        active_scene_name: Option<&str>,
    ) -> bool {
        active_scene == Some(desired)
            && active_scene_name == Some(desired.obs_scene_name(self))
    }

    pub fn validate_mapping(&self, available_scenes: Option<&[String]>) -> Result<(), String> {
        let labels = ["Между матчами", "Драфт", "Игра", "Post Stream"];
        let empty: Vec<&str> = labels
            .into_iter()
            .zip(self.mapped_scene_names())
            .filter_map(|(label, name)| name.trim().is_empty().then_some(label))
            .collect();
        if !empty.is_empty() {
            return Err(format!("Выберите сцены OBS для: {}", empty.join(", ")));
        }

        if let Some(scenes) = available_scenes {
            let missing: Vec<&str> = self
                .mapped_scene_names()
                .into_iter()
                .filter(|name| !scenes.iter().any(|scene| scene == name))
                .collect();
            if !missing.is_empty() {
                return Err(format!(
                    "В OBS не найдены выбранные сцены: {}",
                    missing.join(", ")
                ));
            }
        }

        Ok(())
    }
}

// WK-120 - `BroadcastScene` is now a plain alias for the canonical
// `broadcast_state::BroadcastState` (see that module's doc comment for the
// full rationale: this used to be its own enum+from_gsi defined here,
// duplicating logic apps/web's TypeScript resolver also implements
// independently - docs/research/wk-119-companion-primary-app-boundary-audit.md
// §1.2). The alias (rather than a rename across this whole file) keeps every
// existing call site, test, and the OBS-specific `obs_scene_name`/mapping
// logic below unchanged - only the enum definition and `from_gsi` moved.
pub type BroadcastScene = broadcast_state::BroadcastState;

// Inherent impl via the alias - legal because `BroadcastState` (what the
// alias resolves to) is defined in this same crate, not a foreign one; only
// cross-crate inherent impls are restricted.
impl BroadcastScene {
    pub fn obs_scene_name<'a>(&self, config: &'a ObsConfig) -> &'a str {
        match self {
            Self::BetweenMatches => &config.between_matches_scene,
            Self::Draft => &config.draft_scene,
            Self::Gameplay => &config.gameplay_scene,
            Self::PostStream => &config.post_stream_scene,
        }
    }
}

// WK-99/WK-114 - the precedence rules this feature adds, in one place: once
// the stream session is `ended`, OR the user has manually pinned "Итоги
// стрима" (see `handle_session_state`/the `show_stream_summary_scene`
// command), Post Stream wins over whatever scene GSI/a remote test command/a
// config-save reapply would otherwise request - mirrors the public web
// overlay's own getActiveScene precedence (WK-53: "ended" wins over
// sceneOverride/GSI, unconditionally). `manual_summary_override` is a
// *second*, independent reason to force Post Stream - the stream is NOT
// ended, GSI keeps flowing, this just says "don't let it change the scene
// right now". Extracted as a pure function (no AppState/IO) so this is
// unit-testable without spinning up a thread or a real OBS connection - see
// schedule_switch, its only caller, and the tests module below.
//
// `post_stream_unavailable` (new) - Post Stream is an optional binding (see
// the doc comment on `InnerState::obs_post_stream_unavailable`). When OBS has
// just told us the mapped Post Stream scene doesn't exist in that canvas,
// this resolves to BetweenMatches instead - the same "idle/no active match"
// scene GSI itself already falls back to for every other not-playing state
// (see `from_gsi`) - rather than leaving the switch attempt failing forever
// and OBS stuck on whatever scene was active before (gameplay/draft). This
// is the one new fallback rule; no new scene/state is invented.
// WK-120 - thin wrapper around the canonical `broadcast_state::resolve`
// (session_ended/manual_summary_override precedence, shared with the Local
// Overlay Runtime), plus this one OBS-specific downstream adaptation that
// stays local to this file: if the mapped Post Stream OBS scene doesn't
// exist in the user's canvas, fall back to the OBS scene switch itself
// (never the canonical state a renderer would see) to BetweenMatches.
fn resolve_desired_scene(
    requested: BroadcastScene,
    session_ended: bool,
    manual_summary_override: bool,
    post_stream_unavailable: bool,
) -> BroadcastScene {
    let canonical = broadcast_state::resolve(requested, session_ended, manual_summary_override);
    if canonical == BroadcastScene::PostStream && post_stream_unavailable {
        BroadcastScene::BetweenMatches
    } else {
        canonical
    }
}

type ObsSocket = WebSocket<MaybeTlsStream<TcpStream>>;

const RECOVERY_TICK: Duration = Duration::from_secs(1);

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(2_u64.saturating_pow(attempt.min(5)).min(30))
}

pub fn init(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        if inner.obs_config.enabled {
            inner.obs_retry_scene = Some(BroadcastScene::BetweenMatches);
            inner.obs_retry_at = Some(Instant::now());
        }
    }
    let app_for_recovery = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(RECOVERY_TICK);
        retry_pending(&app_for_recovery);
    });

    // WK-112 - independent of the retry_pending loop above (scene-switch
    // connectivity); see start_stream_state_watcher's doc comment for why
    // these two must stay separate.
    start_stream_state_watcher(app);
}

fn retry_pending(app: &AppHandle) {
    let (desired, probe_config) = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        if inner.obs_switch_pending.is_some() || inner.obs_check_pending {
            return;
        }
        let retry_scene = if inner.obs_config.enabled {
            match (inner.obs_retry_scene, inner.obs_retry_at) {
                (Some(scene), Some(at)) if Instant::now() >= at => Some(scene),
                _ => None,
            }
        } else {
            None
        };
        if let Some(scene) = retry_scene {
            (Some(scene), None)
        } else if (inner.obs_connected || inner.obs_last_error.is_some())
            && inner.obs_last_checked_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(10))
        {
            inner.obs_check_pending = true;
            (None, Some(inner.obs_config.clone()))
        } else {
            (None, None)
        }
    };
    if let Some(scene) = desired {
        schedule_switch(app, scene, true);
    } else if let Some(config) = probe_config {
        let result = test_connection(&config);
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.obs_check_pending = false;
        inner.obs_last_checked_at = Some(Instant::now());
        match &result {
            Ok(_) => { inner.obs_connected = true; inner.obs_last_error = None; }
            Err(error) => {
                inner.obs_connected = false;
                inner.obs_last_error = Some(error.clone());
                if inner.obs_config.enabled {
                    inner.obs_retry_scene = Some(inner.obs_active_scene.unwrap_or(BroadcastScene::BetweenMatches));
                    inner.obs_retry_attempt = inner.obs_retry_attempt.saturating_add(1);
                    inner.obs_retry_at = Some(Instant::now() + retry_delay(inner.obs_retry_attempt));
                }
            }
        }
        drop(inner);
        let _ = app.emit("obs-status", app.state::<AppState>().snapshot());
    }
}

fn read_json(socket: &mut ObsSocket) -> Result<Value, String> {
    loop {
        match socket.read().map_err(|e| format!("OBS WebSocket: {e}"))? {
            Message::Text(text) => {
                return serde_json::from_str(&text)
                    .map_err(|e| format!("Некорректный ответ OBS: {e}"))
            }
            Message::Ping(data) => socket
                .send(Message::Pong(data))
                .map_err(|e| format!("OBS WebSocket: {e}"))?,
            Message::Close(_) => return Err("OBS закрыл соединение".into()),
            _ => {}
        }
    }
}

fn authentication(password: &str, salt: &str, challenge: &str) -> String {
    let secret = BASE64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    BASE64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

// WK-112 - `read_timeout`/`event_subscriptions` are the two knobs the new
// stream-state watcher needs that the existing short-lived request/response
// callers (`test_connection`, `switch_scene`) don't: a persistent
// event-listening connection must block indefinitely on `read()` waiting
// for the next unsolicited event (a 4s read timeout - fine for "wait for
// the one response we expect" - would time out every few seconds with
// nothing wrong, and be indistinguishable from a real disconnect once
// converted to a `String` error, causing a busy reconnect loop) and must
// explicitly subscribe to OBS's Outputs event category (`StreamStateChanged`
// lives there) since it never sends further requests after the initial one
// to receive anything unsolicited on. `None`/`None` for both keeps the two
// existing callers' behavior byte-for-byte unchanged.
fn open(
    config: &ObsConfig,
    read_timeout: Option<Duration>,
    event_subscriptions: Option<u32>,
) -> Result<ObsSocket, String> {
    let url = format!("ws://{}:{}", config.host, config.port);
    let (mut socket, _) =
        connect(&url).map_err(|e| format!("Не удалось подключиться к OBS: {e}"))?;
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(read_timeout);
        let _ = stream.set_write_timeout(Some(Duration::from_secs(4)));
    }
    let hello = read_json(&mut socket)?;
    if hello.get("op").and_then(Value::as_i64) != Some(0) {
        return Err("OBS не прислал Hello".into());
    }
    let auth = hello
        .pointer("/d/authentication")
        .and_then(Value::as_object)
        .map(|value| {
            let salt = value
                .get("salt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let challenge = value
                .get("challenge")
                .and_then(Value::as_str)
                .unwrap_or_default();
            authentication(&config.password, salt, challenge)
        });
    let mut identify = json!({ "op": 1, "d": { "rpcVersion": 1 } });
    if let Some(auth) = auth {
        identify["d"]["authentication"] = Value::String(auth);
    }
    if let Some(subscriptions) = event_subscriptions {
        identify["d"]["eventSubscriptions"] = Value::from(subscriptions);
    }
    socket
        .send(Message::Text(identify.to_string().into()))
        .map_err(|e| format!("OBS WebSocket: {e}"))?;
    let identified = read_json(&mut socket)?;
    if identified.get("op").and_then(Value::as_i64) != Some(2) {
        return Err("OBS отклонил пароль или версию WebSocket".into());
    }
    Ok(socket)
}

fn request(
    socket: &mut ObsSocket,
    request_type: &str,
    request_data: Value,
) -> Result<Value, String> {
    let request_id = format!(
        "companion-{}",
        chrono::Local::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
    );
    socket
        .send(Message::Text(
            json!({
                "op": 6,
                "d": {
                    "requestType": request_type,
                    "requestId": request_id,
                    "requestData": request_data
                }
            })
            .to_string()
            .into(),
        ))
        .map_err(|e| format!("OBS WebSocket: {e}"))?;
    let response = read_json(socket)?;
    let ok = response
        .pointer("/d/requestStatus/result")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !ok {
        // WK-115 audit - the request's own `requestType`/`code` used to be
        // dropped here, leaving only the (sometimes absent) `comment` behind
        // a generic "неизвестная ошибка" - impossible to tell "OBS refused
        // the password" from "the scene doesn't exist" from the log alone.
        // `code` is what `is_resource_not_found` below keys off (604 =
        // obs-websocket's RESOURCE_NOT_FOUND) to detect a missing Post
        // Stream scene specifically, rather than guessing from `comment`'s
        // free-text wording.
        let code = response
            .pointer("/d/requestStatus/code")
            .and_then(Value::as_i64);
        let comment = response
            .pointer("/d/requestStatus/comment")
            .and_then(Value::as_str)
            .unwrap_or("OBS не указал причину ошибки");
        return Err(match code {
            Some(code) => format!("OBS {request_type}: {comment} (код {code})"),
            None => format!("OBS {request_type}: {comment}"),
        });
    }
    Ok(response)
}

// obs-websocket v5 RequestStatus code 604 = RESOURCE_NOT_FOUND - returned by
// e.g. SetCurrentProgramScene when the named scene doesn't exist in the
// current canvas ("No source was found by the name of 'X' within the canvas
// 'Main'"). Matched on the code embedded by `request` above, not on the
// free-text comment, so this stays correct regardless of OBS's own message
// wording/localization.
fn is_resource_not_found(error: &str) -> bool {
    error.contains("(код 604)")
}

pub fn test_connection(config: &ObsConfig) -> Result<Vec<String>, String> {
    let mut socket = open(config, Some(Duration::from_secs(4)), None)?;
    let response = request(&mut socket, "GetSceneList", json!({}))?;
    Ok(response
        .pointer("/d/responseData/scenes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|scene| scene.get("sceneName").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

// WK-121 - OBS Browser Source migration (§13 of the task). Read path first:
// `GetInputList` filtered to `kind == "browser_source"`, then
// `GetInputSettings` per candidate to read its configured `url` - never
// guesses from anything but the input's own settings. Classification is
// purely string-based on the URL's shape:
//   - already `http://127.0.0.1:3666/...` -> LocalConnected (nothing to do)
//   - contains "/overlay/" but isn't localhost -> a legacy PreReborn overlay
//     Browser Source (works for any environment's domain/scheme, not a
//     hardcoded "prereborn.ru" string - matches how the URL is actually
//     shaped, `siteUrl('/overlay/<publicToken>')`, see apps/web's settings
//     page)
//   - anything else -> not a PreReborn source at all (a user's unrelated
//     browser source - alerts, a chat box, etc. - must never be a migration
//     candidate)
// Exactly one legacy candidate -> `LegacyDetected` (migration offered).
// Zero candidates of any kind -> `Missing`. More than one legacy candidate
// -> `Ambiguous` (never guess which one is "the" PreReborn source - the
// ticket's own "если ambiguous - не угадывать" instruction).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum BrowserSourceDetection {
    LocalConnected { input_name: String },
    LegacyDetected { input_name: String, current_url: String },
    Missing,
    Ambiguous { candidates: Vec<String> },
}

const LOCAL_OVERLAY_URL: &str = "http://127.0.0.1:3666/overlay";

fn classify_browser_source_url(url: &str) -> Option<bool /* is_local */> {
    if url.starts_with("http://127.0.0.1:3666") {
        Some(true)
    } else if url.contains("/overlay/") {
        Some(false)
    } else {
        None
    }
}

/// Pure classification over the resolved `(inputName, url)` pairs of every
/// `browser_source` input in the current OBS canvas - split out from
/// `detect_browser_source` below purely so this decision (the actual
/// product risk: which state a given set of browser sources maps to) is
/// unit-testable without a live OBS connection, following the same "test
/// the pure logic directly, wire the OBS-websocket glue thinly" split this
/// file already uses for `is_resource_not_found`/retry_delay.
fn classify_candidates(candidates: Vec<(String, String)>) -> BrowserSourceDetection {
    let mut local: Option<String> = None;
    let mut legacy: Vec<(String, String)> = Vec::new();
    for (name, url) in candidates {
        match classify_browser_source_url(&url) {
            Some(true) => {
                if local.is_none() {
                    local = Some(name);
                }
            }
            Some(false) => legacy.push((name, url)),
            None => {}
        }
    }

    if let Some(input_name) = local {
        return BrowserSourceDetection::LocalConnected { input_name };
    }
    match legacy.len() {
        0 => BrowserSourceDetection::Missing,
        1 => {
            let (input_name, current_url) = legacy.into_iter().next().unwrap();
            BrowserSourceDetection::LegacyDetected { input_name, current_url }
        }
        _ => BrowserSourceDetection::Ambiguous {
            candidates: legacy.into_iter().map(|(name, _)| name).collect(),
        },
    }
}

pub fn detect_browser_source(config: &ObsConfig) -> Result<BrowserSourceDetection, String> {
    let mut socket = open(config, Some(Duration::from_secs(4)), None)?;
    let list = request(
        &mut socket,
        "GetInputList",
        json!({ "inputKind": "browser_source" }),
    )?;
    let names: Vec<String> = list
        .pointer("/d/responseData/inputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|input| input.get("inputName").and_then(Value::as_str))
        .map(str::to_string)
        .collect();

    let mut candidates: Vec<(String, String)> = Vec::new();
    for name in names {
        let settings = request(
            &mut socket,
            "GetInputSettings",
            json!({ "inputName": name }),
        )?;
        if let Some(url) = settings
            .pointer("/d/responseData/inputSettings/url")
            .and_then(Value::as_str)
        {
            candidates.push((name, url.to_string()));
        }
    }

    Ok(classify_candidates(candidates))
}

// Write path: `SetInputSettings` with `overlay: true` (obs-websocket v5 -
// merges the given fields into the input's existing settings rather than
// replacing the whole settings object), touching ONLY the `url` field of
// ONLY the one named input this function is explicitly told to change.
// `SetInputSettings` operates on an input's OWN settings - it structurally
// cannot reach scene-item transform (position/crop/size) or any other
// source (webcam/game capture/alerts), since those aren't part of an
// input's settings object at all. Never called with an ambiguous/guessed
// input name - the caller must have gotten `input_name` from a
// `LegacyDetected` result.
pub fn migrate_browser_source(config: &ObsConfig, input_name: &str) -> Result<(), String> {
    let mut socket = open(config, Some(Duration::from_secs(4)), None)?;
    request(
        &mut socket,
        "SetInputSettings",
        json!({
            "inputName": input_name,
            "inputSettings": { "url": LOCAL_OVERLAY_URL },
            "overlay": true
        }),
    )?;
    Ok(())
}

pub fn switch_scene(config: &ObsConfig, scene: BroadcastScene) -> Result<(), String> {
    let scene_name = scene.obs_scene_name(config);
    if scene_name.trim().is_empty() {
        return Err("Название сцены OBS не задано".into());
    }
    let mut socket = open(config, Some(Duration::from_secs(4)), None)?;
    request(
        &mut socket,
        "SetCurrentProgramScene",
        json!({ "sceneName": scene_name }),
    )?;
    Ok(())
}

pub fn handle_gsi(app: &AppHandle, payload: &Value) {
    let desired = BroadcastScene::from_gsi(payload);
    schedule_switch(app, desired, true);
}

pub fn handle_remote_command(app: &AppHandle, desired: BroadcastScene) {
    schedule_switch(app, desired, false);
}

pub fn reapply_current_mapping(app: &AppHandle, desired: BroadcastScene) {
    schedule_switch(app, desired, true);
}

// WK-99 - called from backend/mod.rs's periodic stream-session poll (not
// GSI, not the remote-command mailbox - a third, independent trigger). Only
// `ended` ever proactively requests a switch here: once the session goes
// back to active (Start New), there's nothing urgent to force - the next
// real GSI tick already resumes normal Gameplay/Draft/BetweenMatches
// automation on its own (see resolve_desired_scene/handle_gsi), exactly the
// same way it already does after Companion starts up or reconnects.
pub fn handle_session_state(app: &AppHandle, ended: bool) {
    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.session_ended = ended;
        // WK-114 - a new/continuing local session starting must never
        // inherit last stream's "Итоги стрима" pin; the override is
        // exclusively a same-session, manual, user-reversible action (see
        // resume_live_scene) - it must not silently survive into the next
        // stream and keep OBS stuck on Post Stream.
        if !ended {
            inner.obs_manual_summary_override = false;
            // WK-115 audit - same reasoning: a Post Stream binding that was
            // unavailable on last stream's end must get a fresh attempt on
            // the next one, not stay silently downgraded to the
            // BetweenMatches fallback forever (e.g. after the streamer
            // creates the missing scene in OBS between streams).
            inner.obs_post_stream_unavailable = false;
        }
    }
    if ended {
        schedule_switch(app, BroadcastScene::PostStream, true);
    }
}

fn schedule_switch(app: &AppHandle, requested: BroadcastScene, require_enabled: bool) {
    // WK-99 - resolved once, here, and shadowed for the rest of the
    // function (including the spawned thread below) - every caller
    // (handle_gsi, handle_remote_command, reapply_current_mapping,
    // handle_session_state) gets the ended-wins-over-everything precedence
    // for free, see resolve_desired_scene. `requested` is kept around
    // (WK-115 audit) purely for the log line below, so a support log can
    // show "what GSI/the caller originally asked for" separately from "what
    // this actually resolved/fell back to".
    let (desired, config) = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        let desired = resolve_desired_scene(
            requested,
            inner.session_ended,
            inner.obs_manual_summary_override,
            inner.obs_post_stream_unavailable,
        );
        if require_enabled && !inner.obs_config.enabled {
            return;
        }
        inner.obs_retry_scene = Some(desired);
        if inner.obs_switch_pending.is_some() || inner.obs_check_pending {
            return;
        }
        if inner.obs_config.is_active_mapping(
            desired,
            inner.obs_active_scene,
            inner.obs_active_scene_name.as_deref(),
        ) {
            inner.obs_retry_scene = None;
            inner.obs_retry_at = None;
            inner.obs_retry_attempt = 0;
            return;
        }
        if inner.obs_retry_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        inner.obs_switch_pending = Some(desired);
        inner.obs_retry_at = None;
        (desired, inner.obs_config.clone())
    };

    let app_for_switch = app.clone();
    std::thread::spawn(move || {
        let result = switch_scene(&config, desired);
        {
            let state = app_for_switch.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            if inner.obs_switch_pending == Some(desired) {
                inner.obs_switch_pending = None;
            }
            match &result {
                Ok(()) => {
                    let switched_scene_name = desired.obs_scene_name(&config).to_string();
                    inner.obs_connected = true;
                    inner.obs_active_scene = Some(desired);
                    inner.obs_active_scene_name = Some(switched_scene_name.clone());
                    inner.obs_last_error = None;
                    inner.obs_last_checked_at = Some(Instant::now());
                    let mapping_is_current =
                        desired.obs_scene_name(&inner.obs_config) == switched_scene_name;
                    if inner.obs_retry_scene == Some(desired) && mapping_is_current {
                        inner.obs_retry_scene = None;
                        inner.obs_retry_attempt = 0;
                        inner.obs_retry_at = None;
                    } else {
                        inner.obs_retry_scene = Some(inner.obs_retry_scene.unwrap_or(desired));
                        inner.obs_retry_at = Some(Instant::now());
                    }
                    // WK-115 audit - a Post Stream switch that succeeds
                    // (e.g. the streamer created the scene and a later retry
                    // went through) clears any earlier fallback-to-
                    // BetweenMatches downgrade, restoring normal automation.
                    if desired == BroadcastScene::PostStream {
                        inner.obs_post_stream_unavailable = false;
                    }
                }
                Err(error) => {
                    inner.obs_connected = false;
                    inner.obs_last_error = Some(error.clone());
                    if inner.obs_retry_scene.is_none() {
                        inner.obs_retry_scene = Some(desired);
                    }
                    inner.obs_retry_attempt = inner.obs_retry_attempt.saturating_add(1);
                    inner.obs_retry_at =
                        Some(Instant::now() + retry_delay(inner.obs_retry_attempt));
                    // WK-115 audit - the actual fix: Post Stream is optional
                    // (see resolve_desired_scene's doc comment). If OBS just
                    // told us the mapped Post Stream scene doesn't exist in
                    // its canvas, don't leave the stream stuck on whatever
                    // scene was active before (gameplay/draft) while this
                    // keeps retrying a switch that can only ever fail the
                    // same way - fall back to BetweenMatches (the existing
                    // "no active match" scene) on the very next resolution.
                    // Never creates an OBS scene; only changes what
                    // Companion asks OBS to switch to.
                    if desired == BroadcastScene::PostStream && is_resource_not_found(error) {
                        inner.obs_post_stream_unavailable = true;
                    }
                }
            }
        }
        // WK-115 audit - three explicit stages so a support log line answers
        // "what was asked for", "what it actually resolved/fell back to",
        // and "what OBS said" without cross-referencing other log lines;
        // previously only the resolved scene and a possibly-generic error
        // were logged.
        let fallback_note = if requested != desired {
            format!(" (fallback from {requested:?})")
        } else {
            String::new()
        };
        storage::append_rolling_log(
            &app_for_switch,
            &match &result {
                Ok(()) => format!(
                    "OBS scene switch: requested={requested:?} resolved={desired:?}{fallback_note} -> switched to '{}'.",
                    desired.obs_scene_name(&config)
                ),
                Err(error) => format!(
                    "OBS scene switch: requested={requested:?} resolved={desired:?}{fallback_note} -> failed: {error}"
                ),
            },
        );
        let _ = app_for_switch.emit("obs-status", app_for_switch.state::<AppState>().snapshot());
    });
}

// WK-112 - obs-websocket v5 EventSubscription bitmask. Only the "Outputs"
// category (bit 6) is needed - `StreamStateChanged` lives there, and
// nothing else this watcher does relies on any other category. Deliberately
// narrower than the implicit "subscribe to everything" default the other,
// short-lived connections get by omitting this field entirely (see
// `open`'s doc comment) - explicit here since this is the one connection
// that actually consumes events.
const EVENT_SUBSCRIPTION_OUTPUTS: u32 = 1 << 6;

fn fetch_stream_status(socket: &mut ObsSocket) -> Result<bool, String> {
    let response = request(socket, "GetStreamStatus", json!({}))?;
    response
        .pointer("/d/responseData/outputActive")
        .and_then(Value::as_bool)
        .ok_or_else(|| "OBS: GetStreamStatus response missing outputActive".to_string())
}

/// WK-112 - persistent connection dedicated to observing OBS's own
/// streaming state (Start Streaming / Stop Streaming), independent of the
/// short-lived per-request connections `switch_scene`/`test_connection`
/// use for scene automation, and independent of `obs_connected`/`obs_state`
/// - this file's one principled distinction (see the doc comments on
/// `StatusSnapshot::obs_streaming` in state.rs): whether Companion can
/// currently *talk to* OBS is a different question from whether OBS is
/// currently *streaming*. This function never writes `obs_connected`/
/// `obs_state` at all - only `local_runtime::lifecycle::on_obs_streaming_known`,
/// which records the streaming truth and reconciles the local session
/// lifecycle. Started once from `init`, runs for the app's lifetime.
///
/// WK-116 P0 FIX - this used to also gate on `obs_config.enabled` ("should
/// Companion auto-switch OBS scenes"), which is an orthogonal, purely
/// cosmetic preference. Since `enabled` defaults to `false` and many
/// streamers legitimately run in manual scene mode, that gate meant this
/// watcher - the ONLY source of OBS streaming truth for
/// `local_runtime::lifecycle` - never even attempted to connect, so
/// LocalSession was never created or ended, which meant `local_runtime::
/// handle_gsi` early-returned on every GSI tick (no open session to attach
/// to) and NO match/MMR tracking ever ran at all, regardless of scene
/// automation. "Is OBS streaming" must always be observed - it drives the
/// local session lifecycle unconditionally, per WK-112's own design intent
/// (see this module's other doc comments). Whether Companion *acts* on GSI
/// to switch scenes is still correctly gated by `enabled`, inside
/// `schedule_switch`'s `require_enabled` check - untouched here.
pub fn start_stream_state_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut attempt: u32 = 0;
        // WK-116 - now that this watcher always runs (see the fix above),
        // a user with no OBS at all would otherwise get the exact same
        // "connection refused" line logged on every single retry, forever.
        // Logged only when the error text actually changes (or on the very
        // first attempt), not on every repeat of an already-known failure.
        let mut last_logged_error: Option<String> = None;
        loop {
            let config = app.state::<AppState>().0.lock().unwrap().obs_config.clone();
            if let Err(error) = run_stream_state_watcher_once(&app, &config) {
                if last_logged_error.as_deref() != Some(error.as_str()) {
                    storage::append_rolling_log(&app, &format!("OBS stream-state watcher: {error}"));
                    last_logged_error = Some(error);
                }
            } else {
                last_logged_error = None;
            }
            // Any exit from run_stream_state_watcher_once (connect failure,
            // auth failure, or the read loop's connection dropping) means
            // "not currently connected" - back off before retrying, same
            // capped-exponential shape as the scene-switch path uses.
            // Deliberately does NOT touch obs_connected/obs_state (see doc
            // comment above) and does NOT touch LocalSession state either -
            // per WK-112's explicit rule, losing this connection alone must
            // never end a session; reconciliation only ever runs again once
            // reconnected and a fresh GetStreamStatus succeeds.
            attempt = attempt.saturating_add(1);
            std::thread::sleep(retry_delay(attempt));
        }
    });
}

/// One connection attempt's lifetime: connect, identify (subscribing to
/// Outputs events), fetch the current streaming truth once, then block
/// reading events until the connection breaks. Only returns (always with an
/// `Err`) once the connection is gone - no read timeout is set on this
/// socket (`open(.., None, ..)`), so the blocking `read_json` call below
/// waits indefinitely for either a real message or the OS reporting the
/// connection closed, rather than erroring out on an idle timer the way the
/// short-lived request/response connections intentionally do.
fn run_stream_state_watcher_once(app: &AppHandle, config: &ObsConfig) -> Result<(), String> {
    let mut socket = open(config, None, Some(EVENT_SUBSCRIPTION_OUTPUTS))?;
    let streaming = fetch_stream_status(&mut socket)?;
    // WK-112 rule #5: every (re)connect always re-fetches GetStreamStatus
    // and reconciles from OBS's real, current answer - never from an
    // assumption that whatever we knew before the disconnect still holds.
    crate::local_runtime::lifecycle::on_obs_streaming_known(app, streaming);

    loop {
        let message = read_json(&mut socket)?;
        if message.get("op").and_then(Value::as_i64) != Some(5) {
            continue; // not an Event message (e.g. a stray Hello/other op) - ignore
        }
        if message.pointer("/d/eventType").and_then(Value::as_str) != Some("StreamStateChanged") {
            continue; // some other Outputs-category event (e.g. RecordStateChanged) - not our concern
        }
        if let Some(active) = message
            .pointer("/d/eventData/outputActive")
            .and_then(Value::as_bool)
        {
            crate::local_runtime::lifecycle::on_obs_streaming_known(app, active);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_backoff_is_bounded() {
        assert_eq!(retry_delay(0), Duration::from_secs(1));
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(4), Duration::from_secs(16));
        assert_eq!(retry_delay(20), Duration::from_secs(30));
    }

    #[test]
    fn maps_gsi_states_to_broadcast_scenes() {
        assert_eq!(
            BroadcastScene::from_gsi(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_HERO_SELECTION" },
                "player": { "activity": "playing" }
            })),
            BroadcastScene::Draft
        );
        assert_eq!(
            BroadcastScene::from_gsi(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_TEAM_SHOWCASE" },
                "player": { "activity": "playing" }
            })),
            BroadcastScene::Draft
        );
        assert_eq!(
            BroadcastScene::from_gsi(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                "player": { "activity": "playing" }
            })),
            BroadcastScene::Gameplay
        );
        assert_eq!(
            BroadcastScene::from_gsi(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_POST_GAME" },
                "player": { "activity": "playing" }
            })),
            BroadcastScene::BetweenMatches
        );
    }
    #[test]
    fn obs_config_uses_field_defaults_for_partial_legacy_json() {
        let config: ObsConfig = serde_json::from_value(json!({
            "enabled": true,
            "gameplay_scene": "Custom gameplay"
        }))
        .unwrap();

        assert!(config.enabled);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 4455);
        assert_eq!(config.between_matches_scene, "Dota — Между матчами");
        assert_eq!(config.draft_scene, "Dota — Драфт");
        assert_eq!(config.gameplay_scene, "Custom gameplay");
        // WK-99 - a config saved by a version of Companion that predates
        // Post Stream (no `post_stream_scene` key at all in the JSON on
        // disk) must not fail to load or silently lose the other fields -
        // it gets the same field-default treatment as every other absent
        // key here.
        assert_eq!(config.post_stream_scene, "Dota — Post Stream");
    }

    #[test]
    fn obs_config_preserves_complete_legacy_json() {
        let config: ObsConfig = serde_json::from_value(json!({
            "enabled": true,
            "host": "obs.local",
            "port": 4456,
            "password": "secret",
            "between_matches_scene": "Queue",
            "draft_scene": "Draft",
            "gameplay_scene": "Gameplay"
        }))
        .unwrap();

        // WK-99 - this JSON predates post_stream_scene (same "legacy" shape
        // as the test name describes) - mapped_scene_names must still come
        // back with exactly 4 entries, the 4th filled by the field default.
        assert_eq!(
            config.mapped_scene_names(),
            ["Queue", "Draft", "Gameplay", "Dota — Post Stream"]
        );
        assert_eq!(config.host, "obs.local");
        assert_eq!(config.port, 4456);
        assert_eq!(config.password, "secret");
    }

    // WK-121 - OBS Browser Source migration classification (§13). Pure
    // logic, no OBS websocket connection needed - see classify_candidates's
    // doc comment for why this split exists.
    mod browser_source_migration {
        use super::*;

        #[test]
        fn classifies_a_localhost_url_as_local() {
            assert_eq!(classify_browser_source_url("http://127.0.0.1:3666/overlay"), Some(true));
        }

        #[test]
        fn classifies_any_domain_overlay_path_as_legacy_not_hardcoded_to_prereborn_ru() {
            assert_eq!(classify_browser_source_url("https://prereborn.ru/overlay/abc123"), Some(false));
            assert_eq!(classify_browser_source_url("http://staging.example.com/overlay/xyz"), Some(false));
        }

        #[test]
        fn does_not_classify_an_unrelated_browser_source_as_ours() {
            assert_eq!(classify_browser_source_url("https://streamlabs.com/alerts/abc"), None);
            assert_eq!(classify_browser_source_url("https://twitch.tv/somechannel"), None);
        }

        #[test]
        fn no_browser_sources_at_all_is_missing() {
            assert_eq!(classify_candidates(vec![]), BrowserSourceDetection::Missing);
        }

        #[test]
        fn a_localhost_source_wins_even_alongside_an_unrelated_one() {
            let result = classify_candidates(vec![
                ("Webcam Alert".to_string(), "https://streamlabs.com/alerts/abc".to_string()),
                ("PreReborn".to_string(), "http://127.0.0.1:3666/overlay".to_string()),
            ]);
            assert_eq!(result, BrowserSourceDetection::LocalConnected { input_name: "PreReborn".to_string() });
        }

        #[test]
        fn exactly_one_legacy_candidate_is_offered_for_migration() {
            let result = classify_candidates(vec![
                ("PreReborn Overlay".to_string(), "https://prereborn.ru/overlay/abc123".to_string()),
            ]);
            assert_eq!(
                result,
                BrowserSourceDetection::LegacyDetected {
                    input_name: "PreReborn Overlay".to_string(),
                    current_url: "https://prereborn.ru/overlay/abc123".to_string(),
                }
            );
        }

        // WK-121 - "если ambiguous - не угадывать": two candidates that both
        // look like a PreReborn overlay must never be auto-resolved to one.
        #[test]
        fn two_legacy_candidates_are_ambiguous_never_auto_picked() {
            let result = classify_candidates(vec![
                ("Overlay A".to_string(), "https://prereborn.ru/overlay/abc".to_string()),
                ("Overlay B".to_string(), "https://prereborn.ru/overlay/def".to_string()),
            ]);
            assert_eq!(
                result,
                BrowserSourceDetection::Ambiguous { candidates: vec!["Overlay A".to_string(), "Overlay B".to_string()] }
            );
        }

        #[test]
        fn unrelated_browser_sources_alone_are_still_missing_not_ambiguous() {
            let result = classify_candidates(vec![
                ("Alerts".to_string(), "https://streamlabs.com/alerts/abc".to_string()),
                ("Chat".to_string(), "https://twitch.tv/popout/somechannel/chat".to_string()),
            ]);
            assert_eq!(result, BrowserSourceDetection::Missing);
        }

        // WK-121 - migration must only ever write to the ONE input name it
        // was explicitly given, never guess/scan - this is a compile-time
        // shape pin (SetInputSettings' inputName always comes from the
        // caller's own `input_name: &str` parameter), not a runtime test,
        // since the runtime request itself needs a live OBS connection.
        #[test]
        fn migrate_signature_takes_an_explicit_input_name_never_a_detection_result() {
            fn _type_check(config: &ObsConfig, input_name: &str) -> Result<(), String> {
                migrate_browser_source(config, input_name)
            }
        }
    }

    #[test]
    fn mapping_validation_distinguishes_unavailable_and_missing_scenes() {
        let config = ObsConfig::default();
        assert!(config.validate_mapping(None).is_ok());

        let available = vec![
            config.between_matches_scene.clone(),
            config.gameplay_scene.clone(),
            config.post_stream_scene.clone(),
        ];
        assert_eq!(
            config.validate_mapping(Some(&available)).unwrap_err(),
            "В OBS не найдены выбранные сцены: Dota — Драфт"
        );
    }

    #[test]
    fn mapping_validation_requires_post_stream_like_the_other_three() {
        // WK-99 - Post Stream is "наравне" (on equal footing) with the
        // other three bindings, per the task - an empty mapping for it
        // fails validation exactly like an empty draft/gameplay mapping
        // already does, not silently ignored as optional.
        let mut config = ObsConfig::default();
        config.post_stream_scene = "  ".into();
        assert_eq!(
            config.validate_mapping(None).unwrap_err(),
            "Выберите сцены OBS для: Post Stream"
        );
    }

    #[test]
    fn changed_mapping_is_not_treated_as_an_already_active_scene() {
        let mut config = ObsConfig::default();
        let active_name = config.draft_scene.clone();

        assert!(config.is_active_mapping(
            BroadcastScene::Draft,
            Some(BroadcastScene::Draft),
            Some(&active_name)
        ));

        config.draft_scene = "Renamed draft".into();
        assert!(!config.is_active_mapping(
            BroadcastScene::Draft,
            Some(BroadcastScene::Draft),
            Some(&active_name)
        ));
    }

    #[test]
    fn mapping_validation_rejects_empty_values_without_obs() {
        let mut config = ObsConfig::default();
        config.draft_scene = "  ".into();
        assert_eq!(
            config.validate_mapping(None).unwrap_err(),
            "Выберите сцены OBS для: Драфт"
        );
    }

    // WK-99 - OBS Post Stream scene. resolve_desired_scene is the one new
    // precedence rule this feature adds (ended wins over everything) and is
    // deliberately a pure function - see its doc comment - so these tests
    // exercise the resolver/state machine directly, without needing a
    // thread or a real OBS connection, per the task's own guidance.
    mod post_stream {
        use super::*;

        #[test]
        fn active_session_requests_the_normal_gsi_derived_scene() {
            assert_eq!(
                resolve_desired_scene(BroadcastScene::Gameplay, false, false, false),
                BroadcastScene::Gameplay
            );
            assert_eq!(
                resolve_desired_scene(BroadcastScene::BetweenMatches, false, false, false),
                BroadcastScene::BetweenMatches
            );
            assert_eq!(
                resolve_desired_scene(BroadcastScene::Draft, false, false, false),
                BroadcastScene::Draft
            );
        }

        #[test]
        fn ended_session_wins_over_any_requested_scene() {
            // Mirrors the public web overlay's getActiveScene precedence
            // (WK-53): once the session is ended, Post Stream wins
            // regardless of what GSI/a remote command/a config reapply
            // would otherwise have asked for.
            for requested in [
                BroadcastScene::Gameplay,
                BroadcastScene::Draft,
                BroadcastScene::BetweenMatches,
                BroadcastScene::PostStream,
            ] {
                assert_eq!(
                    resolve_desired_scene(requested, true, false, false),
                    BroadcastScene::PostStream
                );
            }
        }

        #[test]
        fn manual_summary_override_wins_over_any_requested_scene_without_the_session_being_ended() {
            // WK-114 - "Итоги стрима": the stream is NOT ended (session_ended
            // stays false), but the user has manually pinned Post Stream -
            // GSI/remote-command/reapply requests must still resolve to it.
            for requested in [BroadcastScene::Gameplay, BroadcastScene::Draft, BroadcastScene::BetweenMatches] {
                assert_eq!(
                    resolve_desired_scene(requested, false, true, false),
                    BroadcastScene::PostStream
                );
            }
        }

        #[test]
        fn clearing_the_manual_summary_override_lets_the_requested_scene_through_again() {
            assert_eq!(
                resolve_desired_scene(BroadcastScene::Gameplay, false, false, false),
                BroadcastScene::Gameplay
            );
        }

        #[test]
        fn a_finished_match_alone_does_not_request_post_stream() {
            // "Обычное завершение матча" - the post-game GSI state maps to
            // BetweenMatches (see maps_gsi_states_to_broadcast_scenes
            // above), which only becomes PostStream through
            // resolve_desired_scene if session_ended is separately true.
            // Simulates handle_gsi's own composition of the two.
            let post_game_desired = BroadcastScene::from_gsi(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_POST_GAME" },
                "player": { "activity": "playing" }
            }));
            assert_eq!(post_game_desired, BroadcastScene::BetweenMatches);
            assert_eq!(
                resolve_desired_scene(post_game_desired, false, false, false),
                BroadcastScene::BetweenMatches
            );
        }

        #[test]
        fn lost_gsi_signal_alone_does_not_request_post_stream() {
            // No player/map at all (GSI silence/timeout) - from_gsi's
            // fallback is BetweenMatches, same as any other non-playing
            // tick. session_ended is a wholly separate signal (set only by
            // local_runtime::lifecycle::apply, WK-113), so losing GSI can
            // never flip it on its own.
            let desired = BroadcastScene::from_gsi(&json!({}));
            assert_eq!(desired, BroadcastScene::BetweenMatches);
            assert_eq!(
                resolve_desired_scene(desired, false, false, false),
                BroadcastScene::BetweenMatches
            );
        }

        // WK-115 audit - "Post Stream должен быть optional": if OBS has
        // already told us the mapped scene doesn't exist
        // (post_stream_unavailable), an ended/pinned session must resolve to
        // the existing BetweenMatches ("no active match") scene instead of
        // repeatedly asking OBS for a scene that can only fail the same way -
        // never left resolving to a stale gameplay/draft scene, and never a
        // new invented scene.
        #[test]
        fn post_stream_unavailable_falls_back_to_between_matches_when_session_ended() {
            for requested in [
                BroadcastScene::Gameplay,
                BroadcastScene::Draft,
                BroadcastScene::BetweenMatches,
                BroadcastScene::PostStream,
            ] {
                assert_eq!(
                    resolve_desired_scene(requested, true, false, true),
                    BroadcastScene::BetweenMatches
                );
            }
        }

        #[test]
        fn post_stream_unavailable_falls_back_to_between_matches_under_manual_summary_override_too() {
            assert_eq!(
                resolve_desired_scene(BroadcastScene::Gameplay, false, true, true),
                BroadcastScene::BetweenMatches
            );
        }

        #[test]
        fn post_stream_unavailable_has_no_effect_while_the_session_is_active() {
            // The flag only ever matters once ended/override would otherwise
            // request Post Stream - it must not itself force a scene change
            // during normal GSI-driven automation.
            assert_eq!(
                resolve_desired_scene(BroadcastScene::Gameplay, false, false, true),
                BroadcastScene::Gameplay
            );
        }

        #[test]
        fn resource_not_found_code_is_detected_from_the_formatted_obs_error() {
            assert!(is_resource_not_found(
                "OBS SetCurrentProgramScene: No source was found by the name of 'Dota — Post Stream' within the canvas 'Main' (код 604)"
            ));
            assert!(!is_resource_not_found("OBS WebSocket: connection reset"));
            assert!(!is_resource_not_found(
                "OBS SetCurrentProgramScene: неверный пароль (код 201)"
            ));
        }

        #[test]
        fn post_stream_is_bound_and_validated_on_equal_footing_with_the_other_three() {
            let config = ObsConfig::default();
            assert_eq!(config.mapped_scene_names().len(), 4);
            assert_eq!(
                BroadcastScene::PostStream.obs_scene_name(&config),
                config.post_stream_scene
            );
            assert!(config.validate_mapping(None).is_ok());
        }

        #[test]
        fn manual_scene_switch_after_post_stream_is_not_dragged_back() {
            // The actual "don't fight the user" mechanism: once Companion's
            // own record of the active scene says PostStream and the
            // mapping hasn't changed, is_active_mapping treats a repeated
            // request for PostStream as a no-op - schedule_switch's caller
            // (a GSI tick, the 3s session poll, or a remote command) never
            // re-issues SetCurrentProgramScene, so a scene the user picked
            // by hand directly in OBS is left alone. Same mechanism the
            // other three scenes already rely on (see
            // changed_mapping_is_not_treated_as_an_already_active_scene).
            let config = ObsConfig::default();
            let active_name = config.post_stream_scene.clone();
            assert!(config.is_active_mapping(
                BroadcastScene::PostStream,
                Some(BroadcastScene::PostStream),
                Some(&active_name)
            ));
        }

        #[test]
        fn reapplying_a_changed_post_stream_mapping_is_not_treated_as_already_active() {
            let mut config = ObsConfig::default();
            let active_name = config.post_stream_scene.clone();
            config.post_stream_scene = "Renamed post stream".into();
            assert!(!config.is_active_mapping(
                BroadcastScene::PostStream,
                Some(BroadcastScene::PostStream),
                Some(&active_name)
            ));
        }

        #[test]
        fn missing_post_stream_binding_fails_fast_without_touching_the_network() {
            // "Post Stream scene not configured" - switch_scene's empty-name
            // guard is synchronous, no socket involved, so this is fast and
            // deterministic to assert directly (no thread/mock OBS needed).
            let mut config = ObsConfig::default();
            config.post_stream_scene = String::new();
            let error = switch_scene(&config, BroadcastScene::PostStream).unwrap_err();
            assert_eq!(error, "Название сцены OBS не задано");
        }

        #[test]
        fn session_ended_defaults_to_false_so_automation_runs_normally_until_told_otherwise() {
            // Before OBS's local lifecycle (local_runtime::lifecycle, WK-112/
            // 113) has ever reconciled a session end, the resolver must
            // behave exactly as it did before this feature - GSI-driven
            // automation, never a surprise Post Stream switch.
            assert!(!crate::state::InnerState::default().session_ended);
        }

        #[test]
        fn manual_summary_override_defaults_to_false_so_automation_runs_normally_until_asked() {
            // WK-114 - "Итоги стрима" must never be on by default; only an
            // explicit show_stream_summary_scene call turns it on.
            assert!(!crate::state::InnerState::default().obs_manual_summary_override);
        }

        #[test]
        fn post_stream_unavailable_defaults_to_false_so_a_configured_scene_is_tried_first() {
            // WK-115 audit - the fallback must never be assumed up front; it
            // only turns on after OBS actually reports the scene missing.
            assert!(!crate::state::InnerState::default().obs_post_stream_unavailable);
        }

        // "OBS unavailable / Post Stream scene not configured must not block
        // End Stream": handle_session_state (backend/mod.rs -> obs.rs) sets
        // AppState's session_ended in its own short-lived lock, as plain
        // synchronous field assignment, strictly before the separate
        // `if ended { schedule_switch(..) }` line that may go on to spawn a
        // thread and fail against OBS - visible directly in
        // handle_session_state's body above. Consistent with the rest of
        // this file's testing boundary (schedule_switch/handle_gsi/
        // handle_remote_command's AppHandle-driven paths are exercised
        // manually/end-to-end, not via a mocked Tauri app here either) -
        // this project's tauri dependency isn't built with the `test`
        // feature, so asserting this specific line via a real AppHandle
        // would need a new dev-dependency just for one field assignment;
        // the pure resolve_desired_scene tests above already cover the
        // actual decision logic this whole feature adds.
    }
}
