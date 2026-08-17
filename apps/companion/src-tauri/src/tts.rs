use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::io::Write;
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

pub const VOICE_NAME: &str = "ru_RU-denis-medium";
const SYNTH_TIMEOUT: Duration = Duration::from_secs(15);
const RUNTIME_ASSET_URL: &str =
    "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/piper-runtime-win-x64.zip";
const VOICE_ASSET_URL: &str =
    "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/piper-voice-ru_RU-denis-medium.zip";

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

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    output_dir: PathBuf,
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
            .arg(&paths.model)
            .arg("--config")
            .arg(&paths.config)
            // Explicit path, never cwd/relative resolution - a Cyrillic
            // Windows username otherwise breaks espeak-ng-data loading
            // ("Illegal byte sequence"), see wk-74-piper-prototype-findings.md.
            .arg("--espeak_data")
            .arg(&paths.espeak_data)
            .arg("--output_dir")
            .arg(&output_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
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
        Ok(Self { child, stdin, output_dir })
    }

    fn synthesize(&mut self, text: &str) -> Result<Vec<u8>, String> {
        // Piper's stdin protocol is one line per utterance - strip any
        // embedded newlines rather than let them desync line framing.
        let line: String = text.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
        writeln!(self.stdin, "{line}").map_err(|e| format!("Piper stdin: {e}"))?;
        self.stdin.flush().map_err(|e| format!("Piper stdin: {e}"))?;

        let deadline = Instant::now() + SYNTH_TIMEOUT;
        let path = loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("Piper завершился неожиданно ({status})"));
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
            if let Some(path) = names.into_iter().next() {
                break path;
            }
            if Instant::now() >= deadline {
                return Err("Piper synthesis timed out".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        };

        // Windows makes the directory entry visible as soon as the file is
        // created, before Piper has finished writing/flushing its contents
        // - reading immediately on first sight can race and return a
        // truncated (or 0-byte) file. Wait for the size to stop changing
        // across two consecutive polls before treating it as complete.
        let mut last_size: Option<u64> = None;
        loop {
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if size > 0 && last_size == Some(size) {
                break;
            }
            last_size = Some(size);
            if Instant::now() >= deadline {
                return Err("Piper output file never finished writing".to_string());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let bytes = fs::read(&path).map_err(|e| format!("Piper output file: {e}"))?;
        let _ = fs::remove_file(&path);
        Ok(bytes)
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

/// Synthesizes one utterance, lazily starting (or restarting, after a
/// crash) the persistent sidecar as needed. Calls are serialized by the
/// Mutex here - matches the frontend's own one-utterance-at-a-time queue
/// (BoundedTtsQueue + the `speaking` gate in TwitchChatPage.tsx), so this
/// never needs to arbitrate concurrent synthesis requests.
pub fn synthesize(app: &AppHandle, text: &str) -> Result<Vec<u8>, String> {
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
    if inner.sidecar.is_none() {
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
    let result = inner.sidecar.as_mut().expect("just ensured").synthesize(text);
    match &result {
        Ok(_) => {
            inner.state = TtsEngineState::Ready;
            inner.last_error = None;
        }
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
            return result;
        }
    }
    result
}

pub fn synthesize_base64(app: &AppHandle, text: &str) -> Result<String, String> {
    synthesize(app, text).map(|bytes| BASE64.encode(bytes))
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

        let first = sidecar.synthesize("Привет стример, как дела в игре сегодня?").expect("first synthesize");
        assert!(first.len() > 1000, "suspiciously small wav: {} bytes", first.len());
        assert_eq!(&first[0..4], b"RIFF", "not a valid WAV file");

        // Second call against the SAME child process proves persistence -
        // the whole point of this architecture (see local-tts-licensing.md
        // and the implementation plan in wk-74-libpiper-ci-spike.md).
        let pid_before = sidecar.child.id();
        let second = sidecar.synthesize("гг вп").expect("second synthesize");
        assert_eq!(sidecar.child.id(), pid_before, "sidecar respawned instead of being reused");
        assert!(second.len() > 500);
        assert_eq!(&second[0..4], b"RIFF");

        sidecar.kill();
    }
}
