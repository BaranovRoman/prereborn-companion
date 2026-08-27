pub mod assets;
pub mod catalog;
pub mod config;
pub mod events;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::storage;
use catalog::AbilityStatus;
use events::{detect_events, hero_identity_changed, GameSoundEvent, GameSoundEventKind};

/// Wall-clock milliseconds since the Unix epoch - deliberately the OS clock,
/// not a monotonic `Instant`, so a Rust-side timestamp embedded in an IPC
/// payload (`GameSoundPlayPayload::emitted_at_ms`) can be compared directly
/// against a `Date.now()` timestamp taken on the frontend side of the same
/// machine (see useGameSoundEngine.ts) - both read the same underlying
/// system clock, so the cross-language/cross-process gap is meaningful
/// without needing to synchronize two different clock sources.
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// WK-108 latency addendum - short id correlating one detected event's
/// stages across the local pipeline (Rust detect -> emit -> frontend
/// receive -> audio.play()) in the shared rolling log, so a tester can grep
/// one id and read the whole timeline after a stream. A monotonic counter is
/// enough - this only needs to be unique within one Companion session's log
/// file, not globally.
fn next_correlation_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("{:06x}", COUNTER.fetch_add(1, Ordering::Relaxed) & 0xFFFFFF)
}

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
    // WK-108 latency addendum - lets the frontend correlate its own
    // stage logs with Rust's, and measure the actual IPC/decode/play
    // transit time against a shared wall clock (see `now_ms` above).
    correlation_id: String,
    emitted_at_ms: u64,
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

/// Resolves which bound asset (if any) should play for each detected event -
/// pure local-settings lookup, deliberately taking only `bindings`/
/// `known_assets` (both already-cloned `GameSoundSettings` fields) and never
/// anything backend/session/heartbeat-shaped. This is the architectural
/// backend-independence guard for Game Sounds (see this module's doc
/// comment and the WK-108 latency investigation): a valid Dota GSI
/// transition resolves to "play this asset" purely from local state, so it
/// behaves identically whether or not prereborn.ru is reachable - there is
/// no backend-shaped value this function could even consult. A future
/// change that made playback depend on backend reachability would have to
/// thread a new parameter into this signature, which
/// `playback_resolution_never_depends_on_backend_state` below pins against.
fn resolve_playback<'a>(
    detected: &[GameSoundEvent],
    bindings: &[config::SoundBinding],
    known_assets: &'a [config::ManagedSoundAsset],
) -> Vec<(String, &'a config::ManagedSoundAsset)> {
    detected
        .iter()
        .filter_map(|event| {
            let binding = bindings.iter().find(|b| b.event_id == event.id && b.kind == event.kind)?;
            let asset = known_assets.iter().find(|a| a.id == binding.asset_id)?;
            Some((event.id.clone(), asset))
        })
        .collect()
}

/// Entry point called from server/mod.rs's process_gsi_body, mirroring
/// obs::handle_gsi - the one place raw GSI reaches this feature. Everything
/// downstream (the event emitted to the frontend, the sound engine that
/// reacts to it) only ever sees a normalized event, never this raw
/// `Value` - "sound subsystem не должен сам сравнивать raw GSI snapshots"
/// per the task.
pub fn handle_gsi(app: &AppHandle, payload: &Value) {
    // WK-108 latency addendum - as close as this process gets to "Companion
    // received this GSI snapshot" (stage C in the pipeline this is meant to
    // make measurable: player action in Dota -> GSI sent -> Companion
    // receives -> detect -> frontend receives -> audio plays). A/B (what
    // happens before this point, inside Dota/the OS network stack) can't be
    // measured from here at all - see the WK-108 latency report.
    let gsi_received_at = now_ms();
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
    // WK-108 latency addendum - one correlation id per detected event, so
    // its "gsi-received"/"detected" stages here and its "play-request-
    // emitted"/"frontend-received"/"audio-play-requested"/"audio-playing"
    // stages further down (Rust thread + frontend, see
    // useGameSoundEngine.ts) all land under the same id in the shared
    // rolling log. Only ever generated for an event `detect_events` actually
    // found - never once per GSI tick.
    let mut correlation_ids: HashMap<String, String> = HashMap::new();

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
        let detected_at = now_ms();
        let correlation_id = correlation_ids
            .entry(event.id.clone())
            .or_insert_with(next_correlation_id)
            .clone();
        storage::append_rolling_log(
            app,
            &format!(
                "[game-sounds][{correlation_id}] gsi-received t={gsi_received_at}; detected {:?} {} (+{}ms) ({evidence})",
                event.kind,
                event.id,
                detected_at.saturating_sub(gsi_received_at),
            ),
        );
    }

    if !enabled {
        return;
    }

    for (event_id, asset) in resolve_playback(&detected, &bindings, &known_assets) {
        let asset = asset.clone();
        let app_for_thread = app.clone();
        let volume = master_volume;
        let correlation_id = correlation_ids.get(&event_id).cloned().unwrap_or_else(next_correlation_id);
        // Never blocks the GSI thread (задача п.7) - file IO + base64
        // encoding happen off it, the same "spawn a thread, don't await it
        // here" shape every other GSI-triggered side effect in this
        // codebase already uses (see obs::schedule_switch).
        std::thread::spawn(move || {
            let Ok(bytes) = assets::read_file(&app_for_thread, &asset) else { return };
            let ext = asset.file_name.rsplit('.').next().unwrap_or("wav");
            let emitted_at_ms = now_ms();
            storage::append_rolling_log(
                &app_for_thread,
                &format!(
                    "[game-sounds][{correlation_id}] play-request-emitted t={emitted_at_ms} (+{}ms since gsi-received)",
                    emitted_at_ms.saturating_sub(gsi_received_at),
                ),
            );
            let _ = app_for_thread.emit(
                "game-sound-play",
                GameSoundPlayPayload {
                    event_id,
                    base64: BASE64.encode(bytes),
                    mime: assets::mime_for_extension(ext).to_string(),
                    volume,
                    correlation_id,
                    emitted_at_ms,
                },
            );
        });
    }
}

