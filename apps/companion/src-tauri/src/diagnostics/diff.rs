use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Removed,
    TypeChanged,
    ValueChanged,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffEntry {
    pub path: String,
    pub kind: ChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_value: Option<Value>,
}

/// A cap on the number of diff entries a single comparison can produce -
/// the first snapshot of a session diffs against an empty object, so without
/// a cap a single malformed/huge payload could still blow up disk usage
/// despite the "no full JSON every tick" goal. GSI payloads are a few
/// hundred fields at most in practice, so this is generous headroom, not a
/// real limit.
const MAX_DIFF_ENTRIES: usize = 2000;

pub(crate) fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Recursively diffs two arbitrary JSON values (no dependency on any known
/// TypeScript/Rust field set - walks whatever shape actually shows up).
/// Object keys are compared by name; arrays are compared positionally by
/// index (each pair only ever needs to compare one snapshot against the
/// next, so array reordering heuristics aren't worth the complexity).
pub fn diff_values(old: &Value, new: &Value) -> Vec<DiffEntry> {
    let mut out = Vec::new();
    walk(old, new, "$", &mut out);
    out
}

fn push(out: &mut Vec<DiffEntry>, entry: DiffEntry) -> bool {
    if out.len() >= MAX_DIFF_ENTRIES {
        return false;
    }
    out.push(entry);
    true
}

fn walk(old: &Value, new: &Value, path: &str, out: &mut Vec<DiffEntry>) {
    if out.len() >= MAX_DIFF_ENTRIES {
        return;
    }

    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            for (key, new_val) in new_map {
                let child_path = format!("{path}.{key}");
                match old_map.get(key) {
                    None => {
                        if !push(
                            out,
                            DiffEntry {
                                path: child_path,
                                kind: ChangeKind::Added,
                                old_value: None,
                                new_value: Some(new_val.clone()),
                            },
                        ) {
                            return;
                        }
                    }
                    Some(old_val) => walk(old_val, new_val, &child_path, out),
                }
            }
            for (key, old_val) in old_map {
                if !new_map.contains_key(key) {
                    let child_path = format!("{path}.{key}");
                    if !push(
                        out,
                        DiffEntry {
                            path: child_path,
                            kind: ChangeKind::Removed,
                            old_value: Some(old_val.clone()),
                            new_value: None,
                        },
                    ) {
                        return;
                    }
                }
            }
        }
        (Value::Array(old_items), Value::Array(new_items)) => {
            let max_len = old_items.len().max(new_items.len());
            for i in 0..max_len {
                let child_path = format!("{path}[{i}]");
                match (old_items.get(i), new_items.get(i)) {
                    (Some(o), Some(n)) => walk(o, n, &child_path, out),
                    (None, Some(n)) => {
                        if !push(
                            out,
                            DiffEntry {
                                path: child_path,
                                kind: ChangeKind::Added,
                                old_value: None,
                                new_value: Some(n.clone()),
                            },
                        ) {
                            return;
                        }
                    }
                    (Some(o), None) => {
                        if !push(
                            out,
                            DiffEntry {
                                path: child_path,
                                kind: ChangeKind::Removed,
                                old_value: Some(o.clone()),
                                new_value: None,
                            },
                        ) {
                            return;
                        }
                    }
                    (None, None) => {}
                }
            }
        }
        (o, n) => {
            if type_name(o) != type_name(n) {
                push(
                    out,
                    DiffEntry {
                        path: path.to_string(),
                        kind: ChangeKind::TypeChanged,
                        old_value: Some(o.clone()),
                        new_value: Some(n.clone()),
                    },
                );
            } else if o != n {
                push(
                    out,
                    DiffEntry {
                        path: path.to_string(),
                        kind: ChangeKind::ValueChanged,
                        old_value: Some(o.clone()),
                        new_value: Some(n.clone()),
                    },
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn find<'a>(entries: &'a [DiffEntry], path: &str) -> &'a DiffEntry {
        entries
            .iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("no diff entry for path {path}, got {entries:?}"))
    }

    #[test]
    fn detects_added_and_removed_fields() {
        let old = json!({ "map": { "game_state": "MENU" } });
        let new = json!({ "map": { "game_state": "MENU", "matchid": "123" }, "hero": { "id": 1 } });
        let entries = diff_values(&old, &new);
        assert_eq!(find(&entries, "$.map.matchid").kind, ChangeKind::Added);
        assert_eq!(find(&entries, "$.hero").kind, ChangeKind::Added);
    }

    #[test]
    fn detects_removed_fields() {
        let old = json!({ "map": { "game_state": "MENU", "matchid": "123" } });
        let new = json!({ "map": { "game_state": "MENU" } });
        let entries = diff_values(&old, &new);
        assert_eq!(find(&entries, "$.map.matchid").kind, ChangeKind::Removed);
    }

    #[test]
    fn detects_type_change_vs_value_change() {
        let old = json!({ "player": { "kills": 3, "team_name": "radiant" } });
        let new = json!({ "player": { "kills": "3", "team_name": "dire" } });
        let entries = diff_values(&old, &new);
        assert_eq!(find(&entries, "$.player.kills").kind, ChangeKind::TypeChanged);
        assert_eq!(find(&entries, "$.player.team_name").kind, ChangeKind::ValueChanged);
    }

    #[test]
    fn identical_values_produce_no_diff() {
        let v = json!({ "a": [1, 2, { "b": true }] });
        assert!(diff_values(&v, &v).is_empty());
    }

    #[test]
    fn recurses_into_arrays_by_index() {
        let old = json!({ "events": [{ "id": 1 }] });
        let new = json!({ "events": [{ "id": 1 }, { "id": 2 }] });
        let entries = diff_values(&old, &new);
        assert_eq!(find(&entries, "$.events[1]").kind, ChangeKind::Added);
    }

    #[test]
    fn does_not_exceed_max_entries() {
        let mut old_map = serde_json::Map::new();
        let mut new_map = serde_json::Map::new();
        for i in 0..(MAX_DIFF_ENTRIES + 500) {
            new_map.insert(format!("field{i}"), json!(i));
            let _ = &mut old_map;
        }
        let old = Value::Object(old_map);
        let new = Value::Object(new_map);
        let entries = diff_values(&old, &new);
        assert!(entries.len() <= MAX_DIFF_ENTRIES);
    }
}
