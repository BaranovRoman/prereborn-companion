use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::events::GameSoundEventKind;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MASTER_VOLUME: u8 = 70;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSoundAsset {
    pub id: String,
    pub file_name: String,
    pub original_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SoundBinding {
    // Item/ability internal name (catalog.rs's lookup key) - one binding per
    // event id, enforced by upsert_binding below.
    pub event_id: String,
    pub kind: GameSoundEventKind,
    pub asset_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct GameSoundSettings {
    pub schema_version: u32,
    // Master "Звуковые реакции" toggle (задача п.8) - independent of
    // ChatSettings.speechVolume/ttsEnabled (chat/chat-model.ts). Defaults to
    // `false`, same "opt in" posture as ChatSettings.soundEnabled/
    // ttsEnabled - a fresh install has no bindings yet anyway, so there's
    // nothing to play until the user sets one up.
    pub enabled: bool,
    pub master_volume: u8,
    pub bindings: Vec<SoundBinding>,
    pub assets: Vec<ManagedSoundAsset>,
}

impl Default for GameSoundSettings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            enabled: false,
            master_volume: DEFAULT_MASTER_VOLUME,
            bindings: Vec::new(),
            assets: Vec::new(),
        }
    }
}

pub fn clamp_volume(volume: u8) -> u8 {
    volume.min(100)
}

/// Replaces any existing binding for `event_id` (one binding per event,
/// last write wins) and returns the asset id it displaced, if any - the
/// caller (game_sounds::mod's `set_sound_binding` command) uses that to
/// decide whether the previous file is now orphaned (see
/// `is_asset_referenced` below) and should be deleted from disk.
pub fn upsert_binding(
    settings: &mut GameSoundSettings,
    event_id: &str,
    kind: GameSoundEventKind,
    asset_id: &str,
) -> Option<String> {
    let previous = settings
        .bindings
        .iter()
        .find(|b| b.event_id == event_id)
        .map(|b| b.asset_id.clone());
    settings.bindings.retain(|b| b.event_id != event_id);
    settings.bindings.push(SoundBinding {
        event_id: event_id.to_string(),
        kind,
        asset_id: asset_id.to_string(),
    });
    previous
}

pub fn remove_binding(settings: &mut GameSoundSettings, event_id: &str) -> Option<String> {
    let index = settings.bindings.iter().position(|b| b.event_id == event_id)?;
    Some(settings.bindings.remove(index).asset_id)
}

/// A shared-file check, not an identity check - two different bindings
/// (e.g. Tango and Healing Salve both using the same "chomp.wav") can
/// legitimately point at the same `asset_id`; this only asks "does *any*
/// binding still need this file on disk", so removing/replacing one of them
/// never deletes a file the other still relies on.
pub fn is_asset_referenced(settings: &GameSoundSettings, asset_id: &str) -> bool {
    settings.bindings.iter().any(|b| b.asset_id == asset_id)
}

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("game-sounds-config.json")
}

/// Forward-migrates a raw JSON blob to `CURRENT_SCHEMA_VERSION` before
/// deserializing - same field-default safety net `ObsConfig` already relies
/// on (`#[serde(default)]`, see obs.rs) for anything just *missing*, plus
/// one explicit place (this function) to grow real field-shape migrations
/// the next time `CURRENT_SCHEMA_VERSION` bumps, rather than only ever
/// leaning on serde defaults. A completely unparseable/corrupt blob falls
/// back to `GameSoundSettings::default()`.
pub fn migrate(mut raw: Value) -> GameSoundSettings {
    let stored_version = raw.get("schemaVersion").and_then(Value::as_u64).unwrap_or(0);
    if stored_version < CURRENT_SCHEMA_VERSION as u64 {
        if let Some(obj) = raw.as_object_mut() {
            obj.insert("schemaVersion".into(), json!(CURRENT_SCHEMA_VERSION));
        }
    }
    serde_json::from_value(raw).unwrap_or_default()
}

