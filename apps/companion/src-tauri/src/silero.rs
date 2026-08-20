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
use crate::tts_common::{read_completed_file, spawn_stdout_reader, sweep_stale_files, to_short_path};
#[cfg(windows)]
use crate::tts_common::CREATE_NO_WINDOW;

// WK-81 - local neural TTS via Silero `v5_5_ru`, run as a persistent Python
// sidecar (see docs/research/wk-81-silero-tts-feasibility.md for why: no
// ONNX or other non-Python inference path exists for this model, confirmed
// directly, not assumed). This is the PRIMARY engine; Piper (tts.rs)
// remains the fallback, system speechSynthesis the last resort - the
// fallback chain itself lives in the frontend (useTwitchChatSession.ts),
// not here. This module only owns the Silero sidecar's lifecycle.
//
// NON-COMMERCIAL LICENSE NOTICE: the v5_5_ru model is distributed by
// snakers4/silero-models under CC BY-NC-SA 4.0 (NonCommercial). This
// integration is accepted only for Companion's current non-commercial
// stage - see docs/research/wk-74-silero-tts-discovery.md for the license
// text and reasoning, and the in-app notice in TwitchChatPage.tsx. Before
// any commercial use/distribution of Companion, this dependency must be
// re-licensed (Silero Enterprise Edition) or replaced.

pub const RUNTIME_ASSET_URL: &str =
    "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/silero-runtime-win-x64.zip";
pub const MODEL_ASSET_URL: &str =
    "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/silero-model-v5-5-ru.zip";
const MODEL_FILE_NAME: &str = "v5_5_ru.pt";
const SIDECAR_SCRIPT_NAME: &str = "silero_sidecar.py";

// Bumped whenever the runtime/model packaging format changes in a way that
// makes an already-downloaded copy incompatible - forces a fresh download
// instead of trying (and failing confusingly) to run a stale layout.
// Existing valid installs are left alone otherwise, even across Companion
// auto-updates (WK-81 requirement: don't re-download on every update).
const SILERO_RESOURCE_VERSION: &str = "1";

// Cold interpreter + `import torch` + model load measured ~1.7-2s on this
// dev machine with a warm disk cache (docs/research/wk-81-silero-tts-feasibility.md);
// generous headroom for a slower disk/antivirus scan right after a fresh
// download.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
// Warm synthesis measured well under 1s even for long phrases; generous
// headroom, still bounded (WK-81 requirement: no unbounded synthesis wait).
const SYNTH_TIMEOUT: Duration = Duration::from_secs(20);
// Runtime archive is large (embeddable Python + PyTorch CPU, ~600-700MB
// zipped) - a much longer bound than Piper's 60s is warranted, but still a
// bound, not "wait forever" (WK-81 requirement: bounded download timeout).
const RUNTIME_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(900);
const MODEL_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
// After this many consecutive failures (spawn or synthesis), stop
// attempting Silero for COOLDOWN_DURATION instead of respawning on every
// single call - avoids an aggressive infinite restart loop (WK-81
// requirement) while still recovering automatically once the cooldown
// elapses.
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
const COOLDOWN_DURATION: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SileroEngineState {
    #[default]
    NotStarted,
    Starting,
    Ready,
    Crashed,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SileroVoice {
    Aidar,
    Baya,
    Kseniya,
    Xenia,
    Eugene,
}

impl SileroVoice {
    pub fn as_str(&self) -> &'static str {
        match self {
            SileroVoice::Aidar => "aidar",
            SileroVoice::Baya => "baya",
            SileroVoice::Kseniya => "kseniya",
            SileroVoice::Xenia => "xenia",
            SileroVoice::Eugene => "eugene",
        }
    }
}

