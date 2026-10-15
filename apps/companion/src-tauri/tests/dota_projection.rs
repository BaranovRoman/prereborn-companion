// Compile the exact production projection independently of the Windows Tauri lib-test
// loader limitation. No duplicate parser or alternate production path.
#[path = "../src/core/dota_observer/projection.rs"]
mod projection;
