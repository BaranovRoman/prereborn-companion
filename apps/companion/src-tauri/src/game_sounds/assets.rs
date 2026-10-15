// Compatibility adapter during extraction; existing managed assets stay in place.
pub use companion_dota_plugin::sounds::assets::*;
use tauri::{AppHandle,Manager};
use std::path::{Path,PathBuf};
use super::config::ManagedSoundAsset;
pub fn sounds_dir(app:&AppHandle)->PathBuf {app.path().app_data_dir().expect("app_data_dir must resolve").join("sounds")}
pub fn import_file(app:&AppHandle,source:&Path,name:&str)->Result<ManagedSoundAsset,String> {import_file_into(&sounds_dir(app),source,name)}
pub fn read_file(app:&AppHandle,asset:&ManagedSoundAsset)->Result<Vec<u8>,String> {read_file_from(&sounds_dir(app),asset)}
pub fn delete_file(app:&AppHandle,asset:&ManagedSoundAsset) {delete_file_from(&sounds_dir(app),asset)}
pub(crate) fn read_plugin_file(app:&AppHandle,asset:&ManagedSoundAsset)->Result<Vec<u8>,String> {read_plugin_file_from(&sounds_dir(app),asset)}