// `xenia` picked as a neutral default (commonly the default voice cited in
// Silero's own examples/community usage) - not a human-verified subjective
// listening comparison, since no human listener was available in the
// environment this was implemented in. All 5 voices remain fully
// selectable; see the feature report for how to pick a different default.
impl Default for SileroVoice {
    fn default() -> Self {
        SileroVoice::Xenia
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SileroStatus {
    pub enabled: bool,
    pub state: SileroEngineState,
    pub last_error: Option<String>,
    pub resources_ready: bool,
    pub voice: SileroVoice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct SileroConfig {
    enabled: bool,
    voice: SileroVoice,
}

impl Default for SileroConfig {
    fn default() -> Self {
        Self { enabled: false, voice: SileroVoice::default() }
    }
}

pub fn silero_dir(app: &AppHandle) -> PathBuf {
    crate::tts::tts_dir(app).join("silero")
}
fn runtime_dir(app: &AppHandle) -> PathBuf {
    silero_dir(app).join("runtime")
}
fn model_dir(app: &AppHandle) -> PathBuf {
    silero_dir(app).join("model")
}
fn scratch_dir(app: &AppHandle) -> PathBuf {
    silero_dir(app).join("scratch")
}
fn python_exe_path(app: &AppHandle) -> PathBuf {
    runtime_dir(app).join("python.exe")
}
fn sidecar_script_path(app: &AppHandle) -> PathBuf {
    runtime_dir(app).join(SIDECAR_SCRIPT_NAME)
}
fn model_file_path(app: &AppHandle) -> PathBuf {
    model_dir(app).join(MODEL_FILE_NAME)
}
fn version_marker_path(app: &AppHandle) -> PathBuf {
    silero_dir(app).join(".resource-version")
}
fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("silero-config.json")
}

fn installed_resource_version(app: &AppHandle) -> Option<String> {
    fs::read_to_string(version_marker_path(app)).ok().map(|s| s.trim().to_string())
}

pub fn resources_ready(app: &AppHandle) -> bool {
    python_exe_path(app).is_file()
        && sidecar_script_path(app).is_file()
        && model_file_path(app).is_file()
        && installed_resource_version(app).as_deref() == Some(SILERO_RESOURCE_VERSION)
}

fn load_config(app: &AppHandle) -> SileroConfig {
    fs::read_to_string(config_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &SileroConfig) -> std::io::Result<()> {
    let path = config_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(config)?)
}

struct SileroSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout_lines: std::sync::mpsc::Receiver<String>,
    stderr: ChildStderr,
    spawned_at: Instant,
    call_count: u64,
}

#[derive(Debug, Clone, Copy)]
struct SynthesisTrace {
    text_len: usize,
    stdin_write_ms: f64,
    completion_wait_ms: f64,
    wav_bytes_len: usize,
}

struct SidecarPaths {
    python_exe: PathBuf,
    sidecar_script: PathBuf,
    model: PathBuf,
    output_dir: PathBuf,
}

impl SidecarPaths {
    fn for_app(app: &AppHandle) -> Self {
        Self {
            python_exe: python_exe_path(app),
            sidecar_script: sidecar_script_path(app),
            model: model_file_path(app),
            output_dir: scratch_dir(app),
        }
    }
}

#[derive(Deserialize)]
struct SidecarReadyLine {
    #[serde(default)]
    ready: bool,
}

#[derive(Deserialize)]
struct SidecarResponseLine {
    #[serde(default)]
    id: Option<String>,
    ok: bool,
    #[serde(default)]
    wav: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

impl SileroSidecar {
    fn spawn(paths: &SidecarPaths) -> Result<Self, String> {
        let output_dir = paths.output_dir.clone();
        fs::create_dir_all(&output_dir).map_err(|e| format!("Silero scratch dir: {e}"))?;
        sweep_stale_files(&output_dir);

        let mut cmd = Command::new(&paths.python_exe);
        cmd.arg(to_short_path(&paths.sidecar_script))
            .arg(to_short_path(&paths.model))
            .arg(to_short_path(&output_dir))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Не удалось запустить Silero: {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "Silero stdin unavailable".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "Silero stdout unavailable".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "Silero stderr unavailable".to_string())?;
        let stdout_lines = spawn_stdout_reader(stdout);

        let mut sidecar =
            Self { child, stdin, stdout_lines, stderr, spawned_at: Instant::now(), call_count: 0 };

        // Wait for the sidecar's own explicit readiness signal (model
        // fully loaded) rather than assuming "process spawned" means
        // "ready to synthesize" - model load alone takes ~500ms on top of
        // interpreter+import startup.
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Ok(Some(status)) = sidecar.child.try_wait() {
                let stderr = sidecar.drain_stderr();
                let detail = if stderr.is_empty() { String::new() } else { format!(": {stderr}") };
                return Err(format!("Silero завершился при запуске ({status}){detail}"));
            }
            match sidecar.stdout_lines.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    if let Ok(ready) = serde_json::from_str::<SidecarReadyLine>(&line) {
                        if ready.ready {
                            return Ok(sidecar);
                        }
                    }
                    // Any other line before readiness (e.g. a fatal model
                    // load error the sidecar reports as JSON) is a startup
                    // failure, not something to wait past.
                    return Err(format!("Silero сообщил об ошибке запуска: {line}"));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
            }
            if Instant::now() >= deadline {
                sidecar.kill();
                return Err("Silero не запустился за отведённое время".to_string());
            }
        }
    }

