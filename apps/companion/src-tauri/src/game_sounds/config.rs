// Compatibility adapter during extraction; persisted format and path are unchanged.
pub use companion_dota_plugin::sounds::config::*;
use tauri::{AppHandle,Manager};
fn path(app:&AppHandle)->std::path::PathBuf {app.path().app_data_dir().expect("app_data_dir must resolve").join("game-sounds-config.json")}
pub fn load(app:&AppHandle)->GameSoundSettings {load_from(&path(app))}
pub fn save(app:&AppHandle,settings:&GameSoundSettings)->std::io::Result<()> {save_to(&path(app),settings)}