/// Appends one frontend-side timing-instrumentation line to the same shared
/// rolling log the Rust-side stages above write to - called from
/// useGameSoundEngine.ts via the `log_game_sound_timing` command, once per
/// stage ("frontend-received" / "audio-play-requested" / "audio-playing"),
/// only for an event it actually received a "game-sound-play" for. Never
/// awaited by playback itself (fire-and-forget on the frontend side) so this
/// can't add latency to the thing it's measuring.
pub fn log_frontend_timing(app: &AppHandle, correlation_id: &str, stage: &str, elapsed_ms: u64) {
    storage::append_rolling_log(
        app,
        &format!("[game-sounds][{correlation_id}] {stage} (+{elapsed_ms}ms since play-request-emitted)"),
    );
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
    // WK-108 - `Experimental` abilities are bindable the same as `Supported`
    // ones (both carry a real detector signal, see events.rs); only
    // `Unsupported` (no usable GSI signal at all) is rejected here. The
    // Supported/Experimental distinction is surfaced to the user in the UI
    // as an honesty caveat, not enforced as a binding gate.
    let is_bindable = match kind {
        GameSoundEventKind::ItemUsed => catalog::find_item(&event_id).is_some_and(|i| i.supported),
        GameSoundEventKind::AbilityCast => {
            catalog::find_ability(&event_id).is_some_and(|a| a.status != AbilityStatus::Unsupported)
        }
    };
    if !is_bindable {
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
    // WK-108 - `Experimental` abilities are bindable the same as `Supported`
    // ones (both carry a real detector signal, see events.rs); only
    // `Unsupported` (no usable GSI signal at all) is rejected here. The
    // Supported/Experimental distinction is surfaced to the user in the UI
    // as an honesty caveat, not enforced as a binding gate.
    let is_bindable = match kind {
        GameSoundEventKind::ItemUsed => catalog::find_item(&event_id).is_some_and(|i| i.supported),
        GameSoundEventKind::AbilityCast => {
            catalog::find_ability(&event_id).is_some_and(|a| a.status != AbilityStatus::Unsupported)
        }
    };
    if !is_bindable {
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
    let slot_at = |payload: &Value, key: &str| -> Option<Value> {
        payload.get(section)?.as_object()?.get(key).cloned()
    };
    let find_slot_by_name = |payload: &Value| -> Option<Value> {
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
    // WK-109 forensic finding: the old version of this function searched
    // `current` independently by name, which can pick the WRONG slot when
    // the same item name occupies more than one slot at once (e.g. two
    // Blood Grenades mid-courier-purchase - one just used, one sitting
    // unrelated at the courier). That produced evidence text describing a
    // real-looking but IRRELEVANT transition (e.g. "charges 2\u{2192}2, cooldown
    // 0\u{2192}9" from the untouched courier slot) for an event that actually
    // fired from a completely different, correctly-matched slot - a
    // misleading-diagnostics bug, not a detection bug (the actual
    // ItemUsed/AbilityCast decision was always correct; only this evidence
    // string could lie about which slot/values produced it).
    //
    // Fix: among every slot key in `previous` whose name matches `id`,
    // prefer the one where `previous[key] != current[key]` - i.e. the slot
    // where something actually changed, the same slot the real detector
    // would have matched. Only falls back to the first found key when none
    // of the candidates changed at all (a static id whose evidence is
    // legitimately "nothing moved here").
    let candidate_keys: Vec<String> = previous
        .get(section)
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter(|(_, slot)| slot.get("name").and_then(Value::as_str).is_some_and(matches_id))
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default();
    let slot_key = candidate_keys
        .into_iter()
        .max_by_key(|key| (slot_at(previous, key) != slot_at(current, key)) as u8);
    let (prev_slot, curr_slot) = match &slot_key {
        Some(key) => (slot_at(previous, key), slot_at(current, key)),
        None => (find_slot_by_name(previous), find_slot_by_name(current)),
    };
    // "Gone" covers both shapes GSI can use for an emptied slot: the key
    // dropped entirely, or the key still present with name "empty" - the
    // same two-shape check detect_item_events itself uses.
    let is_gone = |slot: &Option<Value>| -> bool {
        slot.is_none() || slot.as_ref().and_then(|s| s.get("name")).and_then(Value::as_str) == Some("empty")
    };

    match kind {
        GameSoundEventKind::ItemUsed if is_gone(&curr_slot) => {
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

    // WK-108 latency addendum - "Game Sounds must work 100% locally,
    // independent of prereborn.ru". `resolve_playback`'s signature is the
    // architectural proof: it only ever sees local `SoundBinding`/
    // `ManagedSoundAsset` state, nothing backend/session/heartbeat-shaped,
    // so a valid Dota GSI transition resolves to "play this asset"
    // identically whether or not the backend is reachable. If a future
    // change threaded backend reachability into this decision, this
    // signature would have to change, and this test would need to change to
    // cover it - that's the point of pinning it here.
    #[test]
    fn playback_resolution_never_depends_on_backend_state() {
        let detected = vec![GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_tango".to_string() }];
        let bindings = vec![config::SoundBinding {
            event_id: "item_tango".to_string(),
            kind: GameSoundEventKind::ItemUsed,
            asset_id: "asset-1".to_string(),
        }];
        let known_assets = vec![config::ManagedSoundAsset {
            id: "asset-1".to_string(),
            file_name: "asset-1.wav".to_string(),
            original_name: "chomp.wav".to_string(),
            size_bytes: 1024,
        }];

        let resolved = resolve_playback(&detected, &bindings, &known_assets);

        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].0, "item_tango");
        assert_eq!(resolved[0].1.id, "asset-1");
    }

    #[test]
    fn playback_resolution_skips_events_with_no_binding_or_a_binding_pointing_at_a_missing_asset() {
        let detected = vec![
            GameSoundEvent { kind: GameSoundEventKind::ItemUsed, id: "item_no_binding".to_string() },
            GameSoundEvent { kind: GameSoundEventKind::AbilityCast, id: "pudge_meat_hook".to_string() },
        ];
        let bindings = vec![config::SoundBinding {
            event_id: "pudge_meat_hook".to_string(),
            kind: GameSoundEventKind::AbilityCast,
            asset_id: "asset-missing".to_string(),
        }];
        let known_assets: Vec<config::ManagedSoundAsset> = vec![];

        assert!(resolve_playback(&detected, &bindings, &known_assets).is_empty());
    }

    #[test]
    fn describes_a_charges_based_item_transition() {
        let prev = json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } });
        let curr = json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } });
        assert_eq!(
            describe_transition(GameSoundEventKind::ItemUsed, "item_tango", &prev, &curr),
            "charges 2\u{2192}1, cooldown ?\u{2192}?"
        );
    }

    // WK-109 forensic finding - two simultaneous Blood-Grenade-named slots
    // (e.g. one just used, one an unrelated duplicate sitting at the
    // courier) used to make this function grab whichever slot came first in
    // key order, regardless of which one actually changed - producing
    // real-looking-but-irrelevant evidence text like "charges 2\u{2192}2" for an
    // event that really came from a different slot. `slot0` is the
    // untouched decoy (alphabetically first, so old code would have picked
    // it); `slot1` is where the real transition happened.
    #[test]
    fn describes_the_slot_that_actually_changed_not_whichever_matching_slot_sorts_first() {
        let prev = json!({ "items": {
            "slot0": { "name": "item_blood_grenade", "charges": 2, "cooldown": 0 },
            "slot1": { "name": "item_blood_grenade", "charges": 2, "cooldown": 0 }
        } });
        let curr = json!({ "items": {
            "slot0": { "name": "item_blood_grenade", "charges": 2, "cooldown": 0 },
            "slot1": { "name": "item_blood_grenade", "charges": 1, "cooldown": 10 }
        } });
        assert_eq!(
            describe_transition(GameSoundEventKind::ItemUsed, "item_blood_grenade", &prev, &curr),
            "charges 2\u{2192}1, cooldown 0\u{2192}10"
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
