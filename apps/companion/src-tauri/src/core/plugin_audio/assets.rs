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

pub(crate) fn import_selected(root: &Path, source: &Path) -> Result<ImportedAsset, String> { import_kind(root,source,false) }
pub(crate) fn import_selected_image(root:&Path,source:&Path)->Result<ImportedAsset,String>{ import_kind(root,source,true) }
fn import_kind(root:&Path,source:&Path,image:bool)->Result<ImportedAsset,String>{
    let class=if image{"image"}else{"audio"};let code=|kind:&str|format!("{class}_{kind}");
    let limit:usize=if image{10*1024*1024}else{5*1024*1024};
    let extension = source.extension().and_then(|s| s.to_str()).ok_or(code("format_unsupported"))?.to_ascii_lowercase();
    if if image{!matches!(extension.as_str(),"png"|"jpg"|"jpeg"|"webp")}else{!matches!(extension.as_str(), "wav" | "mp3" | "ogg")} { return Err(code("format_unsupported")); }
    let original_name = source.file_name().and_then(|s| s.to_str()).ok_or(code("name_invalid"))?.to_string();
    if original_name.len() > 512 { return Err(code("name_too_long")); }
    let input = std::fs::File::open(source).map_err(|_| code("source_unavailable"))?;
    if !input.metadata().map_err(|_| code("source_unavailable"))?.is_file() { return Err(code("source_invalid")); }
    let mut bytes = Vec::new();
    input.take((limit + 1) as u64).read_to_end(&mut bytes).map_err(|_| code("source_unavailable"))?;
    if bytes.is_empty() || bytes.len() > limit { return Err(code("size_invalid")); }
    if image&&companion_plugin_protocol::media::image_mime(&bytes).is_none(){return Err(code("format_unsupported"));}
    let root = root.canonicalize().map_err(|_| "plugin_data_unavailable")?;
    let directory = root.join(if image{"images"}else{"sounds"});
    std::fs::create_dir_all(&directory).map_err(|_| code("directory_unavailable"))?;
    if directory.symlink_metadata().map_err(|_| code("directory_unavailable"))?.file_type().is_symlink()
        || directory.canonicalize().map_err(|_| code("directory_unavailable"))?.parent() != Some(root.as_path()) {
        return Err(code("directory_invalid"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.{extension}");
    let path = directory.join(&file_name);
    let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|_| code("import_failed"))?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(path); // Only the new file created here.
        return Err(code("import_failed"));
    }
    Ok(ImportedAsset { id, file_name, original_name, size_bytes: bytes.len() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn native_image_import_preserves_source_and_rejects_executable_or_oversized_content(){
        let source=tempfile::tempdir().unwrap();let root=tempfile::tempdir().unwrap();let path=source.path().join("reference.png");
        std::fs::write(&path,b"\x89PNG\r\n\x1a\noriginal").unwrap();let asset=import_selected_image(root.path(),&path).unwrap();
        assert_eq!(std::fs::read(root.path().join("images").join(&asset.file_name)).unwrap(),std::fs::read(&path).unwrap());
        assert!(!serde_json::to_string(&asset).unwrap().contains(source.path().to_str().unwrap()));
        std::fs::write(&path,b"<svg onload=bad>").unwrap();assert!(import_selected_image(root.path(),&path).is_err());
        std::fs::File::create(&path).unwrap().set_len(10*1024*1024+1).unwrap();assert!(import_selected_image(root.path(),&path).is_err());
        assert_eq!(std::fs::read_dir(root.path().join("images")).unwrap().count(),1);
    }
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
