//! Bounded JSON documents in the plugin's private data directory. Fixed file
//! names only; never a path from the UI or the backend.
use serde::{de::DeserializeOwned, Serialize};
use std::{io::{Read, Write}, path::Path};

pub fn read<T: DeserializeOwned>(root: &Path, name: &str, limit: u64) -> Result<Option<T>, String> {
    let path = root.join(name);
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("plugin_data_unavailable".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("plugin_data_invalid".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|_| "plugin_data_unavailable")?
        .take(limit + 1).read_to_end(&mut bytes).map_err(|_| "plugin_data_unavailable")?;
    if bytes.len() as u64 > limit { return Err("plugin_data_invalid".into()); }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "plugin_data_invalid".into())
}

/// Write-to-temp, sync, rename: a crash leaves the old or the new document.
pub fn write<T: Serialize>(root: &Path, name: &str, value: &T, limit: usize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "plugin_data_encoding")?;
    if bytes.len() > limit { return Err("plugin_data_limit".into()); }
    let path = root.join(name);
    if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) { return Err("plugin_data_invalid".into()); }
    let tmp = root.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map_err(|_| "plugin_data_write_failed".into())
}
