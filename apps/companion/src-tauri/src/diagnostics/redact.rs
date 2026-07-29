use serde_json::Value;

// Same substring/case-insensitive approach as the backend's
// SECRET_KEY_PATTERN (packages/backend/src/services/stream-companion-service.ts)
// - defense in depth matters more here than showing a field that happened to
// be useful but potentially secret. Dota's own GSI payload has no "auth"
// section in our config (see gsi/config.rs - no "auth" key requested), so in
// practice this should never trigger, but diagnostics captures the payload
// completely unfiltered otherwise, so it must not depend on that.
const SECRET_KEY_FRAGMENTS: &[&str] = &["token", "auth", "password", "secret", "authorization"];

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_KEY_FRAGMENTS.iter().any(|frag| lower.contains(frag))
}

/// Recursively strips any object key matching a secret fragment, replacing
/// its value with a redaction marker rather than dropping the key entirely -
/// so the field catalog / diff can still see "this path exists" without ever
/// persisting the value.
pub fn redact(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, val) in map {
                if is_secret_key(key) {
                    out.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    out.insert(key.clone(), redact(val));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_known_secret_keys_at_any_depth() {
        let input = json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
            "credentials": { "token": "sekret", "companion_token": "abc123" },
            "player": {
                "kills": 3,
                "nested": { "refresh_token": "xyz", "Password": "hunter2" }
            }
        });
        let out = redact(&input);
        // "credentials" itself isn't a secret-matching key, so it survives
        // and its children get redacted individually.
        assert_eq!(out["credentials"]["token"], json!("[REDACTED]"));
        assert_eq!(out["credentials"]["companion_token"], json!("[REDACTED]"));
        assert_eq!(out["player"]["nested"]["refresh_token"], json!("[REDACTED]"));
        assert_eq!(out["player"]["nested"]["Password"], json!("[REDACTED]"));
        // non-secret data untouched
        assert_eq!(out["map"]["game_state"], json!("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"));
        assert_eq!(out["player"]["kills"], json!(3));
    }

    #[test]
    fn a_key_that_is_itself_secret_collapses_its_whole_subtree() {
        // Defense-in-depth: if the CONTAINER key itself matches (e.g. Dota
        // ever added an "auth" section to GSI), everything under it is
        // dropped too, not just leaf keys named "token".
        let input = json!({ "auth": { "token": "sekret", "unrelated_field": "kept-if-key-werent-secret" } });
        let out = redact(&input);
        assert_eq!(out["auth"], json!("[REDACTED]"));
    }

    #[test]
    fn redacts_inside_arrays() {
        let input = json!({ "events": [{ "id": 1, "auth_code": "abc" }] });
        let out = redact(&input);
        assert_eq!(out["events"][0]["auth_code"], json!("[REDACTED]"));
        assert_eq!(out["events"][0]["id"], json!(1));
    }

    #[test]
    fn leaves_payload_with_no_secrets_unchanged() {
        let input = json!({ "hero": { "id": 1, "name": "npc_dota_hero_axe" } });
        assert_eq!(redact(&input), input);
    }
}
