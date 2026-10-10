use serde_json::Value;

// GSI `map.game_state` values in which the player is actually somewhere
// between hero pick and the post-game screen - mirrors
// apps/api/src/services/stream-match-service.ts's `IN_MATCH_STATES`.
const IN_MATCH_STATES: &[&str] = &[
    "DOTA_GAMERULES_STATE_HERO_SELECTION",
    "DOTA_GAMERULES_STATE_STRATEGY_TIME",
    "DOTA_GAMERULES_STATE_PRE_GAME",
    "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
    "DOTA_GAMERULES_STATE_POST_GAME",
];

// GSI `game_state` values seen ONLY at the start of a brand new match - a
// reconnect to an already-running match resumes directly in
// GAME_IN_PROGRESS/POST_GAME, never here again. Mirrors
// stream-match-service.ts's `NEW_MATCH_SIGNAL_STATES`.
const NEW_MATCH_SIGNAL_STATES: &[&str] = &[
    "DOTA_GAMERULES_STATE_HERO_SELECTION",
    "DOTA_GAMERULES_STATE_STRATEGY_TIME",
    "DOTA_GAMERULES_STATE_PRE_GAME",
];

pub fn is_in_match_game_state(game_state: &str) -> bool {
    IN_MATCH_STATES.contains(&game_state)
}

pub fn is_new_match_signal_game_state(game_state: &str) -> bool {
    NEW_MATCH_SIGNAL_STATES.contains(&game_state)
}

/// A parsed, minimal view of one GSI tick - the only shape the detector
/// (detector.rs) is ever allowed to see. Deliberately just plain local
/// data extracted from the payload Companion already receives on
/// `127.0.0.1` - nothing here can carry a backend/network type by
/// construction, which is what makes `detector::decide`'s signature
/// pinnable as backend-independent (see the regression test in
/// detector.rs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GsiSnapshot {
    pub game_state: String,
    pub activity: Option<String>,
    pub custom_game_name: Option<String>,
    pub match_id: Option<String>,
    pub win_team: Option<String>,
    pub hero_id: Option<i64>,
    pub team_name: Option<String>,
    pub telemetry: MatchTelemetry,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MatchTelemetry {
    pub kills: Option<i64>,
    pub deaths: Option<i64>,
    pub assists: Option<i64>,
    pub inventory: Vec<Option<String>>,
}

impl GsiSnapshot {
    pub fn player_is_playing(&self) -> bool {
        self.activity.as_deref() == Some("playing")
    }

    pub fn is_in_match(&self) -> bool {
        self.player_is_playing() && is_in_match_game_state(&self.game_state)
    }

    /// POST_GAME is a lifecycle signal in its own right. Real Dota payloads
    /// can switch `player.activity` to `menu` (and omit player/hero fields)
    /// before the post-game map state disappears. Requiring `playing` here
    /// makes the detector interpret a completed match as a disconnect.
    pub fn is_match_lifecycle_tick(&self) -> bool {
        self.is_post_game() || self.is_in_match()
    }

    pub fn is_post_game(&self) -> bool {
        self.game_state == "DOTA_GAMERULES_STATE_POST_GAME"
    }
}

fn as_str<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn non_zero_match_id(raw: Option<&str>) -> Option<String> {
    raw.filter(|value| *value != "0").map(|value| value.to_string())
}

fn scalar_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(raw) => non_zero_match_id(Some(raw)),
        Value::Number(raw) => non_zero_match_id(Some(&raw.to_string())),
        _ => None,
    }
}

