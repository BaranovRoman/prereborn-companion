//! The packaged manifest template must pass the host's own validation, and its
//! version must match the executable (the worker refuses a mismatch).
use serde_json::{json, Value};

#[test]
fn live_manifest_template_is_accepted_by_the_manager_and_matches_the_crate() {
    let text = include_str!("../manifest.windows-live.json");
    let mut template: Value = serde_json::from_str(text).unwrap();
    assert_eq!(template["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(template["id"], "pubg");
    let hash = "a".repeat(64);
    template["files"] = json!({"bin/companion-pubg-plugin.exe": hash, "ui/index.html": hash, "ui/icon.png": hash, "ui/widget/index.html": hash});
    let manifest: companion_plugin_manager::Manifest = serde_json::from_value(template).unwrap();
    manifest.validate().unwrap();
    let resource = &manifest.backend_resources["matches"];
    resource.validate().unwrap();
    let request = companion_plugin_protocol::backend::Request {
        resource: "matches".into(), operation_key: "matches:1".into(),
        query: [("platform".into(), "steam".into()), ("player".into(), "ProPlayer".into()), ("limit".into(), "10".into())].into(), body: None,
    };
    resource.authorize(&request).unwrap();
    let mut extra = request.clone();
    extra.query.insert("apiKey".into(), "x".into());
    assert!(resource.authorize(&extra).is_err());
}
