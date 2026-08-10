use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

use crate::state::AppState;
use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub password: String,
    pub between_matches_scene: String,
    pub draft_scene: String,
    pub gameplay_scene: String,
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
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BroadcastScene {
    BetweenMatches,
    Draft,
    Gameplay,
}

impl BroadcastScene {
    pub fn from_gsi(payload: &Value) -> Self {
        let activity = payload.pointer("/player/activity").and_then(Value::as_str);
        if activity != Some("playing") {
            return Self::BetweenMatches;
        }
        match payload.pointer("/map/game_state").and_then(Value::as_str) {
            Some("DOTA_GAMERULES_STATE_HERO_SELECTION")
            | Some("DOTA_GAMERULES_STATE_STRATEGY_TIME")
            | Some("DOTA_GAMERULES_STATE_TEAM_SHOWCASE") => Self::Draft,
            Some("DOTA_GAMERULES_STATE_PRE_GAME")
            | Some("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS") => Self::Gameplay,
            _ => Self::BetweenMatches,
        }
    }

    pub fn obs_scene_name<'a>(&self, config: &'a ObsConfig) -> &'a str {
        match self {
            Self::BetweenMatches => &config.between_matches_scene,
            Self::Draft => &config.draft_scene,
            Self::Gameplay => &config.gameplay_scene,
        }
    }
}

type ObsSocket = WebSocket<MaybeTlsStream<TcpStream>>;

static OBS_SWITCH_LOCK: Mutex<()> = Mutex::new(());

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

fn open(config: &ObsConfig) -> Result<ObsSocket, String> {
    let url = format!("ws://{}:{}", config.host, config.port);
    let (mut socket, _) =
        connect(&url).map_err(|e| format!("Не удалось подключиться к OBS: {e}"))?;
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
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
        let comment = response
            .pointer("/d/requestStatus/comment")
            .and_then(Value::as_str)
            .unwrap_or("неизвестная ошибка");
        return Err(format!("OBS: {comment}"));
    }
    Ok(response)
}

pub fn test_connection(config: &ObsConfig) -> Result<Vec<String>, String> {
    let mut socket = open(config)?;
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

pub fn switch_scene(config: &ObsConfig, scene: BroadcastScene) -> Result<(), String> {
    // Serialize automatic, remote and local manual requests. If a manual
    // request arrives while automation is switching, it waits and wins last.
    let _switch_guard = OBS_SWITCH_LOCK.lock().unwrap();
    let scene_name = scene.obs_scene_name(config);
    if scene_name.trim().is_empty() {
        return Err("Название сцены OBS не задано".into());
    }
    let mut socket = open(config)?;
    request(
        &mut socket,
        "SetCurrentProgramScene",
        json!({ "sceneName": scene_name }),
    )?;
    Ok(())
}

pub fn current_scene(config: &ObsConfig) -> Result<Option<BroadcastScene>, String> {
    let mut socket = open(config)?;
    let response = request(&mut socket, "GetCurrentProgramScene", json!({}))?;
    let name = response
        .pointer("/d/responseData/currentProgramSceneName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok([
        BroadcastScene::BetweenMatches,
        BroadcastScene::Draft,
        BroadcastScene::Gameplay,
    ]
    .into_iter()
    .find(|scene| scene.obs_scene_name(config) == name))
}

pub fn handle_gsi(app: &AppHandle, payload: &Value) {
    let desired = BroadcastScene::from_gsi(payload);
    schedule_switch(app, desired, true);
}

pub fn handle_remote_command(app: &AppHandle, desired: BroadcastScene) {
    schedule_switch(app, desired, false);
}

fn schedule_switch(app: &AppHandle, desired: BroadcastScene, require_enabled: bool) {
    let config = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        if (require_enabled && !inner.obs_config.enabled)
            || inner.obs_active_scene == Some(desired)
            || inner.obs_switch_pending.is_some()
        {
            return;
        }
        inner.obs_switch_pending = Some(desired);
        inner.obs_config.clone()
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
                    inner.obs_connected = true;
                    inner.obs_active_scene = Some(desired);
                    inner.obs_last_error = None;
                }
                Err(error) => {
                    inner.obs_connected = false;
                    inner.obs_last_error = Some(error.clone());
                }
            }
        }
        storage::append_rolling_log(
            &app_for_switch,
            &match &result {
                Ok(()) => format!(
                    "OBS switched to '{}' ({desired:?}).",
                    desired.obs_scene_name(&config)
                ),
                Err(error) => format!("OBS scene switch failed: {error}"),
            },
        );
        let _ = app_for_switch.emit("obs-status", app_for_switch.state::<AppState>().snapshot());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
