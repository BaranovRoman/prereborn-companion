// WK-125 diagnostic - temporary, isolated repro to determine whether
// STATUS_ENTRYPOINT_NOT_FOUND on the windows-latest CI runner comes from the
// `keyring` crate's Windows backend itself, or from a link-time conflict
// specific to the much larger combined `cargo test` binary (which also
// links `tauri`'s "test" feature, `tempfile`, etc.). This binary depends on
// nothing from this crate's own dependency graph beyond `keyring` itself.
fn main() {
    let entry = keyring::Entry::new("wk-125-diagnostic", "smoke-key").expect("Entry::new");
    entry.set_password("smoke-value").expect("set_password");
    let value = entry.get_password().expect("get_password");
    assert_eq!(value, "smoke-value");
    entry.delete_credential().expect("delete_credential");
    println!("keyring_smoke: OK");
}
