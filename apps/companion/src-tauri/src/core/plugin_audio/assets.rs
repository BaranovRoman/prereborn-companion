//! Imports only a file selected by the native picker; iframe arguments never
//! supply a source path. Returned metadata contains no absolute/local path.
use std::{io::{Read, Write}, path::Path};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedAsset {
    id: String,
    file_name: String,
    original_name: String,
    size_bytes: u64,
}

pub(crate) fn import_selected(root: &Path, source: &Path) -> Result<ImportedAsset, String> {
    let extension = source.extension().and_then(|s| s.to_str()).ok_or("audio_format_unsupported")?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "wav" | "mp3" | "ogg") { return Err("audio_format_unsupported".into()); }
    let original_name = source.file_name().and_then(|s| s.to_str()).ok_or("audio_name_invalid")?.to_string();
    if original_name.len() > 512 { return Err("audio_name_too_long".into()); }
    let input = std::fs::File::open(source).map_err(|_| "audio_source_unavailable")?;
    if !input.metadata().map_err(|_| "audio_source_unavailable")?.is_file() { return Err("audio_source_invalid".into()); }
    let mut bytes = Vec::new();
    input.take(5 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "audio_source_unavailable")?;
    if bytes.is_empty() || bytes.len() > 5 * 1024 * 1024 { return Err("audio_size_invalid".into()); }
    let root = root.canonicalize().map_err(|_| "plugin_data_unavailable")?;
    let directory = root.join("sounds");
    std::fs::create_dir_all(&directory).map_err(|_| "audio_directory_unavailable")?;
    if directory.symlink_metadata().map_err(|_| "audio_directory_unavailable")?.file_type().is_symlink()
        || directory.canonicalize().map_err(|_| "audio_directory_unavailable")?.parent() != Some(root.as_path()) {
        return Err("audio_directory_invalid".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.{extension}");
    let path = directory.join(&file_name);
    let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|_| "audio_import_failed")?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(path); // Only the new file created here.
        return Err("audio_import_failed".into());
    }
    Ok(ImportedAsset { id, file_name, original_name, size_bytes: bytes.len() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_import_keeps_source_and_existing_files_and_never_returns_paths() {
        let source = tempfile::tempdir().unwrap(); let root = tempfile::tempdir().unwrap();
        let path = source.path().join("jump.WAV"); std::fs::write(&path, b"RIFFtestWAVE").unwrap();
        let first = import_selected(root.path(), &path).unwrap(); let second = import_selected(root.path(), &path).unwrap();
        assert_ne!(first.id, second.id); assert!(path.exists());
        assert_eq!(std::fs::read(root.path().join("sounds").join(&first.file_name)).unwrap(), b"RIFFtestWAVE");
        let encoded = serde_json::to_string(&first).unwrap(); assert!(!encoded.contains(source.path().to_str().unwrap()));
        std::fs::write(source.path().join("bad.exe"), b"x").unwrap();
        assert!(import_selected(root.path(), &source.path().join("bad.exe")).is_err());
        let big = source.path().join("big.wav"); std::fs::File::create(&big).unwrap().set_len(5*1024*1024+1).unwrap();
        assert!(import_selected(root.path(), &big).is_err());
        assert_eq!(std::fs::read_dir(root.path().join("sounds")).unwrap().count(), 2);
    }
    #[cfg(unix)]
    #[test]
    fn managed_directory_cannot_redirect_import_outside_granted_root() {
        let root = tempfile::tempdir().unwrap(); let other = tempfile::tempdir().unwrap();
        let source = other.path().join("source.wav"); std::fs::write(&source, b"RIFF").unwrap();
        std::os::unix::fs::symlink(other.path(), root.path().join("sounds")).unwrap();
        assert!(import_selected(root.path(), &source).is_err());
        assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 1);
    }
}