pub fn load(app: &AppHandle) -> GameSoundSettings {
    let Ok(raw) = fs::read_to_string(config_path(app)) else {
        return GameSoundSettings::default();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => migrate(value),
        Err(_) => GameSoundSettings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &GameSoundSettings) -> std::io::Result<()> {
    let path = config_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(settings)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_off_with_a_moderate_volume_and_nothing_bound() {
        let settings = GameSoundSettings::default();
        assert_eq!(settings.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(!settings.enabled);
        assert_eq!(settings.master_volume, DEFAULT_MASTER_VOLUME);
        assert!(settings.bindings.is_empty());
        assert!(settings.assets.is_empty());
    }

    #[test]
    fn volume_is_clamped_to_100() {
        assert_eq!(clamp_volume(50), 50);
        assert_eq!(clamp_volume(100), 100);
        assert_eq!(clamp_volume(255), 100);
    }

    #[test]
    fn enable_disable_round_trips_through_json() {
        let mut settings = GameSoundSettings::default();
        settings.enabled = true;
        let json = serde_json::to_value(&settings).unwrap();
        let restored = migrate(json);
        assert!(restored.enabled);
    }

    #[test]
    fn a_legacy_blob_missing_every_field_migrates_to_full_defaults() {
        // Simulates a config file from before this feature existed at all
        // (empty object) - same "must not fail to load" guarantee ObsConfig
        // already gives partial/legacy JSON (see obs.rs's
        // obs_config_uses_field_defaults_for_partial_legacy_json).
        let restored = migrate(json!({}));
        assert_eq!(restored, GameSoundSettings::default());
    }

    #[test]
    fn a_legacy_blob_with_only_some_fields_keeps_them_and_defaults_the_rest() {
        let restored = migrate(json!({ "enabled": true, "masterVolume": 40 }));
        assert!(restored.enabled);
        assert_eq!(restored.master_volume, 40);
        assert!(restored.bindings.is_empty());
        assert_eq!(restored.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn a_completely_corrupt_blob_falls_back_to_defaults_instead_of_failing() {
        let restored = migrate(json!("not an object at all"));
        assert_eq!(restored, GameSoundSettings::default());
    }

    #[test]
    fn adding_a_binding_then_replacing_it_returns_the_displaced_asset_id() {
        let mut settings = GameSoundSettings::default();
        assert_eq!(
            upsert_binding(&mut settings, "item_tango", GameSoundEventKind::ItemUsed, "asset-a"),
            None
        );
        assert_eq!(settings.bindings.len(), 1);
        assert_eq!(
            upsert_binding(&mut settings, "item_tango", GameSoundEventKind::ItemUsed, "asset-b"),
            Some("asset-a".to_string())
        );
        assert_eq!(settings.bindings.len(), 1);
        assert_eq!(settings.bindings[0].asset_id, "asset-b");
    }

    #[test]
    fn removing_a_binding_returns_its_asset_id_and_a_second_removal_is_a_no_op() {
        let mut settings = GameSoundSettings::default();
        upsert_binding(&mut settings, "item_tango", GameSoundEventKind::ItemUsed, "asset-a");
        assert_eq!(remove_binding(&mut settings, "item_tango"), Some("asset-a".to_string()));
        assert!(settings.bindings.is_empty());
        assert_eq!(remove_binding(&mut settings, "item_tango"), None);
    }

    #[test]
    fn shared_asset_stays_referenced_while_any_binding_still_uses_it() {
        let mut settings = GameSoundSettings::default();
        upsert_binding(&mut settings, "item_tango", GameSoundEventKind::ItemUsed, "shared-asset");
        upsert_binding(&mut settings, "item_flask", GameSoundEventKind::ItemUsed, "shared-asset");

        remove_binding(&mut settings, "item_tango");
        // item_flask still points at shared-asset - must not be reported as orphaned.
        assert!(is_asset_referenced(&settings, "shared-asset"));

        remove_binding(&mut settings, "item_flask");
        assert!(!is_asset_referenced(&settings, "shared-asset"));
    }
}
