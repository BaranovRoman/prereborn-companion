#![cfg(windows)]
// Compile the actual host transport without the combined Tauri lib-test loader
// limitation (STATUS_ENTRYPOINT_NOT_FOUND). No copied ledger or playback model.
#[path = "../src/core/plugin_audio/store.rs"]
mod store;
#[path = "../src/core/plugin_audio/host.rs"]
mod host;
