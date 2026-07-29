use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::diff::type_name;

/// Whether `section` is one of the GSI "data" sections Companion's config
/// actually requests - reads directly from `gsi::config::data_sections()`
/// (the exact list the installed .cfg file is built from - see that
/// module's docs) rather than keeping a second hardcoded copy here, so this
/// can never silently drift from what Companion actually asks Dota for.
/// Dota sending anything under a known section is "expected" even though
/// most of it is never parsed - a much weaker claim than "we do something
/// with this field" (see `USED_PATHS` below).
fn is_known_gsi_section(section: &str) -> bool {
    crate::gsi::config::data_sections().iter().any(|(name, enabled)| *enabled && *name == section)
}

/// Paths the Companion codebase actually reads today (server/mod.rs's
/// `summarize_payload`, which is the only place that inspects individual GSI
/// fields - everything else is forwarded to the backend as an opaque blob).
/// Kept as a literal list rather than derived from any schema because there
/// is no typed GSI model in this codebase (see diagnostics module docs).
/// This is the narrow "currently_used" signal - the interesting gap for
/// finding new feature candidates is exactly `known_to_companion == true &&
/// currently_used == false` (a field in a section we already asked for, that
/// nothing reads yet) - see `unused-known-fields.json` / possible-features.md
/// in export.rs.
const USED_PATHS: &[&str] = &["map.game_state", "player.activity", "hero.name"];

fn top_level_section(path: &str) -> &str {
    path.split(['.', '[']).next().unwrap_or(path)
}

