pub mod assets;
pub mod catalog;
pub mod config;
pub mod events;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::storage;
use events::{detect_events, hero_identity_changed, GameSoundEventKind};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSoundCatalog {
    pub items: Vec<catalog::TrackedItem>,
    pub heroes: Vec<catalog::TrackedHero>,
}

pub fn get_catalog() -> GameSoundCatalog {
    GameSoundCatalog { items: catalog::item_catalog(), heroes: catalog::hero_catalog() }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameSoundEventPayload {
    kind: GameSoundEventKind,
    id: String,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameSoundPlayPayload {
    event_id: String,
    base64: String,
    mime: String,
    volume: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSoundPreviewPayload {
    pub base64: String,
    pub mime: String,
}

/// Loaded once at startup (see lib.rs's setup()) - the persisted config
/// becomes part of AppState from then on, same shape as ObsConfig
/// (storage::load_obs_config -> inner.obs_config, see obs.rs/commands.rs).
pub fn init(app: &AppHandle) {
    let settings = config::load(app);
    app.state::<AppState>().0.lock().unwrap().game_sounds_settings = settings;
}

/// Entry point called from server/mod.rs's process_gsi_body, mirroring
/// obs::handle_gsi - the one place raw GSI reaches this feature. Everything
/// downstream (the event emitted to the frontend, the sound engine that
/// reacts to it) only ever sees a normalized event, never this raw
/// `Value` - "sound subsystem не должен сам сравнивать raw GSI snapshots"
/// per the task.
pub fn handle_gsi(app: &AppHandle, payload: &Value) {
    let (detected, previous_for_evidence, enabled, master_volume, bindings, known_assets) = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();

        let previous = inner.game_sounds_previous_gsi.take();
        // A hero identity change (new match, or GSI reconnecting mid-swap)
        // makes the stale previous snapshot meaningless to diff - treated
        // exactly like Companion's own startup (no previous snapshot at
        // all) rather than let it produce a ghost event. See
        // events::hero_identity_changed's doc comment.
        let effective_previous = match &previous {
            Some(prev) if !hero_identity_changed(prev, payload) => Some(prev),
            _ => None,
        };
        let detected = detect_events(effective_previous, payload);
        inner.game_sounds_previous_gsi = Some(payload.clone());

        let settings = inner.game_sounds_settings.clone();
        (detected, previous, settings.enabled, settings.master_volume, settings.bindings, settings.assets)
    };

    if detected.is_empty() {
        return;
    }

    // Detection always fires this "something happened" signal, regardless
    // of the master toggle (задача п.8: "event detection может продолжать
    // работать" while audio doesn't play) - lightweight, no file IO.
    //
    // WK-106 follow-up (production verification diagnostics) - also writes
    // one compact line per detected event to the existing rolling log
    // (storage::append_rolling_log - already size-capped/rotated at 5MB,
    // see storage.rs, the same mechanism every other feature's breadcrumbs
    // already go through). Deliberately NOT a new capture file/subsystem:
    // this only fires on an actual detected transition (never per-tick), so
    // volume is inherently bounded by how often items/abilities actually
    // get used. Lets a tester correlate "raw before -> after" (the
    // diagnostics session's own timeline, now that items.* is also a
    // significant-path trigger - see diagnostics/session.rs) against
    // "normalized detected event" by timestamp, without needing a
    // dedicated new bounded-capture mechanism.
    for event in &detected {
        let _ = app.emit(
            "game-sound-event",
            GameSoundEventPayload {
                kind: event.kind,
                id: event.id.clone(),
                timestamp: chrono::Local::now().to_rfc3339(),
            },
        );
        let evidence = previous_for_evidence
            .as_ref()
            .map(|prev| describe_transition(event.kind, &event.id, prev, payload))
            .unwrap_or_else(|| "no previous snapshot".to_string());
        storage::append_rolling_log(
            app,
            &format!("[game-sounds] detected {:?} {} ({evidence})", event.kind, event.id),
        );
    }

    if !enabled {
        return;
    }

    for event in detected {
        let Some(binding) = bindings.iter().find(|b| b.event_id == event.id && b.kind == event.kind) else {
            continue;
        };
        let Some(asset) = known_assets.iter().find(|a| a.id == binding.asset_id).cloned() else {
            continue;
        };
        let app_for_thread = app.clone();
        let event_id = event.id.clone();
        let volume = master_volume;
        // Never blocks the GSI thread (задача п.7) - file IO + base64
        // encoding happen off it, the same "spawn a thread, don't await it
        // here" shape every other GSI-triggered side effect in this
        // codebase already uses (see obs::schedule_switch).
        std::thread::spawn(move || {
            let Ok(bytes) = assets::read_file(&app_for_thread, &asset) else { return };
            let ext = asset.file_name.rsplit('.').next().unwrap_or("wav");
            let _ = app_for_thread.emit(
                "game-sound-play",
                GameSoundPlayPayload {
                    event_id,
                    base64: BASE64.encode(bytes),
                    mime: assets::mime_for_extension(ext).to_string(),
                    volume,
                },
            );
        });
    }
}

pub fn get_settings(app: &AppHandle) -> config::GameSoundSettings {
    app.state::<AppState>().0.lock().unwrap().game_sounds_settings.clone()
}

pub fn update_master(app: &AppHandle, enabled: bool, volume: u8) -> Result<config::GameSoundSettings, String> {
    let mut candidate = get_settings(app);
    candidate.enabled = enabled;
    candidate.master_volume = config::clamp_volume(volume);
    commit(app, candidate)
}

/// Persists `candidate` to disk first and only then makes it the live
/// AppState value - every mutating operation in this module goes through
/// this instead of mutating AppState directly before saving, so a
/// `config::save` I/O failure can never leave the in-memory settings
/// (what the rest of the app reads immediately afterwards) diverged from
/// what's actually on disk.
fn commit(app: &AppHandle, candidate: config::GameSoundSettings) -> Result<config::GameSoundSettings, String> {
    config::save(app, &candidate).map_err(|e| e.to_string())?;
    app.state::<AppState>().0.lock().unwrap().game_sounds_settings = candidate.clone();
    Ok(candidate)
}

/// Deletes an asset that's no longer referenced by any binding - the file on
/// disk plus its entry in the persisted asset list. A no-op if `asset_id`
/// wasn't tracked (already gone) rather than an error, matching
/// assets::delete_file_from's own best-effort contract. Best-effort on the
/// save too: the asset is already unreferenced in the settings this returns
/// to the caller either way, so a failure here would only leave a harmless
/// unreferenced-but-still-on-disk file for a future cleanup pass, not a
/// wrong in-memory/disk split (see `commit` above for the case that matters).
fn cleanup_orphan_asset(app: &AppHandle, asset_id: &str) {
    let mut candidate = get_settings(app);
    let index = candidate.assets.iter().position(|a| a.id == asset_id);
    let Some(index) = index else { return };
    let asset = candidate.assets.remove(index);
    assets::delete_file(app, &asset);
    let _ = commit(app, candidate);
}

pub fn set_binding(
    app: &AppHandle,
    event_id: String,
    kind: GameSoundEventKind,
    asset_id: String,
) -> Result<config::GameSoundSettings, String> {
    let is_supported = match kind {
        GameSoundEventKind::ItemUsed => catalog::find_item(&event_id).is_some_and(|i| i.supported),
        GameSoundEventKind::AbilityCast => catalog::find_ability(&event_id).is_some_and(|a| a.supported),
    };
    if !is_supported {
        return Err("Это событие не поддерживается текущим GSI.".to_string());
    }

    let mut candidate = get_settings(app);
    if !candidate.assets.iter().any(|a| a.id == asset_id) {
        return Err("Звуковой файл не найден — импортируйте его заново.".to_string());
    }
    let displaced = config::upsert_binding(&mut candidate, &event_id, kind, &asset_id);
    let orphaned_asset_id = displaced.filter(|id| !config::is_asset_referenced(&candidate, id));

    commit(app, candidate)?;
    if let Some(orphan_id) = orphaned_asset_id {
        cleanup_orphan_asset(app, &orphan_id);
    }
    Ok(get_settings(app))
}

pub fn remove_binding(app: &AppHandle, event_id: String) -> Result<config::GameSoundSettings, String> {
    let mut candidate = get_settings(app);
    let removed = config::remove_binding(&mut candidate, &event_id);
    let orphaned_asset_id = removed.filter(|id| !config::is_asset_referenced(&candidate, id));

    commit(app, candidate)?;
    if let Some(orphan_id) = orphaned_asset_id {
        cleanup_orphan_asset(app, &orphan_id);
    }
    Ok(get_settings(app))
}

/// Imports a user-picked file and binds it to `event_id`/`kind` as one
/// atomic operation - see the WK-106 self-review note this replaced a
/// two-step "import, then separately bind" frontend flow with a failure
/// window in between (a bind failure after a successful import left an
/// orphaned managed file with nothing pointing at it). If persisting the
/// new binding fails for any reason, the just-copied file is deleted again
/// before returning the error, so a failure here never leaves anything
/// behind on disk.
pub fn import_and_bind(
    app: &AppHandle,
    event_id: String,
    kind: GameSoundEventKind,
    source_path: std::path::PathBuf,
    original_name: String,
) -> Result<config::GameSoundSettings, String> {
    let is_supported = match kind {
        GameSoundEventKind::ItemUsed => catalog::find_item(&event_id).is_some_and(|i| i.supported),
        GameSoundEventKind::AbilityCast => catalog::find_ability(&event_id).is_some_and(|a| a.supported),
    };
    if !is_supported {
        return Err("Это событие не поддерживается текущим GSI.".to_string());
    }

    let asset = assets::import_file(app, &source_path, &original_name)?;

    let mut candidate = get_settings(app);
    candidate.assets.push(asset.clone());
    let displaced = config::upsert_binding(&mut candidate, &event_id, kind, &asset.id);
    let orphaned_asset_id = displaced.filter(|id| !config::is_asset_referenced(&candidate, id));

    if let Err(error) = commit(app, candidate) {
        assets::delete_file(app, &asset);
        return Err(error);
    }
    if let Some(orphan_id) = orphaned_asset_id {
        cleanup_orphan_asset(app, &orphan_id);
    }
    Ok(get_settings(app))
}

pub fn preview_sound(app: &AppHandle, asset_id: String) -> Result<GameSoundPreviewPayload, String> {
    let asset = {
        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        inner.game_sounds_settings.assets.iter().find(|a| a.id == asset_id).cloned()
    }
    .ok_or_else(|| "Звук не найден.".to_string())?;
    let bytes = assets::read_file(app, &asset)?;
    let ext = asset.file_name.rsplit('.').next().unwrap_or("wav");
    Ok(GameSoundPreviewPayload { base64: BASE64.encode(bytes), mime: assets::mime_for_extension(ext).to_string() })
}

/// Compact "field: before -> after" description for the rolling-log line in
/// `handle_gsi` above - diagnostic-only, computed here rather than inside
/// `events::detect_events` so the actual `GameSoundEvent` handed to the
/// sound engine stays exactly what the task calls for (a normalized event,
/// no raw GSI attached). Re-scans the same previous/current payload the
/// detector already used, looking only at the one item/ability slot whose
/// `name` matches `id` - not a general-purpose diff, just enough to answer
/// "why did this fire" for WK-106's production verification.
fn describe_transition(kind: GameSoundEventKind, id: &str, previous: &Value, current: &Value) -> String {
    let section = match kind {
        GameSoundEventKind::ItemUsed => "items",
        GameSoundEventKind::AbilityCast => "abilities",
    };
    // WK-107 - `id` is always the canonical ability id (see events.rs's
    // detect_ability_events), but the raw GSI slot this tick's transition
    // actually happened in may carry the alias name instead (Reactive
    // Tazer's "_stop" variant) - canonicalize before matching so this still
    // finds the right slot for a toggle-rename event, not just cooldown/
    // charges-based ones.
    let matches_id = |raw_name: &str| -> bool {
        match kind {
            GameSoundEventKind::AbilityCast => catalog::canonicalize_ability_name(raw_name) == id,
            GameSoundEventKind::ItemUsed => raw_name == id,
        }
    };
    let find_slot = |payload: &Value| -> Option<Value> {
        payload
            .get(section)?
            .as_object()?
            .values()
            .find(|slot| slot.get("name").and_then(Value::as_str).is_some_and(matches_id))
            .cloned()
    };
    let field = |slot: &Option<Value>, key: &str| -> String {
        slot.as_ref()
            .and_then(|s| s.get(key))
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".to_string())
    };
    let raw_name = |slot: &Option<Value>| -> String {
        slot.as_ref()
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string()
    };
    let has_field = |slot: &Option<Value>, key: &str| slot.as_ref().is_some_and(|s| s.get(key).is_some());
    let prev_slot = find_slot(previous);
    let curr_slot = find_slot(current);

    match kind {
        GameSoundEventKind::ItemUsed if curr_slot.is_none() => {
            format!("slot emptied (was charges={})", field(&prev_slot, "charges"))
        }
        GameSoundEventKind::ItemUsed => format!(
            "charges {}\u{2192}{}, cooldown {}\u{2192}{}",
            field(&prev_slot, "charges"),
            field(&curr_slot, "charges"),
            field(&prev_slot, "cooldown"),
            field(&curr_slot, "cooldown"),
        ),
        // Toggle-rename ability (Reactive Tazer) - the name change itself
        // is the evidence, cooldown/charges don't move.
        GameSoundEventKind::AbilityCast if raw_name(&prev_slot) != raw_name(&curr_slot) => {
            format!("name {}\u{2192}{}", raw_name(&prev_slot), raw_name(&curr_slot))
        }
        // Charge-based ultimate (Proximity Mines).
        GameSoundEventKind::AbilityCast if has_field(&prev_slot, "charges") || has_field(&curr_slot, "charges") => {
            format!("charges {}\u{2192}{}", field(&prev_slot, "charges"), field(&curr_slot, "charges"))
        }
        GameSoundEventKind::AbilityCast => format!(
            "cooldown {}\u{2192}{}",
            field(&prev_slot, "cooldown"),
            field(&curr_slot, "cooldown"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_a_charges_based_item_transition() {
        let prev = json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } });
        let curr = json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::ItemUsed, "item_tango", &prev, &curr),
            "charges 2\u{2192}1, cooldown ?\u{2192}?"
        );
    }

    #[test]
    fn describes_an_item_consumed_out_of_its_slot() {
        let prev = json!({ "items": { "slot0": { "name": "item_flask", "charges": 1 } } });
        let curr = json!({ "items": { "slot0": { "name": "empty" } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::ItemUsed, "item_flask", &prev, &curr),
            "slot emptied (was charges=1)"
        );
    }

    #[test]
    fn describes_a_cooldown_based_item_transition() {
        let prev = json!({ "items": { "slot0": { "name": "item_blink", "cooldown": 0 } } });
        let curr = json!({ "items": { "slot0": { "name": "item_blink", "cooldown": 12 } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::ItemUsed, "item_blink", &prev, &curr),
            "charges ?\u{2192}?, cooldown 0\u{2192}12"
        );
    }

    #[test]
    fn describes_an_ability_cast_transition() {
        let prev = json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 0 } } });
        let curr = json!({ "abilities": { "ability0": { "name": "pudge_meat_hook", "cooldown": 13 } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::AbilityCast, "pudge_meat_hook", &prev, &curr),
            "cooldown 0\u{2192}13"
        );
    }

    // WK-107 - `id` passed in is always the canonical ability id, but the
    // current tick's raw slot may carry the alias name (Reactive Tazer) -
    // this pins that describe_transition still finds it (rather than
    // falling back to "?" for every field) and reports the rename itself.
    #[test]
    fn describes_a_toggle_activate_rename_ability_transition() {
        let prev = json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer", "cooldown": 0 } } });
        let curr = json!({ "abilities": { "ability1": { "name": "techies_reactive_tazer_stop", "cooldown": 0 } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::AbilityCast, "techies_reactive_tazer", &prev, &curr),
            "name techies_reactive_tazer\u{2192}techies_reactive_tazer_stop"
        );
    }

    #[test]
    fn describes_a_charge_based_ability_transition() {
        let prev = json!({ "abilities": { "ability3": { "name": "techies_land_mines", "cooldown": 0, "charges": 3 } } });
        let curr = json!({ "abilities": { "ability3": { "name": "techies_land_mines", "cooldown": 0, "charges": 2 } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::AbilityCast, "techies_land_mines", &prev, &curr),
            "charges 3\u{2192}2"
        );
    }
}
