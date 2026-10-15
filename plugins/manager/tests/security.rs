use companion_plugin_manager::*;
use std::{fs, sync::atomic::{AtomicBool, Ordering}, io::Cursor};
const TEST_KEY: &str = include_str!("fixtures/test.pub");

fn fixture(name: &str) -> Vec<u8> { fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap() }
fn release(version: &str) -> Release { serde_json::from_slice(&fixture(&format!("hello-{version}-macos-aarch64.release.json"))).unwrap() }
fn package(version: &str) -> Vec<u8> { fixture(&format!("hello-{version}-macos-aarch64.zip")) }
fn store(dir: &tempfile::TempDir) -> Store { Store::open(dir.path().join("plugins"), TEST_KEY).unwrap() }
fn install(store: &mut Store, version: &str, running: bool) { store.install(&package(version), &release(version), running, &AtomicBool::new(false)).unwrap(); }

#[test]
fn signed_install_update_deferred_activation_rollback_and_restart() {
    // Fixtures target the development host; other targets exercise the rejection test below.
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" { return; }
    let dir = tempfile::tempdir().unwrap(); let mut s = store(&dir);
    install(&mut s, "0.1.0", false);
    s.verify("hello", "0.1.0").unwrap();
    fs::create_dir_all(s.root().join("versions/hello/0.2.0")).unwrap();
    fs::write(s.root().join("versions/hello/0.2.0/interrupted"), "orphan before registry commit").unwrap();
    install(&mut s, "0.2.0", true);
    assert_eq!(s.installed()["hello"].active, "0.1.0");
    assert_eq!(s.installed()["hello"].pending.as_deref(), Some("0.2.0"));
    s.activate("hello").unwrap();
    assert_eq!(s.installed()["hello"].active, "0.2.0");
    s.rollback("hello").unwrap();
    s.enable("hello", false).unwrap(); drop(s);
    let mut s = store(&dir);
    assert_eq!(s.installed()["hello"].active, "0.1.0"); assert!(!s.installed()["hello"].enabled);
    fs::create_dir_all(s.root().join("data/hello")).unwrap();
    fs::write(s.root().join("data/hello/settings.json"), "keep").unwrap();
    s.remove("hello").unwrap();
    assert!(s.installed().is_empty()); assert!(s.root().join("data/hello/settings.json").exists());
    assert!(store(&dir).installed().is_empty());
}
#[test]
fn rejects_corruption_signatures_unsafe_archives_incompatibility_and_cancel() {
    let dir = tempfile::tempdir().unwrap(); let mut s = store(&dir);
    let good = release("0.1.0"); let bytes = package("0.1.0");
    let mut damaged = bytes.clone(); damaged[0] ^= 1;
    assert!(s.install(&damaged, &good, false, &AtomicBool::new(false)).is_err());
    let mut unsigned = good.clone(); unsigned.signature = "forged".into();
    assert!(s.install(&bytes, &unsigned, false, &AtomicBool::new(false)).is_err());
    let mut incompatible = good.clone(); incompatible.manifest.min_api = companion_plugin_protocol::CORE_API+1; incompatible.manifest.max_api = companion_plugin_protocol::CORE_API+1;
    assert_eq!(s.install(&bytes, &incompatible, false, &AtomicBool::new(false)).unwrap_err(), "incompatible_api");
    for name in ["traversal", "symlink", "duplicate", "damaged", "oversized"] {
        let meta: Release = serde_json::from_slice(&fixture(&format!("{name}.json"))).unwrap();
        assert!(s.install(&fixture(&format!("{name}.zip")), &meta, false, &AtomicBool::new(false)).is_err());
    }
    assert!(s.install(&bytes, &good, false, &AtomicBool::new(true)).is_err());
    assert!(s.installed().is_empty());
    assert_eq!(fs::read_dir(s.root().join("staging")).unwrap().count(), 0);
    assert!(!dir.path().join("escape").exists());
}
#[test]
fn download_cancellation_and_limits() {
    let cancel = AtomicBool::new(false); let mut out = Vec::new();
    let result = download(Cursor::new(vec![7; 100000]), &mut out, &cancel, MAX_PACKAGE, |_| { cancel.store(true, Ordering::SeqCst); });
    assert_eq!(result.unwrap_err(), "cancelled"); assert_eq!(out.len(), 16384);
    assert!(download(Cursor::new(vec![1; 100]), Vec::new(), &AtomicBool::new(false), 99, |_| {}).is_err());
    assert_eq!(download(Cursor::new(b"ok"), Vec::new(), &AtomicBool::new(false), 2, |_| {}).unwrap(), 2);
}
#[test]
fn signed_catalog_and_portable_path_validation() {
    let bytes = fixture("catalog.json"); let sig = String::from_utf8(fixture("catalog.minisig")).unwrap();
    assert_eq!(catalog(&bytes, &sig, TEST_KEY).unwrap().releases.len(), 1);
    assert!(catalog(&bytes, &sig, TRUSTED_KEY).is_err());
    let mut tampered = bytes; tampered[10] ^= 1; assert!(catalog(&tampered, &sig, TEST_KEY).is_err());
    for name in ["../x", "/x", "a//b", "x\\b", "a:stream", "CON.txt", "com1", "a.", "a%20b", "a/../b"] { assert!(safe_path(name).is_err(), "{name}"); }
}
#[test]
fn api2_live_permissions_and_ui_commands_are_explicit_and_old_metadata_roundtrips_unchanged(){
    let old=release("0.1.0").manifest;
    let before=serde_json::to_value(&old).unwrap();assert!(before.get("author").is_none());assert!(before.get("uiCommands").is_none());
    assert_eq!(serde_json::to_value(serde_json::from_value::<Manifest>(before.clone()).unwrap()).unwrap(),before);
    let mut current=old.clone();current.id="independent-game".into();current.min_api=2;current.max_api=2;current.execution=ExecutionMode::Live;
    current.permissions=vec!["ui".into(),"data.legacy".into(),"audio.play".into(),"obs.scene".into()];current.author=Some("Example publisher".into());current.ui_commands=vec!["status".into(),"sound.settings".into()];
    current.validate().unwrap();
    let mut bad=current.clone();bad.ui_commands.push("host.activate".into());assert_eq!(bad.validate().unwrap_err(),"invalid_ui_commands");
    let mut bad=current.clone();bad.permissions.push("data.private".into());assert_eq!(bad.validate().unwrap_err(),"unsupported_permissions");
    let mut bad=current.clone();bad.permissions.push("sql".into());assert_eq!(bad.validate().unwrap_err(),"unsupported_permissions");
    let mut bad=current.clone();bad.permissions.push("audio.play".into());assert_eq!(bad.validate().unwrap_err(),"unsupported_permissions");
    let mut bad=current.clone();bad.min_api=1;assert_eq!(bad.validate().unwrap_err(),"unsupported_permissions");
    let mut bad=old;bad.execution=ExecutionMode::ReplayOnly;bad.permissions.push("audio.play".into());assert_eq!(bad.validate().unwrap_err(),"unsupported_permissions");
}
#[test]
fn tampered_payload_blocks_launch_and_failed_update_keeps_active() {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" { return; }
    let dir = tempfile::tempdir().unwrap(); let mut s = store(&dir); install(&mut s, "0.1.0", false);
    let mut invalid = release("0.2.0"); invalid.signature = "invalid".into();
    assert!(s.install(&package("0.2.0"), &invalid, false, &AtomicBool::new(false)).is_err());
    assert_eq!(s.installed()["hello"].active, "0.1.0"); s.executable("hello", "0.1.0").unwrap();
    fs::write(s.root().join("versions/hello/0.1.0/bin/injected.dll"), "injected").unwrap();
    assert_eq!(s.executable("hello", "0.1.0").unwrap_err(), "unexpected_installed_files");
    fs::remove_file(s.root().join("versions/hello/0.1.0/bin/injected.dll")).unwrap();
    fs::write(s.root().join("versions/hello/0.1.0/bin/hello"), "tampered").unwrap();
    assert!(s.executable("hello", "0.1.0").is_err());
}
#[test]
fn interrupted_registry_commit_and_staging_recovery() {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" { return; }
    let dir = tempfile::tempdir().unwrap(); let mut s = store(&dir); install(&mut s, "0.1.0", false);
    fs::rename(s.root().join("registry.json"), s.root().join("registry.next")).unwrap();
    fs::create_dir(s.root().join("staging/interrupted")).unwrap();
    drop(s); let s = store(&dir);
    assert_eq!(s.installed()["hello"].active, "0.1.0");
    assert_eq!(fs::read_dir(s.root().join("staging")).unwrap().count(), 0);
}
#[test]
fn damaged_pending_update_falls_back_on_restart_and_keeps_error() {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" { return; }
    let dir = tempfile::tempdir().unwrap(); let mut s = store(&dir);
    install(&mut s, "0.1.0", false); install(&mut s, "0.2.0", true);
    fs::write(s.root().join("versions/hello/0.2.0/bin/hello"), "tampered").unwrap();
    drop(s); let s = store(&dir);
    assert_eq!(s.installed()["hello"].active, "0.1.0");
    assert!(s.installed()["hello"].pending.is_none());
    assert!(s.installed()["hello"].last_error.as_ref().unwrap().starts_with("update_rejected"));
    s.executable("hello", "0.1.0").unwrap();
}
#[test]
fn signed_dota_package_is_installable_but_defaults_to_disabled() {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" { return; }
    let dir = tempfile::tempdir().unwrap(); let mut s = store(&dir);
    let release: Release = serde_json::from_slice(&fixture("dota2-0.1.0-macos-aarch64.release.json")).unwrap();
    s.install(&fixture("dota2-0.1.0-macos-aarch64.zip"), &release, false, &AtomicBool::new(false)).unwrap();
    assert!(!s.installed()["dota2"].enabled);
    assert!(s.executable("dota2", "0.1.0").is_ok());
    drop(s); assert!(!store(&dir).installed()["dota2"].enabled);
}
#[test]
#[ignore = "requires locally prepared official signed Dota replay package"]
fn official_dota_package_integrity_and_overlay_assets() {
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages");
    let release: Release = serde_json::from_slice(&fs::read(base.join("dota2-0.1.0-macos-aarch64.release.json")).unwrap()).unwrap();
    let bytes = fs::read(base.join("dota2-0.1.0-macos-aarch64.zip")).unwrap();
    let dir=tempfile::tempdir().unwrap(); let mut s=Store::open(dir.path().join("plugins"),TRUSTED_KEY).unwrap();
    s.install(&bytes,&release,false,&AtomicBool::new(false)).unwrap();
    assert!(!s.installed()["dota2"].enabled);
    s.executable("dota2","0.1.0").unwrap();
    s.ui_asset("dota2","0.1.0","overlay/index.html").unwrap();
}