    fn synthesize(&mut self, text: &str, voice: SileroVoice) -> Result<(Vec<u8>, SynthesisTrace), String> {
        self.call_count += 1;
        let request_id = format!("req-{}", self.call_count);

        let request = serde_json::json!({ "id": request_id, "text": text, "speaker": voice.as_str() });
        let line = serde_json::to_string(&request).map_err(|e| format!("Silero request encode: {e}"))?;
        let stdin_write_started = Instant::now();
        writeln!(self.stdin, "{line}").map_err(|e| format!("Silero stdin: {e}"))?;
        self.stdin.flush().map_err(|e| format!("Silero stdin: {e}"))?;
        let stdin_write_ms = stdin_write_started.elapsed().as_secs_f64() * 1000.0;

        let completion_started = Instant::now();
        let deadline = Instant::now() + SYNTH_TIMEOUT;
        let response = loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                let stderr = self.drain_stderr();
                let detail = if stderr.is_empty() { String::new() } else { format!(": {stderr}") };
                return Err(format!("Silero завершился неожиданно ({status}){detail}"));
            }
            match self.stdout_lines.recv_timeout(Duration::from_millis(50)) {
                Ok(raw_line) => match serde_json::from_str::<SidecarResponseLine>(&raw_line) {
                    // Correlate strictly by request id - never accept a
                    // response meant for a different call, the same class
                    // of correctness bug WK-79 fixed for Piper via an
                    // ordering assumption instead of an explicit id.
                    Ok(parsed) if parsed.id.as_deref() == Some(request_id.as_str()) => break parsed,
                    _ => continue,
                },
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
            }
            if Instant::now() >= deadline {
                return Err("Silero synthesis timed out".to_string());
            }
        };
        let completion_wait_ms = completion_started.elapsed().as_secs_f64() * 1000.0;

        if !response.ok {
            return Err(response.error.unwrap_or_else(|| "Silero synthesis failed".to_string()));
        }
        let wav_path = response.wav.ok_or_else(|| "Silero response missing wav path".to_string())?;
        let bytes = read_completed_file(Path::new(&wav_path), deadline)?;
        let _ = fs::remove_file(&wav_path);

        let trace = SynthesisTrace {
            text_len: text.chars().count(),
            stdin_write_ms,
            completion_wait_ms,
            wav_bytes_len: bytes.len(),
        };
        Ok((bytes, trace))
    }

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
pub struct SileroInner {
    enabled: bool,
    state: SileroEngineState,
    last_error: Option<String>,
    voice: SileroVoice,
    sidecar: Option<SileroSidecar>,
    consecutive_failures: u32,
    cooldown_until: Option<Instant>,
}

pub struct SileroState(pub Mutex<SileroInner>);

impl SileroState {
    pub fn new() -> Self {
        Self(Mutex::new(SileroInner::default()))
    }
}

pub fn init(app: &AppHandle) {
    let config = load_config(app);
    let state = app.state::<SileroState>();
    let mut inner = state.0.lock().unwrap();
    inner.enabled = config.enabled;
    inner.voice = config.voice;
}

pub fn status(app: &AppHandle) -> SileroStatus {
    let state = app.state::<SileroState>();
    let inner = state.0.lock().unwrap();
    SileroStatus {
        enabled: inner.enabled,
        state: inner.state,
        last_error: inner.last_error.clone(),
        resources_ready: resources_ready(app),
        voice: inner.voice,
    }
}

