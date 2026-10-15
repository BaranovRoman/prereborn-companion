// Compile the exact production projection independently of the Windows Tauri lib-test
// loader limitation. No duplicate parser or alternate production path.
pub use companion_dota_domain::{contracts,events,gsi,match_shadow,replay};
#[path = "../../../../plugins/dota-domain/src/projection.rs"]
mod projection;