fn non_blank_string(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn extract_inventory(value: Option<&Value>) -> Vec<Option<String>> {
    (0..9)
        .map(|index| {
            value
                .and_then(|items| items.get(format!("slot{index}")))
                .and_then(|slot| slot.get("name"))
                .and_then(Value::as_str)
                .filter(|name| name.starts_with("item_"))
                .map(str::to_string)
        })
        .collect()
}

/// Parses one raw GSI payload into a `GsiSnapshot`, or `None` if it doesn't
/// even have a `map.game_state` (nothing to act on this tick). Mirrors the
/// `asRecord`/`asString`/`asNumber` extraction at the top of
/// `processGsiPayloadForMatch` in stream-match-service.ts.
pub fn parse(payload: &Value) -> Option<GsiSnapshot> {
    let game_state = as_str(payload, "/map/game_state")?.to_string();
    Some(GsiSnapshot {
        game_state,
        activity: as_str(payload, "/player/activity").map(str::to_string),
        custom_game_name: non_blank_string(as_str(payload, "/map/customgamename")),
        match_id: scalar_id(payload.pointer("/map/matchid")),
        win_team: as_str(payload, "/map/win_team").map(str::to_string),
        hero_id: payload.pointer("/hero/id").and_then(Value::as_i64),
        team_name: as_str(payload, "/player/team_name").map(str::to_string),
        telemetry: MatchTelemetry {
            kills: payload.pointer("/player/kills").and_then(Value::as_i64),
            deaths: payload.pointer("/player/deaths").and_then(Value::as_i64),
            assists: payload.pointer("/player/assists").and_then(Value::as_i64),
            inventory: extract_inventory(payload.get("items")),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_full_in_progress_tick() {
        let payload = json!({
            "player": { "activity": "playing", "team_name": "radiant" },
            "hero": { "id": 14 },
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": "12345" },
        });
        let snapshot = parse(&payload).unwrap();
        assert_eq!(snapshot.game_state, "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS");
        assert_eq!(snapshot.hero_id, Some(14));
        assert_eq!(snapshot.team_name.as_deref(), Some("radiant"));
        assert_eq!(snapshot.match_id.as_deref(), Some("12345"));
        assert_eq!(snapshot.telemetry.inventory.len(), 9);
        assert!(snapshot.is_in_match());
        assert!(!snapshot.is_post_game());
    }

    #[test]
    fn parses_kda_main_inventory_and_backpack_from_real_gsi_shape() {
        let payload = json!({
            "player": { "activity": "playing", "kills": 8, "deaths": 3, "assists": 14 },
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
            "items": {
                "slot0": { "name": "item_blink" },
                "slot6": { "name": "item_tpscroll" },
                "slot8": { "name": "not_an_item" }
            }
        });
        let snapshot = parse(&payload).unwrap();
        assert_eq!((snapshot.telemetry.kills, snapshot.telemetry.deaths, snapshot.telemetry.assists), (Some(8), Some(3), Some(14)));
        assert_eq!(snapshot.telemetry.inventory[0].as_deref(), Some("item_blink"));
        assert_eq!(snapshot.telemetry.inventory[6].as_deref(), Some("item_tpscroll"));
        assert_eq!(snapshot.telemetry.inventory[8], None);
    }

    #[test]
    fn a_zero_match_id_is_treated_as_unknown() {
        let payload = json!({
            "player": { "activity": "playing" },
            "map": { "game_state": "DOTA_GAMERULES_STATE_HERO_SELECTION", "matchid": "0" },
        });
        let snapshot = parse(&payload).unwrap();
        assert_eq!(snapshot.match_id, None);
    }


    #[test]
    fn parses_numeric_match_id_from_production_shaped_payload() {
        let payload = json!({
            "player": { "activity": "menu" },
            "map": {
                "game_state": "DOTA_GAMERULES_STATE_POST_GAME",
                "matchid": 8123456789_i64,
                "win_team": "radiant"
            }
        });
        let snapshot = parse(&payload).unwrap();
        assert_eq!(snapshot.match_id.as_deref(), Some("8123456789"));
        assert!(snapshot.is_match_lifecycle_tick());
    }

    #[test]
    fn empty_custom_game_name_is_a_normal_match_not_a_custom_lobby() {
        let payload = json!({
            "player": { "activity": "playing", "team_name": "radiant" },
            "hero": { "id": 14 },
            "map": {
                "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
                "customgamename": ""
            }
        });
        assert_eq!(parse(&payload).unwrap().custom_game_name, None);
    }

    #[test]
    fn missing_game_state_parses_to_none() {
        let payload = json!({ "player": { "activity": "playing" } });
        assert!(parse(&payload).is_none());
    }

    #[test]
    fn not_playing_is_never_in_match_even_in_an_in_match_game_state() {
        let payload = json!({
            "player": { "activity": "menu" },
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
        });
        let snapshot = parse(&payload).unwrap();
        assert!(!snapshot.is_in_match());
    }
}