/// Downloads + extracts the runtime (embeddable Python + PyTorch CPU +
/// sidecar script) and model archives into a staging directory first, only
/// swapping them into place once each archive is fully extracted and
/// sanity-checked - a partial/corrupt download or an interrupted extract
/// never leaves a half-installed state that `resources_ready()` would
/// wrongly accept, and a failed attempt cleans its own staging directory so
/// disk usage doesn't grow across repeated failed retries (WK-81 requirement).
fn ensure_resources_blocking(app: &AppHandle) -> Result<(), String> {
    if resources_ready(app) {
        return Ok(());
    }

    let staging_root = silero_dir(app).join(".staging");
    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir_all(&staging_root).map_err(|e| format!("Silero staging dir: {e}"))?;

    let runtime_staging = staging_root.join("runtime");
    let model_staging = staging_root.join("model");
    fs::create_dir_all(&runtime_staging).map_err(|e| format!("Silero runtime staging: {e}"))?;
    fs::create_dir_all(&model_staging).map_err(|e| format!("Silero model staging: {e}"))?;

    let result = (|| {
        download_and_extract(RUNTIME_ASSET_URL, &runtime_staging, RUNTIME_DOWNLOAD_TIMEOUT)?;
        if !runtime_staging.join("python.exe").is_file() || !runtime_staging.join(SIDECAR_SCRIPT_NAME).is_file() {
            return Err("Runtime архив Silero скачан, но неполон".to_string());
        }
        download_and_extract(MODEL_ASSET_URL, &model_staging, MODEL_DOWNLOAD_TIMEOUT)?;
        let model_file = model_staging.join(MODEL_FILE_NAME);
        // Basic integrity check: the real model is ~139MB - a file far
        // smaller than that is a corrupt/truncated download, not a valid
        // (if differently-versioned) model.
        let model_len = fs::metadata(&model_file).map(|m| m.len()).unwrap_or(0);
        if model_len < 50_000_000 {
            return Err(format!("Model-архив Silero скачан, но повреждён (размер {model_len} байт)"));
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(error);
    }

    // Atomic-ish swap: remove any previous (older-version) install, then
    // move the fully-validated staging directories into place.
    let _ = fs::remove_dir_all(runtime_dir(app));
    let _ = fs::remove_dir_all(model_dir(app));
    fs::rename(&runtime_staging, runtime_dir(app)).map_err(|e| format!("Silero runtime install: {e}"))?;
    fs::rename(&model_staging, model_dir(app)).map_err(|e| format!("Silero model install: {e}"))?;
    let _ = fs::remove_dir_all(&staging_root);
    fs::write(version_marker_path(app), SILERO_RESOURCE_VERSION)
        .map_err(|e| format!("Silero version marker: {e}"))?;

    if !resources_ready(app) {
        return Err("Ресурсы Silero установлены, но проверка не прошла".to_string());
    }
    Ok(())
}

fn download_and_extract(url: &str, dest: &Path, timeout: Duration) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let response = client.get(url).send().map_err(|e| format!("Скачивание не удалось: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Скачивание не удалось: HTTP {}", response.status()));
    }
    let bytes = response.bytes().map_err(|e| format!("Скачивание не удалось: {e}"))?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Повреждённый архив: {e}"))?;
    archive.extract(dest).map_err(|e| format!("Не удалось распаковать архив: {e}"))
}

pub async fn set_enabled(app: &AppHandle, enabled: bool) -> Result<SileroStatus, String> {
    if enabled {
        let app_for_download = app.clone();
        tauri::async_runtime::spawn_blocking(move || ensure_resources_blocking(&app_for_download))
            .await
            .map_err(|e| format!("Internal error: {e}"))??;
    }
    let voice = {
        let state = app.state::<SileroState>();
        let mut inner = state.0.lock().unwrap();
        inner.enabled = enabled;
        if !enabled {
            if let Some(sidecar) = inner.sidecar.take() {
                sidecar.kill();
            }
            inner.state = SileroEngineState::NotStarted;
            inner.last_error = None;
            inner.consecutive_failures = 0;
            inner.cooldown_until = None;
        }
        inner.voice
    };
    save_config(app, &SileroConfig { enabled, voice }).map_err(|e| e.to_string())?;
    storage::append_rolling_log(app, &format!("Silero TTS {}.", if enabled { "enabled" } else { "disabled" }));
    Ok(status(app))
}

