use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager};

use super::config::ManagedSoundAsset;

const ALLOWED_EXTENSIONS: [&str; 3] = ["wav", "mp3", "ogg"];
// 5 MB - generous for a short sound cue (even an uncompressed 16-bit/44.1kHz
// stereo WAV fits ~30s in that budget; mp3/ogg comfortably more), small
// enough that import/preview/event playback never has to worry about
// meaningfully large IO. See the report for why wav/mp3/ogg specifically
// (Tauri's webview - WebView2 on Windows, WKWebView on macOS - plays all
// three natively via a plain HTMLAudioElement, the same element the
// existing Silero TTS pipeline already uses, see useTwitchChatSession.ts).
pub const MAX_FILE_SIZE_BYTES: u64 = 5 * 1024 * 1024;

pub fn sounds_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("sounds")
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase())
}

pub fn validate_extension(path: &Path) -> Result<String, String> {
    let ext = extension_of(path).ok_or_else(|| "Файл без расширения не поддерживается.".to_string())?;
    if ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(format!("Формат .{ext} не поддерживается. Разрешены: wav, mp3, ogg."))
    }
}

pub fn mime_for_extension(ext: &str) -> &'static str {
    match ext {
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        _ => "audio/wav",
    }
}

static ASSET_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Same "no new dependency" idiom as `server/mod.rs`'s OBS request ids
/// (nanosecond timestamp) - a same-nanosecond `fetch_add` counter closes the
/// only realistic collision window a bare timestamp would have.
pub fn generate_asset_id() -> String {
    let nanos = chrono::Local::now().timestamp_nanos_opt().unwrap_or_default();
    let counter = ASSET_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{nanos:x}-{counter:x}")
}

/// Copies a user-picked file into `dir` (the managed sounds directory) under
/// a fresh, collision-safe name - pure/path-based so it's unit-testable with
/// a plain tempdir, same split as `storage.rs`'s
/// `collect_legacy_cleanup_targets`/`cleanup_legacy_payloads`. The persisted
/// config only ever references the returned managed copy (see
/// `config::ManagedSoundAsset`), never `source` itself - a later move/
/// rename/delete of the original file on the user's disk can't orphan a
/// binding once this returns.
pub fn import_file_into(dir: &Path, source: &Path, original_name: &str) -> Result<ManagedSoundAsset, String> {
    let ext = validate_extension(source)?;
    let metadata = fs::metadata(source).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
    if metadata.len() > MAX_FILE_SIZE_BYTES {
        return Err(format!(
            "Файл слишком большой ({:.1} МБ). Максимум {} МБ.",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_FILE_SIZE_BYTES / (1024 * 1024)
        ));
    }
    fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать папку звуков: {e}"))?;
    let id = generate_asset_id();
    let file_name = format!("{id}.{ext}");
    fs::copy(source, dir.join(&file_name)).map_err(|e| format!("Не удалось скопировать файл: {e}"))?;
    Ok(ManagedSoundAsset {
        id,
        file_name,
        original_name: original_name.to_string(),
        size_bytes: metadata.len(),
    })
}

pub fn import_file(app: &AppHandle, source: &Path, original_name: &str) -> Result<ManagedSoundAsset, String> {
    import_file_into(&sounds_dir(app), source, original_name)
}

/// Missing/corrupted managed file is a plain `Err`, never a panic - callers
/// (preview, event playback) surface it as "звук недоступен" and move on,
/// per the task's "graceful handling отсутствующего/corrupted audio".
pub fn read_file_from(dir: &Path, asset: &ManagedSoundAsset) -> Result<Vec<u8>, String> {
    fs::read(dir.join(&asset.file_name)).map_err(|e| format!("Звуковой файл отсутствует или повреждён: {e}"))
}

pub fn read_file(app: &AppHandle, asset: &ManagedSoundAsset) -> Result<Vec<u8>, String> {
    read_file_from(&sounds_dir(app), asset)
}

