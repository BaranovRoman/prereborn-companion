use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use tauri::{AppHandle, Manager};

use crate::storage;

// WK-75 - local neural TTS via a self-built OHF-Voice/piper1-gpl `libpiper`
// CLI (piper_exe.exe), run strictly as a separate OS process. No piper-rs,
// no FFI, no linking of piper.dll/espeak-ng into this binary - see
// docs/research/local-tts-licensing.md for why (GPL-3.0 subprocess/IPC is
// the classified-safe path; static linking is not). Engine + voice are
// downloaded on first opt-in into app_data_dir(), not bundled in the
// installer, so they survive Companion auto-updates untouched and are
// never fetched for users who never enable this feature.

// Switched from ru_RU-denis-medium to ru_RU-dmitri-medium (WK-77 quality
// audit): both voices are MIT/CC0 (docs/research/local-tts-licensing.md),
// same 22050Hz medium-quality tier, but a spectral comparison of identical
// synthesized phrases showed denis puts ~80% of its energy below 1kHz with
// almost nothing above 4kHz (a measurably dull/bassy signature), while
// dmitri carries meaningfully more energy in the 4-8kHz range - matching
// the reported "muffled/underwater" complaint and its fix. See
// docs/research/wk-77-tts-quality-audit.md for the full comparison.
pub const VOICE_NAME: &str = "ru_RU-dmitri-medium";
const SYNTH_TIMEOUT: Duration = Duration::from_secs(15);
const RUNTIME_ASSET_URL: &str =
    "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/piper-runtime-win-x64.zip";
const VOICE_ASSET_URL: &str =
    "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/piper-voice-ru_RU-dmitri-medium.zip";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TtsEngineState {
    #[default]
    NotStarted,
    Starting,
    Ready,
    Crashed,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    pub enabled: bool,
    pub state: TtsEngineState,
    pub last_error: Option<String>,
    pub resources_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct TtsConfig {
    enabled: bool,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self { enabled: false }
    }
}

pub fn tts_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("tts")
}
fn engine_dir(app: &AppHandle) -> PathBuf {
    tts_dir(app).join("engine")
}
fn voice_dir(app: &AppHandle) -> PathBuf {
    tts_dir(app).join("voices")
}
fn scratch_dir(app: &AppHandle) -> PathBuf {
    tts_dir(app).join("scratch")
}
fn exe_path(app: &AppHandle) -> PathBuf {
    engine_dir(app).join("piper_exe.exe")
}
fn espeak_data_path(app: &AppHandle) -> PathBuf {
    engine_dir(app).join("espeak-ng-data")
}
fn voice_model_path(app: &AppHandle) -> PathBuf {
    voice_dir(app).join(format!("{VOICE_NAME}.onnx"))
}
fn voice_config_path(app: &AppHandle) -> PathBuf {
    voice_dir(app).join(format!("{VOICE_NAME}.onnx.json"))
}
fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("tts-config.json")
}

pub fn resources_ready(app: &AppHandle) -> bool {
    exe_path(app).is_file()
        && espeak_data_path(app).is_dir()
        && voice_model_path(app).is_file()
        && voice_config_path(app).is_file()
}

fn load_config(app: &AppHandle) -> TtsConfig {
    fs::read_to_string(config_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &TtsConfig) -> std::io::Result<()> {
    let path = config_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(config)?)
}

// This build of libpiper's WAV writer (v1.7.0) never patches the RIFF/data
// chunk size fields with the real byte count once synthesis finishes -
// every file it writes declares a fixed placeholder size (~2GB) regardless
// of actual length, confirmed by inspecting real output byte-for-byte
// during the WK-77 quality audit. Chromium/WebView2's own WAV decoder
// tolerates this fine (it clamps to the bytes actually available), so this
// was never the cause of the reported audio-quality complaints - but it's
// a real RIFF-spec violation that would silently break on any stricter
// consumer (a different browser engine, a native player, re-encoding the
// clip), so it's worth fixing at the source rather than leaving it to rely
// on every future consumer being equally lenient. No-ops (leaves bytes
// untouched) if the buffer doesn't parse as a RIFF/WAVE file with a `data`
// chunk - never panics on unexpected engine output.
fn fix_wav_chunk_sizes(bytes: &mut [u8]) {
    const HEADER_LEN: usize = 12; // "RIFF" + size(4) + "WAVE"
    if bytes.len() < HEADER_LEN || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return;
    }
    let mut offset = HEADER_LEN;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let declared_size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if chunk_id == b"data" {
            let actual_size = bytes.len() - offset - 8;
            bytes[offset + 4..offset + 8].copy_from_slice(&(actual_size as u32).to_le_bytes());
            let riff_size = (bytes.len() - 8) as u32;
            bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
            return;
        }
        // Chunks are word-aligned; a chunk with an odd size has one pad byte.
        offset += 8 + declared_size + (declared_size % 2);
    }
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stderr: ChildStderr,
    output_dir: PathBuf,
    spawned_at: Instant,
    call_count: u64,
}