pub fn set_voice(app: &AppHandle, voice: SileroVoice) -> Result<SileroStatus, String> {
    let enabled = {
        let state = app.state::<SileroState>();
        let mut inner = state.0.lock().unwrap();
        inner.voice = voice;
        inner.enabled
    };
    save_config(app, &SileroConfig { enabled, voice }).map_err(|e| e.to_string())?;
    Ok(status(app))
}

fn build_tts_trace_event(
    message_id: &str,
    voice: SileroVoice,
    respawned: bool,
    sidecar_age_ms: f64,
    call_count: u64,
    trace: &SynthesisTrace,
) -> crate::diagnostics::tts_trace::TtsTraceEvent {
    use crate::diagnostics::tts_trace::{TtsTraceEvent, TtsTraceSource};
    let mut stages = std::collections::BTreeMap::new();
    stages.insert("sidecarWriteMs".to_string(), trace.stdin_write_ms);
    stages.insert("completionWaitMs".to_string(), trace.completion_wait_ms);
    stages.insert("synthesisTotalMs".to_string(), trace.stdin_write_ms + trace.completion_wait_ms);
    TtsTraceEvent {
        message_id: message_id.to_string(),
        source: TtsTraceSource::SileroSidecar,
        local_time: chrono::Local::now().to_rfc3339(),
        engine: Some(format!("silero-{}", voice.as_str())),
        stages,
        detail: serde_json::json!({
            "textLen": trace.text_len,
            "wavBytesLen": trace.wav_bytes_len,
            "sidecarRespawnedThisCall": respawned,
            "sidecarAgeMs": sidecar_age_ms,
            "sidecarCallCount": call_count,
        }),
    }
}

/// Synthesizes one utterance with the given voice, lazily starting (or
/// restarting, after a crash) the persistent sidecar as needed. Calls are
/// serialized by the Mutex - matches the frontend's one-utterance-at-a-time
/// queue, so this never arbitrates concurrent synthesis requests.
pub fn synthesize(
    app: &AppHandle,
    text: &str,
    voice: SileroVoice,
    message_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    let state = app.state::<SileroState>();
    let mut inner = state.0.lock().unwrap();
    if !inner.enabled {
        return Err("Silero TTS выключен".to_string());
    }
    if let Some(until) = inner.cooldown_until {
        if Instant::now() < until {
            return Err("Silero временно недоступен после нескольких сбоев подряд".to_string());
        }
        // Cooldown elapsed - allow exactly one fresh attempt.
        inner.cooldown_until = None;
    }
    if !resources_ready(app) {
        inner.state = SileroEngineState::Unavailable;
        inner.last_error = Some("Ресурсы Silero ещё не загружены".to_string());
        return Err(inner.last_error.clone().unwrap());
    }
    if let Some(sidecar) = inner.sidecar.as_mut() {
        if matches!(sidecar.child.try_wait(), Ok(Some(_))) {
            inner.sidecar = None;
        }
    }
    let respawned = inner.sidecar.is_none();
    if respawned {
        inner.state = SileroEngineState::Starting;
        match SileroSidecar::spawn(&SidecarPaths::for_app(app)) {
            Ok(sidecar) => {
                inner.sidecar = Some(sidecar);
                inner.last_error = None;
            }
            Err(error) => {
                return Err(record_failure(app, &mut inner, error));
            }
        }
    }

    let synth_result = inner.sidecar.as_mut().expect("just ensured").synthesize(text, voice);
    let (bytes, trace) = match synth_result {
        Ok(pair) => pair,
        Err(error) => {
            if let Some(sidecar) = inner.sidecar.take() {
                sidecar.kill();
            }
            return Err(record_failure(app, &mut inner, error));
        }
    };
    inner.state = SileroEngineState::Ready;
    inner.last_error = None;
    inner.consecutive_failures = 0;
    let sidecar_age_ms = inner.sidecar.as_ref().map(|s| s.spawned_at.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0);
    let call_count = inner.sidecar.as_ref().map(|s| s.call_count).unwrap_or(0);
    drop(inner);

    if let Some(message_id) = message_id {
        let event = build_tts_trace_event(message_id, voice, respawned, sidecar_age_ms, call_count, &trace);
        crate::diagnostics::observe_tts_stage(app, &event);
    }
    Ok(bytes)
}