/// Best-effort - a file that's already gone is not an error here (the
/// caller, game_sounds::mod's orphan cleanup after a binding is removed/
/// replaced, has nothing useful to do with that failure either way).
pub fn delete_file_from(dir: &Path, asset: &ManagedSoundAsset) {
    let _ = fs::remove_file(dir.join(&asset.file_name));
}

pub fn delete_file(app: &AppHandle, asset: &ManagedSoundAsset) {
    delete_file_from(&sounds_dir(app), asset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn import_copies_the_file_under_a_unique_managed_name() {
        let source_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();
        let source = write_temp_file(source_dir.path(), "meat-hook.wav", b"RIFF....WAVEfmt ");

        let asset = import_file_into(managed_dir.path(), &source, "meat-hook.wav").unwrap();

        assert_eq!(asset.original_name, "meat-hook.wav");
        assert_eq!(asset.size_bytes, 16);
        assert!(asset.file_name.ends_with(".wav"));
        assert!(managed_dir.path().join(&asset.file_name).exists());
        // The managed copy is a distinct file - the original is untouched.
        assert!(source.exists());
    }

    #[test]
    fn two_imports_of_the_same_original_name_get_different_managed_filenames() {
        let source_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();
        let source = write_temp_file(source_dir.path(), "hook.mp3", b"ID3 fake mp3 bytes");

        let a = import_file_into(managed_dir.path(), &source, "hook.mp3").unwrap();
        let b = import_file_into(managed_dir.path(), &source, "hook.mp3").unwrap();

        assert_ne!(a.id, b.id);
        assert_ne!(a.file_name, b.file_name);
        assert!(managed_dir.path().join(&a.file_name).exists());
        assert!(managed_dir.path().join(&b.file_name).exists());
    }

    #[test]
    fn unsupported_extension_is_rejected_before_any_copy_happens() {
        let source_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();
        let source = write_temp_file(source_dir.path(), "clip.exe", b"not audio");

        let error = import_file_into(managed_dir.path(), &source, "clip.exe").unwrap_err();
        assert!(error.contains("не поддерживается"));
        assert!(fs::read_dir(managed_dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn oversized_file_is_rejected() {
        let source_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();
        let big = vec![0u8; (MAX_FILE_SIZE_BYTES + 1) as usize];
        let source = write_temp_file(source_dir.path(), "huge.wav", &big);

        let error = import_file_into(managed_dir.path(), &source, "huge.wav").unwrap_err();
        assert!(error.contains("большой"));
        assert!(fs::read_dir(managed_dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn reading_a_missing_managed_file_is_a_graceful_error_not_a_panic() {
        let managed_dir = tempfile::tempdir().unwrap();
        let asset = ManagedSoundAsset {
            id: "abc".into(),
            file_name: "abc.wav".into(),
            original_name: "gone.wav".into(),
            size_bytes: 10,
        };
        let result = read_file_from(managed_dir.path(), &asset);
        assert!(result.is_err());
    }

    #[test]
    fn replacing_a_binding_can_clean_up_the_now_orphaned_file() {
        let source_dir = tempfile::tempdir().unwrap();
        let managed_dir = tempfile::tempdir().unwrap();
        let source = write_temp_file(source_dir.path(), "old.wav", b"12345");
        let asset = import_file_into(managed_dir.path(), &source, "old.wav").unwrap();
        assert!(managed_dir.path().join(&asset.file_name).exists());

        delete_file_from(managed_dir.path(), &asset);

        assert!(!managed_dir.path().join(&asset.file_name).exists());
    }

    #[test]
    fn deleting_an_already_missing_file_does_not_error() {
        let managed_dir = tempfile::tempdir().unwrap();
        let asset = ManagedSoundAsset {
            id: "abc".into(),
            file_name: "does-not-exist.wav".into(),
            original_name: "x.wav".into(),
            size_bytes: 0,
        };
        // Must not panic.
        delete_file_from(managed_dir.path(), &asset);
    }

    #[test]
    fn mime_type_matches_extension() {
        assert_eq!(mime_for_extension("mp3"), "audio/mpeg");
        assert_eq!(mime_for_extension("ogg"), "audio/ogg");
        assert_eq!(mime_for_extension("wav"), "audio/wav");
    }
}