/// Per-call timing/counters from one `Sidecar::synthesize()`, for the TTS
/// diagnostics trace (see diagnostics/tts_trace.rs). Deliberately returned
/// alongside the audio bytes rather than logged from inside `Sidecar`
/// itself - `Sidecar` has no `AppHandle` and stays fully decoupled/testable
/// exactly as before (see the `#[ignore]`d real-subprocess test); only the
/// outer `synthesize()` in this file, which does have an `AppHandle`, turns
/// this into a diagnostics event.
#[derive(Debug, Clone, Copy)]
struct SynthesisTrace {
    text_len: usize,
    stdin_write_ms: f64,
    /// Time+poll-count waiting for Piper's output file to appear at all.
    file_appear_wait_ms: f64,
    file_appear_polls: u32,
    /// Time+poll-count waiting for that file's size to stop changing
    /// (Windows shows the directory entry before Piper finishes writing).
    size_stable_wait_ms: f64,
    size_stable_polls: u32,
    /// How many files were in output_dir at the moment one was picked -
    /// >1 would mean a previous call's file wasn't cleaned up, which the
    /// "at most one file exists" comment in spawn() assumes never happens.
    dir_entries_seen_at_pick: usize,
    wav_bytes_len: usize,
    /// (bytes - 44-byte header) / 4 bytes-per-sample / 22050Hz - the WAV
    /// format was measured byte-exact (22050Hz mono 32-bit float) during
    /// the WK-77 quality audit, so this is a real duration, not a guess.
    output_wav_duration_ms: f64,
}

/// Where to find the engine + voice - split out of Sidecar::spawn so tests
/// can point it at a real local libpiper build without needing a live
/// Tauri AppHandle (app_data_dir() only resolves inside a running app).
struct SidecarPaths {
    exe: PathBuf,
    model: PathBuf,
    config: PathBuf,
    espeak_data: PathBuf,
    output_dir: PathBuf,
}

impl SidecarPaths {
    fn for_app(app: &AppHandle) -> Self {
        Self {
            exe: exe_path(app),
            model: voice_model_path(app),
            config: voice_config_path(app),
            espeak_data: espeak_data_path(app),
            output_dir: scratch_dir(app),
        }
    }
}

