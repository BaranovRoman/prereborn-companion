use std::net::TcpStream;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

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

impl ObsConfig {
    pub fn mapped_scene_names(&self) -> [&str; 3] {
        [
            self.between_matches_scene.as_str(),
            self.draft_scene.as_str(),
            self.gameplay_scene.as_str(),
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
        let labels = ["Между матчами", "Драфт", "Игра"];
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
    std::thread::spawn(move || loop {
        std::thread::sleep(RECOVERY_TICK);
        retry_pending(&app);
    });
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

fn schedule_switch(app: &AppHandle, desired: BroadcastScene, require_enabled: bool) {
    let config = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
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

        assert_eq!(config.mapped_scene_names(), ["Queue", "Draft", "Gameplay"]);
        assert_eq!(config.host, "obs.local");
        assert_eq!(config.port, 4456);
        assert_eq!(config.password, "secret");
    }

    #[test]
    fn mapping_validation_distinguishes_unavailable_and_missing_scenes() {
        let config = ObsConfig::default();
        assert!(config.validate_mapping(None).is_ok());

        let available = vec![
            config.between_matches_scene.clone(),
            config.gameplay_scene.clone(),
        ];
        assert_eq!(
            config.validate_mapping(Some(&available)).unwrap_err(),
            "В OBS не найдены выбранные сцены: Dota — Драфт"
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
}