/// GSI sometimes keys objects by steam ID / slot index instead of using a
/// JSON array (e.g. a hypothetical `player.team2.<steamid32>`). An object
/// counts as "dynamic-keyed" when it has 2+ keys and every key is pure
/// ASCII digits - single-key numeric objects are left alone since one
/// sample isn't enough to tell a dynamic key from a coincidentally numeric
/// fixed field name.
fn is_dynamic_keyed(map: &serde_json::Map<String, Value>) -> bool {
    map.len() >= 2 && map.keys().all(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
}

const MAX_SAMPLE_VALUES: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldInfo {
    pub path: String,
    pub types: BTreeSet<String>,
    pub first_game_state: Option<String>,
    pub last_game_state: Option<String>,
    /// Only counts changes for leaf/primitive values - container (object /
    /// array) paths always report 0 here, their presence is what's tracked.
    pub change_count: u32,
    pub sample_values: Vec<Value>,
    pub ever_disappeared_after_appearing: bool,
    /// True if this path's top-level section (map/player/hero/...) is one
    /// Companion's GSI config asks Dota for - see `KNOWN_GSI_SECTIONS`.
    pub known_to_companion: bool,
    /// True only for the handful of exact paths some Companion code path
    /// actually reads today - see `USED_PATHS`. `known_to_companion == true
    /// && currently_used == false` is the interesting case: Dota is already
    /// sending it, nothing reads it yet.
    pub currently_used: bool,
    #[serde(skip)]
    currently_present: bool,
    #[serde(skip)]
    last_value: Option<Value>,
}

impl FieldInfo {
    fn new(path: String) -> Self {
        let known_to_companion = is_known_gsi_section(top_level_section(&path));
        let currently_used = USED_PATHS.contains(&path.as_str());
        FieldInfo {
            path,
            types: BTreeSet::new(),
            first_game_state: None,
            last_game_state: None,
            change_count: 0,
            sample_values: Vec::new(),
            ever_disappeared_after_appearing: false,
            known_to_companion,
            currently_used,
            currently_present: false,
            last_value: None,
        }
    }

    fn record(&mut self, kind: &'static str, sample: Option<Value>, game_state: Option<&str>) {
        self.types.insert(kind.to_string());
        if self.first_game_state.is_none() {
            self.first_game_state = game_state.map(str::to_string);
        }
        if let Some(gs) = game_state {
            self.last_game_state = Some(gs.to_string());
        }
        self.currently_present = true;

        match (&self.last_value, &sample) {
            (None, Some(v)) => {
                self.push_sample(v.clone());
                self.last_value = sample;
            }
            (Some(prev), Some(v)) if prev != v => {
                self.change_count += 1;
                self.push_sample(v.clone());
                self.last_value = sample;
            }
            _ => {}
        }
    }

    fn push_sample(&mut self, value: Value) {
        if self.sample_values.len() < MAX_SAMPLE_VALUES && !self.sample_values.contains(&value) {
            self.sample_values.push(value);
        }
    }
}

#[derive(Debug, Default)]
pub struct FieldCatalog {
    pub fields: BTreeMap<String, FieldInfo>,
}

impl FieldCatalog {
    pub fn new() -> Self {
        FieldCatalog::default()
    }

    /// Rebuilds a catalog from a previously-persisted `catalog.json` (a flat
    /// `Vec<FieldInfo>`) - used when recovering a session after a Companion
    /// restart. The `currently_present`/`last_value` bookkeeping fields are
    /// intentionally lost (they're `#[serde(skip)]`) since a recovered
    /// session is always treated as finalized and never observes new ticks.
    pub fn from_field_list(fields: Vec<FieldInfo>) -> Self {
        FieldCatalog {
            fields: fields.into_iter().map(|f| (f.path.clone(), f)).collect(),
        }
    }

    /// Walks one (already-redacted) payload and updates every path touched.
    /// Also flips `ever_disappeared_after_appearing` for any path that was
    /// present on a previous call but is missing from this one.
    pub fn observe(&mut self, payload: &Value, game_state: Option<&str>) {
        let mut flat = Vec::new();
        flatten(payload, String::new(), &mut flat);

        let mut seen: HashSet<&str> = HashSet::with_capacity(flat.len());
        for (path, kind, sample) in &flat {
            seen.insert(path.as_str());
            self.fields
                .entry(path.clone())
                .or_insert_with(|| FieldInfo::new(path.clone()))
                .record(kind, sample.clone(), game_state);
        }

        for (path, info) in self.fields.iter_mut() {
            if info.currently_present && !seen.contains(path.as_str()) {
                info.currently_present = false;
                info.ever_disappeared_after_appearing = true;
            }
        }
    }

}

/// Flattens a JSON value into (catalog_path, type_name, sample_value) triples.
/// Arrays normalize their index to `[]`; dynamic-keyed objects (see
/// `is_dynamic_keyed`) normalize the key to `*` - both so the catalog stays
/// bounded in size across a long session. Raw snapshot files saved elsewhere
/// are NOT run through this normalization, only this in-memory catalog is.
fn flatten(value: &Value, prefix: String, out: &mut Vec<(String, &'static str, Option<Value>)>) {
    match value {
        Value::Object(map) => {
            if !prefix.is_empty() {
                out.push((prefix.clone(), type_name(value), None));
            }
            let dynamic = is_dynamic_keyed(map);
            for (key, val) in map {
                let segment = if dynamic { "*" } else { key.as_str() };
                let child_path = if prefix.is_empty() {
                    segment.to_string()
                } else {
                    format!("{prefix}.{segment}")
                };
                flatten(val, child_path, out);
            }
        }
        Value::Array(items) => {
            if !prefix.is_empty() {
                out.push((prefix.clone(), type_name(value), None));
            }
            let child_path = format!("{prefix}[]");
            for item in items {
                flatten(item, child_path.clone(), out);
            }
        }
        primitive => {
            if !prefix.is_empty() {
                out.push((prefix, type_name(primitive), Some(primitive.clone())));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_leaf_paths_with_types_and_samples() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "map": { "game_state": "MENU" } }), Some("MENU"));
        let info = catalog.fields.get("map.game_state").unwrap();
        assert!(info.types.contains("string"));
        assert_eq!(info.sample_values, vec![json!("MENU")]);
        assert_eq!(info.first_game_state.as_deref(), Some("MENU"));
        assert!(info.known_to_companion);
        assert!(info.currently_used, "map.game_state is read in server/mod.rs::summarize_payload");
    }

    #[test]
    fn tracks_container_paths_without_samples() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "map": { "game_state": "MENU" } }), Some("MENU"));
        let info = catalog.fields.get("map").unwrap();
        assert!(info.types.contains("object"));
        assert!(info.sample_values.is_empty());
        assert_eq!(info.change_count, 0);
    }

    #[test]
    fn known_section_but_unused_field_is_the_feature_candidate_case() {
        // "player" is a section Companion's GSI config requests (known), but
        // nothing in the codebase reads player.kills specifically (unused) -
        // this is exactly the gap the brief wants surfaced.
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "player": { "kills": 1 } }), None);
        let info = catalog.fields.get("player.kills").unwrap();
        assert!(info.known_to_companion);
        assert!(!info.currently_used);
    }

    #[test]
    fn truly_unexpected_section_is_not_known() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "some_future_gsi_section": { "field": 1 } }), None);
        let info = catalog.fields.get("some_future_gsi_section.field").unwrap();
        assert!(!info.known_to_companion);
        assert!(!info.currently_used);
    }

    #[test]
    fn change_count_increments_only_on_actual_change() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "player": { "kills": 1 } }), None);
        catalog.observe(&json!({ "player": { "kills": 1 } }), None);
        catalog.observe(&json!({ "player": { "kills": 2 } }), None);
        let info = catalog.fields.get("player.kills").unwrap();
        assert_eq!(info.change_count, 1);
        assert_eq!(info.sample_values, vec![json!(1), json!(2)]);
    }

    #[test]
    fn detects_field_disappearance_after_having_appeared() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "map": { "matchid": "123" } }), None);
        catalog.observe(&json!({ "map": {} }), None);
        let info = catalog.fields.get("map.matchid").unwrap();
        assert!(info.ever_disappeared_after_appearing);
    }

    #[test]
    fn does_not_flag_disappearance_for_a_field_never_seen() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "map": {} }), None);
        assert!(catalog.fields.get("map.matchid").is_none());
    }

    #[test]
    fn normalizes_arrays_and_dynamic_numeric_keys_but_keeps_slot_style_keys_literal() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(
            &json!({
                "events": [{ "id": 1 }, { "id": 2 }],
                "items": { "slot0": { "name": "item_tango" }, "slot1": { "name": "item_boots" } },
                "team2": { "76561198000000001": { "kills": 1 }, "76561198000000002": { "kills": 2 } }
            }),
            None,
        );
        // array index normalized away
        assert!(catalog.fields.contains_key("events[].id"));
        assert!(!catalog.fields.contains_key("events[0].id"));
        // slot0/slot1 are a small fixed vocabulary, kept literal per spec example
        assert!(catalog.fields.contains_key("items.slot0.name"));
        assert!(catalog.fields.contains_key("items.slot1.name"));
        // steamid-style dynamic keys collapse onto a single `*` path
        assert!(catalog.fields.contains_key("team2.*.kills"));
        assert!(!catalog.fields.contains_key("team2.76561198000000001.kills"));
    }

    #[test]
    fn type_change_is_recorded_in_types_set() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "hero": { "id": 1 } }), None);
        catalog.observe(&json!({ "hero": { "id": "1" } }), None);
        let info = catalog.fields.get("hero.id").unwrap();
        assert!(info.types.contains("number"));
        assert!(info.types.contains("string"));
    }

    #[test]
    fn field_info_survives_a_json_roundtrip_for_recovery() {
        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "player": { "kills": 3 } }), Some("MENU"));
        let serialized = serde_json::to_string(&catalog.fields.get("player.kills").unwrap()).unwrap();
        let restored: FieldInfo = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.path, "player.kills");
        assert_eq!(restored.change_count, 0);
        assert!(restored.known_to_companion);
        assert!(!restored.currently_used);
    }

    #[test]
    fn from_field_list_rebuilds_a_lookup_map() {
        let list = vec![FieldInfo::new("map.game_state".to_string()), FieldInfo::new("hero.id".to_string())];
        let catalog = FieldCatalog::from_field_list(list);
        assert!(catalog.fields.contains_key("map.game_state"));
        assert!(catalog.fields.contains_key("hero.id"));
    }
}
