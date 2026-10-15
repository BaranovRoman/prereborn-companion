//! Bounded GSI projection shared by the production gate and diagnostic observer.
use crate::contracts::ReplayGsi;
use serde_json::{json, Value};

/// Whitelist before deserialization. Never clone the original JSON or arbitrary nested objects.
pub fn project(raw: &Value) -> Result<ReplayGsi, &'static str> {
    if !raw.is_object(){return Err("invalid_gsi_root");}
    fn fields(raw: &Value, names: &[&str]) -> Result<Value, &'static str> {
        if !raw.is_object(){return Err("invalid_projection_object");}
        let mut result = serde_json::Map::new();
        for name in names {
            if let Some(value) = raw.get(*name) {
                if value.is_object() || value.is_array() || value.as_str().is_some_and(|s| s.len() > 128) {
                    return Err("invalid_projection_field");
                }
                result.insert((*name).into(), value.clone());
            }
        }
        Ok(Value::Object(result))
    }
    fn signals(raw: &Value, slots: &[(&str, u8)], invalid: &'static str) -> Result<Value, &'static str> {
        let map = raw.as_object().ok_or("invalid_slots")?;
        if map.len() > 32 { return Err("too_many_slots"); }
        let mut result = serde_json::Map::new();
        for (key, value) in map {
            if !slots.iter().any(|(prefix, limit)| key.strip_prefix(prefix).is_some_and(|i|
                i.parse::<u8>().is_ok_and(|n| n < *limit && i == n.to_string()))) {
                return Err(invalid);
            }
            if !value.is_object() { return Err("invalid_slot_signal"); }
            result.insert(key.clone(), fields(value, &["name", "cooldown", "charges"])?);
        }
        Ok(Value::Object(result))
    }
    let mut result = serde_json::Map::new();
    for (name, allowed) in [
        ("player", &["activity", "team_name", "kills", "deaths", "assists"][..]),
        ("map", &["game_state", "matchid", "customgamename", "win_team"][..]),
        ("hero", &["id"][..]),
    ] {
        if let Some(value) = raw.get(name).filter(|v| !v.is_null()) {
            result.insert(name.into(), fields(value, allowed)?);
        }
    }
    // Hero inventory/backpack, stash, TP and neutral slots are distinct GSI key families.
    // Keep the existing bounded ability envelope; never accept an item key as an ability.
    for (name, slots, invalid) in [
        ("items", &[("slot",9),("stash",6),("teleport",1),("neutral",1)][..], "invalid_item_slot"),
        ("abilities", &[("ability",32)][..], "invalid_ability_slot"),
    ] {
        if let Some(value) = raw.get(name).filter(|v| !v.is_null()) { result.insert(name.into(), signals(value, slots, invalid)?); }
    }
    if let Some(raw) = raw.get("couriers").filter(|v| !v.is_null()) {
        let couriers = raw.as_object().ok_or("invalid_couriers")?;
        if couriers.len() > 8 { return Err("too_many_couriers"); }
        let mut result_couriers = serde_json::Map::new();
        for (key, value) in couriers {
            if key.len() > 64 || !value.is_object() { return Err("invalid_courier"); }
            // Courier uses item0..5. Retain slot0..5 compatibility with existing replay fixtures.
            if let Some(items) = value.get("items") { result_couriers.insert(format!("courier{}", result_couriers.len()), json!({"items": signals(items, &[("item",6),("slot",6)], "invalid_courier_item_slot")?})); }
        }
        result.insert("couriers".into(), Value::Object(result_couriers));
    }
    let projected: ReplayGsi = serde_json::from_value(Value::Object(result)).map_err(|_| "invalid_projection")?;
    if serde_json::to_vec(&projected).map_err(|_| "invalid_projection")?.len() > companion_plugin_protocol::MAX_FRAME - 8192 {
        return Err("projection_too_large");
    }
    Ok(projected)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value { serde_json::from_str(include_str!("fixtures/techies-inventory.json")).unwrap() }

    #[test]
    fn rejects_malformed_objects_instead_of_silently_turning_them_into_empty_frames() {
        for raw in [Value::Null,json!([]),json!(false),json!("snapshot")] {
            assert_eq!(project(&raw).unwrap_err(),"invalid_gsi_root");
        }
        for section in ["player","hero","map"] {
            for value in [json!(false),json!(42),json!([]),json!("value")] {
                let mut raw=fixture();raw[section]=value;
                assert_eq!(project(&raw).unwrap_err(),"invalid_projection_object");
            }
            let mut raw=fixture();raw[section]=Value::Null;assert!(project(&raw).is_ok());
        }
        for value in [Value::Null,json!(false),json!([]),json!("courier")] {
            let mut raw=fixture();raw["couriers"]["SENSITIVE_FIXTURE"]=value;
            assert_eq!(project(&raw).unwrap_err(),"invalid_courier");
        }
        assert!(project(&json!({})).is_ok());
    }

    #[test]
    fn realistic_inventory_and_empty_slots_preserve_semantics_without_metadata() {
        let original = fixture();
        let projected = project(&original).unwrap();
        let value = serde_json::to_value(&projected).unwrap();
        assert!(!value.to_string().contains("SENSITIVE_FIXTURE"));
        // Signal's existing wire format materializes absent cooldown/charges as null.
        let signals = |v: Value| serde_json::to_value(serde_json::from_value::<std::collections::BTreeMap<String, crate::contracts::Signal>>(v).unwrap()).unwrap();
        assert_eq!(value["items"], signals(original["items"].clone()));
        assert_eq!(value["couriers"]["courier0"]["items"], signals(original["couriers"]["SENSITIVE_FIXTURE"]["items"].clone()));
        assert_eq!(crate::gsi::parse(&original), crate::gsi::parse(&value));
        assert!(crate::match_shadow::is_new_match_evidence(&crate::gsi::parse(&value).unwrap()));
        let mut replay = crate::replay::Replay::default();
        for sequence in 1..=2 {
            let mut raw = fixture();
            if sequence == 2 { raw["abilities"]["ability2"]["cooldown"] = json!(25); }
            let result = replay.apply(crate::contracts::ReplayInput {
                sequence, observed_at_ms: sequence * 1000, snapshot: project(&raw).unwrap(), context: Default::default(), match_context: None,
            }).unwrap();
            if sequence == 1 { assert!(result.sound_signals.is_empty()); }
            else { assert_eq!(result.sound_signals.len(), 1); assert_eq!(result.sound_signals[0].id, "techies_suicide"); }
        }
    }

    #[test]
    fn rejects_unknown_noncanonical_out_of_range_and_cross_inventory_keys() {
        for (section, keys, code) in [
            ("items", &["slot9", "stash6", "teleport1", "neutral1", "item0", "ability0", "slot00", "stash-1", "slot", "slot256", "slot٠"][..], "invalid_item_slot"),
            ("abilities", &["slot0", "item0", "ability32", "ability01", "ability-1"][..], "invalid_ability_slot"),
        ] {
            for key in keys { let mut raw=fixture(); raw[section][*key]=json!({"name":"empty"}); assert_eq!(project(&raw).unwrap_err(),code,"{section}.{key}"); }
        }
        for key in ["item6", "stash0", "ability0", "item00", "item-1", "item", "item256"] {
            let mut raw=fixture();raw["couriers"]["SENSITIVE_FIXTURE"]["items"][key]=json!({});
            assert_eq!(project(&raw).unwrap_err(),"invalid_courier_item_slot");
        }
        // Empty objects are valid empty slots, but collection/count/payload bounds remain.
        let mut raw=fixture();raw["items"]["stash5"]=json!({});assert!(project(&raw).is_ok());
        raw["items"]=json!([]);assert_eq!(project(&raw).unwrap_err(),"invalid_slots");
        raw["items"]=json!({"stash0":null});assert_eq!(project(&raw).unwrap_err(),"invalid_slot_signal");
        raw["items"]=json!({"slot0":[]});assert_eq!(project(&raw).unwrap_err(),"invalid_slot_signal");
        raw["items"]=json!({"slot0":{"name":"x".repeat(129)}});assert_eq!(project(&raw).unwrap_err(),"invalid_projection_field");
        raw["items"]=json!({});raw["abilities"]=Value::Object((0..33).map(|i|(format!("ability{i}"),json!({}))).collect());assert_eq!(project(&raw).unwrap_err(),"too_many_slots");
    }

    #[test]
    fn stash_and_courier_relocation_do_not_become_consumption_after_projection() {
        let mut before=fixture();before["items"]["slot0"]=json!({"name":"item_flask"});
        for courier in [false,true] {
            let mut after=before.clone();after["items"]["slot0"]=json!({"name":"empty"});
            if courier {after["couriers"]["SENSITIVE_FIXTURE"]["items"]["item0"]=json!({"name":"item_flask"});}
            else {after["items"]["stash0"]=json!({"name":"item_flask"});}
            let previous=serde_json::to_value(project(&before).unwrap()).unwrap();
            let current=serde_json::to_value(project(&after).unwrap()).unwrap();
            let expected=crate::events::detect_events(Some(&before),&after);
            let actual=crate::events::detect_events(Some(&previous),&current);
            assert_eq!(actual,expected);assert!(actual.is_empty());
        }
    }
}