// An *explicit* --espeak_data path (as opposed to cwd/relative resolution)
// turned out not to be enough on its own: espeak-ng's own file-reading code
// chokes on any non-ASCII byte in the path itself ("Illegal byte sequence"
// opening phontab), which app_data_dir() hits directly for any Windows
// account with a Cyrillic username - this app's own primary audience.
// Confirmed by reproducing against a real installed Companion's
// app_data_dir() on a Cyrillic-username account, and confirmed fixed by
// resolving to the legacy 8.3 short-path form first (pure ASCII by
// construction, e.g. C:\Users\РОМА~1). Falls back to the original (long)
// path if short names are unavailable (disabled via `fsutil 8dot3name`, or
// the path doesn't exist yet) - Piper will fail the same way it did before
// this fix in that case, not worse.
#[cfg(windows)]
fn to_short_path(path: &Path) -> PathBuf {
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
fn to_short_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

impl Sidecar {
    fn spawn(paths: &SidecarPaths) -> Result<Self, String> {
        let output_dir = paths.output_dir.clone();
        fs::create_dir_all(&output_dir).map_err(|e| format!("Piper scratch dir: {e}"))?;
        // Clear anything left over from a previous crashed/killed run so the
        // "exactly one new file per synthesize() call" invariant holds.
        for entry in fs::read_dir(&output_dir).into_iter().flatten().flatten() {
            let _ = fs::remove_file(entry.path());
        }

        let mut cmd = Command::new(&paths.exe);
        cmd.arg("--model")
            .arg(to_short_path(&paths.model))
            .arg("--config")
            .arg(to_short_path(&paths.config))
            .arg("--espeak_data")
            .arg(to_short_path(&paths.espeak_data))
            .arg("--output_dir")
            .arg(to_short_path(&output_dir))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Without this, spawning a console-subsystem child from a GUI
            // app flashes a console window on screen for every restart.
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Не удалось запустить Piper: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Piper stdin unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Piper stderr unavailable".to_string())?;
        Ok(Self { child, stdin, stderr, output_dir, spawned_at: Instant::now(), call_count: 0 })
    }

    fn synthesize(&mut self, text: &str) -> Result<(Vec<u8>, SynthesisTrace), String> {
        self.call_count += 1;

        // Piper's stdin protocol is one line per utterance - strip any
        // embedded newlines rather than let them desync line framing.
        let line: String = text.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
        let stdin_write_started = Instant::now();
        writeln!(self.stdin, "{line}").map_err(|e| format!("Piper stdin: {e}"))?;
        self.stdin.flush().map_err(|e| format!("Piper stdin: {e}"))?;
        let stdin_write_ms = stdin_write_started.elapsed().as_secs_f64() * 1000.0;

        let file_appear_started = Instant::now();
        let deadline = Instant::now() + SYNTH_TIMEOUT;
        let mut file_appear_polls: u32 = 0;
        let (path, dir_entries_seen_at_pick) = loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                let stderr = self.drain_stderr();
                let detail = if stderr.is_empty() { String::new() } else { format!(": {stderr}") };
                return Err(format!("Piper завершился неожиданно ({status}){detail}"));
            }
            let mut names: Vec<_> = fs::read_dir(&self.output_dir)
                .map_err(|e| format!("Piper output dir: {e}"))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect();
            // Filenames are monotonic nanosecond timestamps from piper
            // itself - sorting gives write order, though in practice at
            // most one file exists (see spawn(), invariant enforced there).
            names.sort();
            let entries_seen = names.len();
            if let Some(path) = names.into_iter().next() {
                break (path, entries_seen);
            }
            file_appear_polls += 1;
            if Instant::now() >= deadline {
                return Err("Piper synthesis timed out".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let file_appear_wait_ms = file_appear_started.elapsed().as_secs_f64() * 1000.0;

        // Windows makes the directory entry visible as soon as the file is
        // created, before Piper has finished writing/flushing its contents
        // - reading immediately on first sight can race and return a
        // truncated (or 0-byte) file. Wait for the size to stop changing
        // across two consecutive polls before treating it as complete.
        let size_stable_started = Instant::now();
        let mut size_stable_polls: u32 = 0;
        let mut last_size: Option<u64> = None;
        loop {
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if size > 0 && last_size == Some(size) {
                break;
            }
            last_size = Some(size);
            size_stable_polls += 1;
            if Instant::now() >= deadline {
                return Err("Piper output file never finished writing".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let size_stable_wait_ms = size_stable_started.elapsed().as_secs_f64() * 1000.0;

        let mut bytes = fs::read(&path).map_err(|e| format!("Piper output file: {e}"))?;
        let _ = fs::remove_file(&path);
        fix_wav_chunk_sizes(&mut bytes);

        const WAV_HEADER_LEN: usize = 44;
        const BYTES_PER_SAMPLE: usize = 4;
        const SAMPLE_RATE_HZ: f64 = 22050.0;
        let sample_count = bytes.len().saturating_sub(WAV_HEADER_LEN) / BYTES_PER_SAMPLE;
        let output_wav_duration_ms = sample_count as f64 / SAMPLE_RATE_HZ * 1000.0;

        let trace = SynthesisTrace {
            text_len: text.chars().count(),
            stdin_write_ms,
            file_appear_wait_ms,
            file_appear_polls,
            size_stable_wait_ms,
            size_stable_polls,
            dir_entries_seen_at_pick,
            wav_bytes_len: bytes.len(),
            output_wav_duration_ms,
        };
        Ok((bytes, trace))
    }

    // Only called after try_wait() has confirmed the child already exited,
    // so its stderr pipe is guaranteed to EOF once buffered data is read -
    // this can't block waiting on a still-running process.
    fn drain_stderr(&mut self) -> String {
        let mut buf = String::new();
        let _ = self.stderr.read_to_string(&mut buf);
        buf.trim().to_string()
    }

    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct TtsInner {
    enabled: bool,
    state: TtsEngineState,
    last_error: Option<String>,
    sidecar: Option<Sidecar>,
}

pub struct TtsState(pub Mutex<TtsInner>);

impl TtsState {
    pub fn new() -> Self {
        Self(Mutex::new(TtsInner::default()))
    }
}

pub fn init(app: &AppHandle) {
    let config = load_config(app);
    let state = app.state::<TtsState>();
    state.0.lock().unwrap().enabled = config.enabled;
}

pub fn status(app: &AppHandle) -> TtsStatus {
    let state = app.state::<TtsState>();
    let inner = state.0.lock().unwrap();
    TtsStatus {
        enabled: inner.enabled,
        state: inner.state,
        last_error: inner.last_error.clone(),
        resources_ready: resources_ready(app),
    }
}

/// Downloads + extracts the engine and voice archives into app_data_dir()
/// if they aren't already present. Idempotent - a no-op once resources
/// exist, so re-enabling after a prior successful download never
/// re-downloads. Blocking (reqwest blocking client, ~30MB) - called from
/// a Tauri command, off the UI thread already by virtue of IPC dispatch.
pub fn ensure_resources(app: &AppHandle) -> Result<(), String> {
    if resources_ready(app) {
        return Ok(());
    }
    fs::create_dir_all(engine_dir(app)).map_err(|e| format!("Piper engine dir: {e}"))?;
    fs::create_dir_all(voice_dir(app)).map_err(|e| format!("Piper voice dir: {e}"))?;
    download_and_extract(RUNTIME_ASSET_URL, &engine_dir(app))?;
    download_and_extract(VOICE_ASSET_URL, &voice_dir(app))?;
    if !resources_ready(app) {
        return Err("Ресурсы Piper скачаны, но неполны".to_string());
    }
    Ok(())
}

fn download_and_extract(url: &str, dest: &Path) -> Result<(), String> {
    let response = reqwest::blocking::get(url).map_err(|e| format!("Скачивание не удалось: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Скачивание не удалось: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("Скачивание не удалось: {e}"))?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Повреждённый архив: {e}"))?;
    archive
        .extract(dest)
        .map_err(|e| format!("Не удалось распаковать архив: {e}"))
}

pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<TtsStatus, String> {
    if enabled {
        ensure_resources(app)?;
    }
    let state = app.state::<TtsState>();
    {
        let mut inner = state.0.lock().unwrap();
        inner.enabled = enabled;
        if !enabled {
            if let Some(sidecar) = inner.sidecar.take() {
                sidecar.kill();
            }
            inner.state = TtsEngineState::NotStarted;
            inner.last_error = None;
        }
    }
    save_config(app, &TtsConfig { enabled }).map_err(|e| e.to_string())?;
    storage::append_rolling_log(
        app,
        &format!("Piper TTS {}.", if enabled { "enabled" } else { "disabled" }),
    );
    Ok(status(app))
}

/// Builds the diagnostics-only TTS trace event for one Piper synthesis call
/// (see diagnostics/tts_trace.rs) - kept as a plain function of already-
/// computed values (no AppHandle, no mutex) so it can't itself pick up any
/// locking/IO concerns beyond what `synthesize()` below already has.
fn build_tts_trace_event(
    message_id: &str,
    respawned: bool,
    sidecar_age_ms: f64,
    call_count: u64,
    trace: &SynthesisTrace,
) -> crate::diagnostics::tts_trace::TtsTraceEvent {
    use crate::diagnostics::tts_trace::{TtsTraceEvent, TtsTraceSource};
    let mut stages = std::collections::BTreeMap::new();
    stages.insert("sidecarWriteMs".to_string(), trace.stdin_write_ms);
    stages.insert("fileAppearWaitMs".to_string(), trace.file_appear_wait_ms);
    stages.insert("sizeStableWaitMs".to_string(), trace.size_stable_wait_ms);
    stages.insert(
        "synthesisTotalMs".to_string(),
        trace.stdin_write_ms + trace.file_appear_wait_ms + trace.size_stable_wait_ms,
    );
    TtsTraceEvent {
        message_id: message_id.to_string(),
        source: TtsTraceSource::PiperSidecar,
        local_time: chrono::Local::now().to_rfc3339(),
        engine: Some(VOICE_NAME.to_string()),
        stages,
        detail: serde_json::json!({
            "textLen": trace.text_len,
            "fileAppearPolls": trace.file_appear_polls,
            "sizeStablePolls": trace.size_stable_polls,
            "dirEntriesSeenAtPick": trace.dir_entries_seen_at_pick,
            "wavBytesLen": trace.wav_bytes_len,
            "outputWavDurationMs": trace.output_wav_duration_ms,
            "sidecarRespawnedThisCall": respawned,
            "sidecarAgeMs": sidecar_age_ms,
            "sidecarCallCount": call_count,
        }),
    }
}

/// Synthesizes one utterance, lazily starting (or restarting, after a
/// crash) the persistent sidecar as needed. Calls are serialized by the
/// Mutex here - matches the frontend's own one-utterance-at-a-time queue
/// (BoundedTtsQueue + the `speaking` gate in TwitchChatPage.tsx), so this
/// never needs to arbitrate concurrent synthesis requests.
///
/// `message_id` is diagnostics-only (see diagnostics/tts_trace.rs) - `None`
/// (the normal, non-diagnostic path) skips emitting a trace event entirely
/// and behaves exactly as before this was added.
pub fn synthesize(app: &AppHandle, text: &str, message_id: Option<&str>) -> Result<Vec<u8>, String> {
    let state = app.state::<TtsState>();
    let mut inner = state.0.lock().unwrap();
    if !inner.enabled {
        return Err("Piper TTS выключен".to_string());
    }
    if !resources_ready(app) {
        inner.state = TtsEngineState::Unavailable;
        inner.last_error = Some("Ресурсы Piper ещё не загружены".to_string());
        return Err(inner.last_error.clone().unwrap());
    }
    if let Some(sidecar) = inner.sidecar.as_mut() {
        if matches!(sidecar.child.try_wait(), Ok(Some(_))) {
            inner.sidecar = None;
        }
    }
    let respawned = inner.sidecar.is_none();
    if respawned {
        inner.state = TtsEngineState::Starting;
        match Sidecar::spawn(&SidecarPaths::for_app(app)) {
            Ok(sidecar) => {
                inner.sidecar = Some(sidecar);
                inner.last_error = None;
            }
            Err(error) => {
                inner.state = TtsEngineState::Crashed;
                inner.last_error = Some(error.clone());
                drop(inner);
                storage::append_rolling_log(app, &format!("Piper TTS failed to start: {error}"));
                return Err(error);
            }
        }
    }

    let synth_result = inner.sidecar.as_mut().expect("just ensured").synthesize(text);
    let (bytes, trace) = match synth_result {
        Ok(pair) => pair,
        Err(error) => {
            // Don't reuse a sidecar that just failed - next call respawns
            // fresh instead of retrying against a possibly-wedged process.
            if let Some(sidecar) = inner.sidecar.take() {
                sidecar.kill();
            }
            inner.state = TtsEngineState::Crashed;
            inner.last_error = Some(error.clone());
            drop(inner);
            storage::append_rolling_log(app, &format!("Piper TTS synthesis failed: {error}"));
            return Err(error);
        }
    };
    inner.state = TtsEngineState::Ready;
    inner.last_error = None;
    let sidecar_age_ms =
        inner.sidecar.as_ref().map(|s| s.spawned_at.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0);
    let call_count = inner.sidecar.as_ref().map(|s| s.call_count).unwrap_or(0);
    drop(inner);

    if let Some(message_id) = message_id {
        let event = build_tts_trace_event(message_id, respawned, sidecar_age_ms, call_count, &trace);
        crate::diagnostics::observe_tts_stage(app, &event);
    }
    Ok(bytes)
}

pub fn synthesize_base64(app: &AppHandle, text: &str, message_id: Option<&str>) -> Result<String, String> {
    synthesize(app, text, message_id).map(|bytes| BASE64.encode(bytes))
}

/// Stops the sidecar without touching the `enabled` setting - used on app
/// exit (see lib.rs's tray "quit" handler). Re-enabling the setting later
/// (or the next chat message, if it was left enabled) spawns a fresh one.
pub fn stop(app: &AppHandle) {
    let state = app.state::<TtsState>();
    let mut inner = state.0.lock().unwrap();
    if let Some(sidecar) = inner.sidecar.take() {
        sidecar.kill();
    }
    inner.state = TtsEngineState::NotStarted;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_config_defaults_to_disabled() {
        let config: TtsConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!config.enabled);
    }

    #[test]
    fn tts_config_round_trips() {
        let config: TtsConfig = serde_json::from_value(serde_json::json!({ "enabled": true })).unwrap();
        assert!(config.enabled);
    }

    #[test]
    fn engine_state_defaults_to_not_started() {
        assert_eq!(TtsEngineState::default(), TtsEngineState::NotStarted);
    }

    // Builds a minimal RIFF/WAVE/fmt/data buffer, optionally with bogus
    // chunk-size fields matching what this exact libpiper build actually
    // emits (confirmed byte-for-byte during the WK-77 audit: RIFF size
    // 0x7ffff024, data size 0x7ffff000, regardless of real payload length).
    fn build_wav(data_payload: &[u8], bogus_sizes: bool) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&if bogus_sizes { 0x7ffff024u32 } else { (36 + data_payload.len()) as u32 }.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&22050u32.to_le_bytes());
        buf.extend_from_slice(&88200u32.to_le_bytes());
        buf.extend_from_slice(&4u16.to_le_bytes());
        buf.extend_from_slice(&32u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&if bogus_sizes { 0x7ffff000u32 } else { data_payload.len() as u32 }.to_le_bytes());
        buf.extend_from_slice(data_payload);
        buf
    }

    #[test]
    fn fix_wav_chunk_sizes_corrects_bogus_placeholder_sizes() {
        let payload = vec![0u8; 200];
        let mut bytes = build_wav(&payload, true);
        fix_wav_chunk_sizes(&mut bytes);
        let riff_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let data_size = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
        assert_eq!(riff_size as usize, bytes.len() - 8);
        assert_eq!(data_size as usize, payload.len());
    }

    #[test]
    fn fix_wav_chunk_sizes_is_a_no_op_on_already_correct_sizes() {
        let payload = vec![1u8, 2, 3, 4];
        let original = build_wav(&payload, false);
        let mut bytes = original.clone();
        fix_wav_chunk_sizes(&mut bytes);
        assert_eq!(bytes, original);
    }

    #[test]
    fn fix_wav_chunk_sizes_never_panics_on_garbage_input() {
        let mut empty: Vec<u8> = Vec::new();
        fix_wav_chunk_sizes(&mut empty);
        assert!(empty.is_empty());

        let mut too_short = b"RIFF".to_vec();
        fix_wav_chunk_sizes(&mut too_short);
        assert_eq!(too_short, b"RIFF");

        let mut not_riff = b"not a wav file at all".to_vec();
        let copy = not_riff.clone();
        fix_wav_chunk_sizes(&mut not_riff);
        assert_eq!(not_riff, copy);
    }

    #[test]
    fn to_short_path_falls_back_when_path_does_not_exist() {
        // GetShortPathNameW (Windows) can only resolve a path that already
        // exists on disk; a nonexistent path must fall back to itself
        // unchanged rather than erroring or panicking.
        let missing = std::path::PathBuf::from("Z:\\this\\path\\does\\not\\exist\\at\\all");
        assert_eq!(to_short_path(&missing), missing);
    }

    // Real subprocess IPC test against an actual local libpiper build - not
    // run by default (no such build exists in CI/dev checkouts) and needs
    // no AppHandle, only plain paths. Point the four PIPER_TEST_* env vars
    // at a build produced the same way as the WK-74 spike
    // (docs/research/wk-74-libpiper-ci-spike.md) and run explicitly with:
    //   cargo test --manifest-path apps/companion/src-tauri/Cargo.toml \
    //     tts::tests::synthesize_against_a_real_local_libpiper_build -- --ignored --nocapture
    #[test]
    #[ignore]
    fn synthesize_against_a_real_local_libpiper_build() {
        let Ok(exe) = std::env::var("PIPER_TEST_EXE") else {
            panic!("set PIPER_TEST_EXE/_MODEL/_CONFIG/_ESPEAK_DATA to run this test");
        };
        let model = std::env::var("PIPER_TEST_MODEL").unwrap();
        let config = std::env::var("PIPER_TEST_CONFIG").unwrap();
        let espeak_data = std::env::var("PIPER_TEST_ESPEAK_DATA").unwrap();
        let output_dir = tempfile::tempdir().unwrap();

        let paths = SidecarPaths {
            exe: exe.into(),
            model: model.into(),
            config: config.into(),
            espeak_data: espeak_data.into(),
            output_dir: output_dir.path().to_path_buf(),
        };
        let mut sidecar = Sidecar::spawn(&paths).expect("spawn");

        let (first, first_trace) = sidecar.synthesize("Привет стример, как дела в игре сегодня?").expect("first synthesize");
        assert!(first.len() > 1000, "suspiciously small wav: {} bytes", first.len());
        assert_eq!(&first[0..4], b"RIFF", "not a valid WAV file");
        assert_eq!(first_trace.wav_bytes_len, first.len());

        // Second call against the SAME child process proves persistence -
        // the whole point of this architecture (see local-tts-licensing.md
        // and the implementation plan in wk-74-libpiper-ci-spike.md).
        let pid_before = sidecar.child.id();
        let (second, _) = sidecar.synthesize("гг вп").expect("second synthesize");
        assert_eq!(sidecar.child.id(), pid_before, "sidecar respawned instead of being reused");
        assert!(second.len() > 500);
        assert_eq!(&second[0..4], b"RIFF");

        sidecar.kill();
    }

    // Targeted repro for the WK diagnostics brief's truncation report: this
    // exact multi-question message was reported as spoken only up to the
    // first "?". Static analysis of prepareTtsText/normalizeMessageForSpeech
    // found no sentence-truncation logic in Companion's own text pipeline
    // (see chat-model.test.ts/tts-normalize.test.ts), so if this is a real
    // bug it must be inside libpiper itself - this asserts the returned WAV's
    // computed duration is proportionate to the full sent text, not just the
    // first clause. Run with the same env vars as the test above:
    //   cargo test --manifest-path apps/companion/src-tauri/Cargo.toml \
    //     tts::tests::piper_does_not_truncate_a_multi_question_message -- --ignored --nocapture
    #[test]
    #[ignore]
    fn piper_does_not_truncate_a_multi_question_message() {
        let Ok(exe) = std::env::var("PIPER_TEST_EXE") else {
            panic!("set PIPER_TEST_EXE/_MODEL/_CONFIG/_ESPEAK_DATA to run this test");
        };
        let model = std::env::var("PIPER_TEST_MODEL").unwrap();
        let config = std::env::var("PIPER_TEST_CONFIG").unwrap();
        let espeak_data = std::env::var("PIPER_TEST_ESPEAK_DATA").unwrap();
        let output_dir = tempfile::tempdir().unwrap();

        let paths = SidecarPaths {
            exe: exe.into(),
            model: model.into(),
            config: config.into(),
            espeak_data: espeak_data.into(),
            output_dir: output_dir.path().to_path_buf(),
        };
        let mut sidecar = Sidecar::spawn(&paths).expect("spawn");

        let full = "а тебе снилось что ты бабочка? или бабочке снилось что это ты? или бабочке снилось что ты бабочка?";
        let (full_bytes, full_trace) = sidecar.synthesize(full).expect("full synthesize");
        let (short_bytes, short_trace) = sidecar.synthesize("а тебе снилось что ты бабочка?").expect("short synthesize");

        println!(
            "full: {} chars -> {:.0}ms audio ({} bytes); first-question-only: {} chars -> {:.0}ms audio ({} bytes)",
            full_trace.text_len,
            full_trace.output_wav_duration_ms,
            full_bytes.len(),
            short_trace.text_len,
            short_trace.output_wav_duration_ms,
            short_bytes.len(),
        );

        // The full three-question message is ~3.3x the character count of
        // just the first question - if Piper only synthesizes the first
        // clause, full_trace's duration will be roughly equal to
        // short_trace's instead of proportionately longer. A generous 1.5x
        // threshold (well below the ~3.3x expected for full synthesis)
        // still clearly distinguishes "truncated" from "not truncated".
        assert!(
            full_trace.output_wav_duration_ms > short_trace.output_wav_duration_ms * 1.5,
            "full message's audio duration ({:.0}ms) is not proportionately longer than the first-question-only \
             duration ({:.0}ms) - this points at Piper/espeak-ng truncating after the first sentence",
            full_trace.output_wav_duration_ms,
            short_trace.output_wav_duration_ms,
        );

        sidecar.kill();
    }
}