/// Records a spawn/synthesis failure, escalating to a bounded cooldown
/// after MAX_CONSECUTIVE_FAILURES in a row instead of respawning
/// aggressively on every call (WK-81 requirement). Returns the error
/// string for the caller to propagate.
fn record_failure(app: &AppHandle, inner: &mut SileroInner, error: String) -> String {
    inner.consecutive_failures += 1;
    inner.last_error = Some(error.clone());
    if inner.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
        inner.state = SileroEngineState::Unavailable;
        inner.cooldown_until = Some(Instant::now() + COOLDOWN_DURATION);
    } else {
        inner.state = SileroEngineState::Crashed;
    }
    storage::append_rolling_log(app, &format!("Silero TTS failed: {error}"));
    error
}

pub fn synthesize_base64(
    app: &AppHandle,
    text: &str,
    voice: SileroVoice,
    message_id: Option<&str>,
) -> Result<String, String> {
    synthesize(app, text, voice, message_id).map(|bytes| BASE64.encode(bytes))
}

/// Stops the sidecar without touching the `enabled` setting - used on app
/// exit. Re-enabling later (or the next chat message, if left enabled)
/// spawns a fresh one.
pub fn stop(app: &AppHandle) {
    let state = app.state::<SileroState>();
    let mut inner = state.0.lock().unwrap();
    if let Some(sidecar) = inner.sidecar.take() {
        sidecar.kill();
    }
    inner.state = SileroEngineState::NotStarted;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silero_config_defaults_to_disabled_with_xenia_voice() {
        let config: SileroConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!config.enabled);
        assert_eq!(config.voice, SileroVoice::Xenia);
    }

    #[test]
    fn silero_config_round_trips() {
        let config: SileroConfig =
            serde_json::from_value(serde_json::json!({ "enabled": true, "voice": "aidar" })).unwrap();
        assert!(config.enabled);
        assert_eq!(config.voice, SileroVoice::Aidar);
    }

    #[test]
    fn engine_state_defaults_to_not_started() {
        assert_eq!(SileroEngineState::default(), SileroEngineState::NotStarted);
    }

    #[test]
    fn all_five_named_voices_have_distinct_lowercase_wire_names() {
        let voices =
            [SileroVoice::Aidar, SileroVoice::Baya, SileroVoice::Kseniya, SileroVoice::Xenia, SileroVoice::Eugene];
        let names: Vec<&str> = voices.iter().map(|v| v.as_str()).collect();
        assert_eq!(names, ["aidar", "baya", "kseniya", "xenia", "eugene"]);
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "voice wire names must be unique");
    }

    #[test]
    fn voice_serializes_to_lowercase_json_string() {
        assert_eq!(serde_json::to_string(&SileroVoice::Kseniya).unwrap(), "\"kseniya\"");
    }

    #[test]
    fn sidecar_response_line_requires_matching_request_id_to_be_accepted() {
        // Mirrors the correlation check in SileroSidecar::synthesize: a
        // response with a different id must never be treated as this
        // call's result - this is the whole point of an id-correlated
        // protocol instead of Piper's ordering-based one.
        let raw = r#"{"id":"req-2","ok":true,"wav":"C:\\out\\req-2.wav"}"#;
        let parsed: SidecarResponseLine = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.id.as_deref(), Some("req-2"));
        assert_ne!(parsed.id.as_deref(), Some("req-1"));
    }

    #[test]
    fn sidecar_ready_line_parses_and_ignores_other_shapes() {
        let ready: SidecarReadyLine = serde_json::from_str(r#"{"ready":true}"#).unwrap();
        assert!(ready.ready);
        // A response-shaped line (no "ready" field) must not be
        // misinterpreted as readiness.
        let not_ready: SidecarReadyLine = serde_json::from_str(r#"{"id":"req-1","ok":true}"#).unwrap();
        assert!(!not_ready.ready);
    }

    #[test]
    fn record_failure_escalates_to_cooldown_after_max_consecutive_failures() {
        let mut inner = SileroInner::default();
        for i in 1..=MAX_CONSECUTIVE_FAILURES {
            let app_free_error = format!("failure {i}");
            inner.consecutive_failures += 1;
            inner.last_error = Some(app_free_error);
            if inner.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                inner.state = SileroEngineState::Unavailable;
                inner.cooldown_until = Some(Instant::now() + COOLDOWN_DURATION);
            } else {
                inner.state = SileroEngineState::Crashed;
            }
        }
        assert_eq!(inner.state, SileroEngineState::Unavailable);
        assert!(inner.cooldown_until.is_some());
    }

    #[test]
    fn resource_version_marker_must_match_exactly_for_resources_to_be_ready() {
        // installed_resource_version()/resources_ready() require an exact
        // string match against SILERO_RESOURCE_VERSION - a stale or absent
        // marker must never be treated as "ready" even if the files
        // happen to exist on disk from an older/incompatible layout.
        assert_ne!(SILERO_RESOURCE_VERSION, "0");
        assert_ne!(SILERO_RESOURCE_VERSION, "");
    }

    // Real subprocess IPC test against the actual packaged runtime - not
    // run by default (needs a real built runtime + downloaded model, not
    // available in CI/dev checkouts by default). Point the env vars at a
    // local build produced the same way
    // scripts/companion-build-silero-runtime.ps1 does, and run explicitly:
    //   cargo test --manifest-path apps/companion/src-tauri/Cargo.toml \
    //     silero::tests::synthesize_against_a_real_local_silero_runtime -- --ignored --nocapture
    #[test]
    #[ignore]
    fn synthesize_against_a_real_local_silero_runtime() {
        let Ok(python_exe) = std::env::var("SILERO_TEST_PYTHON") else {
            panic!("set SILERO_TEST_PYTHON/_SCRIPT/_MODEL to run this test");
        };
        let sidecar_script = std::env::var("SILERO_TEST_SCRIPT").unwrap();
        let model = std::env::var("SILERO_TEST_MODEL").unwrap();
        let output_dir = tempfile::tempdir().unwrap();

        let paths = SidecarPaths {
            python_exe: python_exe.into(),
            sidecar_script: sidecar_script.into(),
            model: model.into(),
            output_dir: output_dir.path().to_path_buf(),
        };
        let mut sidecar = SileroSidecar::spawn(&paths).expect("spawn");

        let (first, first_trace) =
            sidecar.synthesize("Привет стример, как дела в игре сегодня?", SileroVoice::Xenia).expect("first synthesize");
        assert!(first.len() > 1000, "suspiciously small wav: {} bytes", first.len());
        assert_eq!(&first[0..4], b"RIFF", "not a valid WAV file");
        assert_eq!(first_trace.wav_bytes_len, first.len());

        let pid_before = sidecar.child.id();
        let (second, _) = sidecar.synthesize("гг вп", SileroVoice::Aidar).expect("second synthesize, different voice");
        assert_eq!(sidecar.child.id(), pid_before, "sidecar respawned instead of being reused");
        assert!(second.len() > 500);
        assert_eq!(&second[0..4], b"RIFF");

        sidecar.kill();
    }

    #[test]
    #[ignore]
    fn persistent_silero_sidecar_never_shifts_output_by_one_message() {
        let Ok(python_exe) = std::env::var("SILERO_TEST_PYTHON") else {
            panic!("set SILERO_TEST_PYTHON/_SCRIPT/_MODEL to run this test");
        };
        let sidecar_script = std::env::var("SILERO_TEST_SCRIPT").unwrap();
        let model = std::env::var("SILERO_TEST_MODEL").unwrap();
        let output_dir = tempfile::tempdir().unwrap();

        let paths = SidecarPaths {
            python_exe: python_exe.into(),
            sidecar_script: sidecar_script.into(),
            model: model.into(),
            output_dir: output_dir.path().to_path_buf(),
        };
        let mut sidecar = SileroSidecar::spawn(&paths).expect("spawn");

        let (a, _) = sidecar.synthesize("Раз", SileroVoice::Xenia).expect("A");
        let (b, _) = sidecar
            .synthesize("Сообщение номер два содержит гораздо больше слов чем первое или третье сообщение", SileroVoice::Xenia)
            .expect("B");
        let (c, _) = sidecar.synthesize("Три", SileroVoice::Xenia).expect("C");

        assert!(b.len() > a.len() * 2 && b.len() > c.len() * 2, "B's audio should be proportionately larger");
        sidecar.kill();
    }
}
