// WK-125 - the real, packaged-Windows-adjacent proof that the `keyring`
// dependency's Windows Credential Manager backend actually links and works
// end to end on the exact runner this app ships from (see the Windows CI
// job in windows-release.yml, which builds and runs this example before
// building the installer).
//
// This exists as a standalone `examples/` binary, not a `cargo test`, for a
// concrete reason found while wiring this gate up: the SAME real-store round
// trip, run as an `#[ignore]`d unit test inside the full `cargo test --lib`
// binary (see secure_storage.rs's `real_store_smoke` module), crashes on
// GitHub Actions' `windows-latest` runner with STATUS_ENTRYPOINT_NOT_FOUND
// before any test code even runs - while this example, linking the same
// `keyring` dependency but none of the test-only dependencies (`tempfile`,
// `tauri`'s `test`/MockRuntime feature), runs cleanly on that same runner.
// The unit test still passes locally (macOS) and is kept for that manual
// check; this example is what CI actually relies on. Uses a synthetic
// key/value only - never a real credential.
fn main() {
    let entry = keyring::Entry::new("wk-125-ci-smoke-test", "smoke-key").expect("Entry::new");
    entry.set_password("smoke-value").expect("set_password against the real OS credential store must succeed");
    let value = entry.get_password().expect("get_password must succeed");
    assert_eq!(value, "smoke-value", "read-back value must match what was written");
    entry.delete_credential().expect("delete_credential must succeed");
    assert!(entry.get_password().is_err(), "credential must be gone after delete");
    println!("keyring_smoke: OK - real OS credential store round-trip succeeded");
}
