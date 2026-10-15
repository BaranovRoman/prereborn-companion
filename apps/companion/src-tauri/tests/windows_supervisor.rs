#![cfg(windows)]
// Compile the exact production OS module in a small native test target.
// The combined Tauri mock/lib-test executable cannot load on the Windows runner
// (STATUS_ENTRYPOINT_NOT_FOUND; also documented by examples/keyring_smoke.rs).
// No mock OS, duplicated supervisor, protocol or runtime.
#[path = "../../../../plugins/protocol/src/windows.rs"]
mod windows;
