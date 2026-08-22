// Shared sidecar-process IPC primitives for local TTS engines. Originally
// extracted because both Piper (tts.rs) and Silero (silero.rs, WK-81) solved
// the exact same correctness problem: WK-79 found that guessing a
// subprocess's completion from filesystem state (newest file, size-
// stability polling) silently returns the wrong or truncated audio - both
// engines instead read an explicit, per-request completion signal from the
// child's stdout, and this module is that plumbing. Piper itself was
// removed in WK-80 (Silero -> system speechSynthesis is now the whole
// fallback chain); kept as its own module since silero.rs still depends on
// it and there's exactly one engine left to share it with.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::{AppHandle, Manager};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Was tts.rs's (Piper's) helper, moved here when Piper was removed (WK-80)
// since silero.rs still needs a shared "tts" root under app_data_dir() to
// nest its own `voices`/`engine`/`scratch` subdirectories under.
pub fn tts_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("tts")
}

// An *explicit* --espeak_data path (as opposed to cwd/relative resolution)
// turned out not to be enough on its own for Piper: espeak-ng's own
// file-reading code chokes on any non-ASCII byte in the path itself
// ("Illegal byte sequence" opening phontab), which app_data_dir() hits
// directly for any Windows account with a Cyrillic username - this app's
// own primary audience. The Silero sidecar's own build/packaging step hit
// a related but distinct Windows path problem (MAX_PATH during `pip
// install`, see docs/research/wk-81-silero-tts-feasibility.md) - both
// engines benefit from resolving to the short-path form before handing a
// path to a child process, so this stays shared rather than
// Piper-specific. Falls back to the original (long) path if short names
// are unavailable (disabled via `fsutil 8dot3name`, or the path doesn't
// exist yet).
#[cfg(windows)]
pub fn to_short_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    #[link(name = "kernel32")]
    extern "system" {
        fn GetShortPathNameW(long_path: *const u16, short_path: *mut u16, buffer_len: u32) -> u32;
    }

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buffer = vec![0u16; 1024];
    let len = unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if len == 0 || len as usize >= buffer.len() {
        return path.to_path_buf();
    }
    buffer.truncate(len as usize);
    PathBuf::from(OsString::from_wide(&buffer))
}
#[cfg(not(windows))]
pub fn to_short_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// Best-effort delete of every file currently in `dir` - sweeps up anything
/// left behind by a previous process lifetime that was killed/crashed
/// mid-write. Purely hygiene: correctness never depends on this, since
/// each engine's synthesize() reads back exactly the path/id the child
/// process itself reports for that call, never anything inferred from
/// directory contents.
pub fn sweep_stale_files(dir: &Path) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let _ = fs::remove_file(entry.path());
    }
}

/// Reads `path` once it's actually there, retrying briefly rather than
/// assuming the read immediately following the child's completion signal
/// can never race the filesystem. This retry loop exists solely for a
/// theoretical cross-process filesystem-visibility lag, not for synthesis
/// progress - the completion signal itself (Piper's stdout path line,
/// Silero's `{"id","wav"}` JSON line) is what actually proves the file is
/// finished, not this.
pub fn read_completed_file(path: &Path, deadline: Instant) -> Result<Vec<u8>, String> {
    loop {
        if let Ok(bytes) = fs::read(path) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("Sidecar output file never became readable: {}", path.display()));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Reads `stdout` line-by-line on a background thread, forwarding each
/// line to the returned channel - lets a synthesize() call wait for the
/// next line with a timeout (`recv_timeout`), which plain blocking reads
/// on `ChildStdout` don't support. The thread exits on its own once
/// `stdout` EOFs (the child process exited), dropping the sender so
/// `recv_timeout` on the other end reports `Disconnected` instead of
/// hanging.
pub fn spawn_stdout_reader(stdout: std::process::ChildStdout) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in std::io::BufRead::lines(reader) {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn to_short_path_falls_back_when_path_does_not_exist() {
        let missing = std::path::PathBuf::from("Z:\\this\\path\\does\\not\\exist\\at\\all");
        assert_eq!(to_short_path(&missing), missing);
    }

    #[test]
    fn read_completed_file_ignores_other_files_in_the_same_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("000000000000001.wav"), b"old leftover").unwrap();
        fs::write(dir.path().join("000000000000099.wav"), b"decoy, not ours").unwrap();
        let ours = dir.path().join("000000000000002.wav");
        fs::write(&ours, b"this call's real output").unwrap();

        let deadline = Instant::now() + Duration::from_secs(1);
        let bytes = read_completed_file(&ours, deadline).unwrap();
        assert_eq!(bytes, b"this call's real output");
    }

    #[test]
    fn read_completed_file_waits_for_the_file_to_actually_exist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("delayed.wav");
        let path_for_writer = path.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            fs::write(&path_for_writer, b"arrived late").unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let bytes = read_completed_file(&path, deadline).expect("must wait rather than fail on first miss");
        writer.join().unwrap();
        assert_eq!(bytes, b"arrived late");
    }

    #[test]
    fn read_completed_file_times_out_if_the_path_never_appears() {
        let dir = tempfile::tempdir().unwrap();
        let never_written = dir.path().join("nope.wav");
        let deadline = Instant::now() + Duration::from_millis(80);
        assert!(read_completed_file(&never_written, deadline).is_err());
    }

    #[test]
    fn sweep_stale_files_clears_leftovers_from_a_previous_process_lifetime() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("old1.wav"), b"1").unwrap();
        fs::write(dir.path().join("old2.wav"), b"2").unwrap();
        sweep_stale_files(dir.path());
        let remaining: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert!(remaining.is_empty(), "sweep must clear every stale file, e.g. on sidecar (re)spawn");
    }
}
