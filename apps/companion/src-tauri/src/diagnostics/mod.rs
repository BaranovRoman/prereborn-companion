// Diagnostic-mode GSI capture. This module is a passive observer that sits
// beside the regular GSI pipeline (server/mod.rs -> storage.rs / backend/mod.rs)
// - it never changes what those modules do, never touches the GSI config,
// and is entirely disabled (zero disk writes, one cheap mutex-lock-and-check
// per GSI tick) unless a session has been explicitly started from the UI.
//
// Goal: after a couple of normal matches, be able to answer "what does Dota
// actually send, when, and which of it do we ignore" without hand-reading
// dozens of raw JSON files - see `export::export_zip` for the produced
// bundle and its README.txt for what's inside.
//
// Note on catalog persistence: the field catalog (catalog.rs) only ever
// lives in memory for the current Companion process - it is not currently
// reloaded from disk after a restart. If Companion is closed mid-session,
// the raw snapshots/timeline/diffs already written to disk survive, but the
// derived catalog would have to be rebuilt from those files by hand; export
// is only wired up for the active-or-most-recently-stopped session of the
// current run.

pub mod analysis;
pub mod catalog;
pub mod diff;
pub mod export;
pub mod redact;
pub mod session;
pub mod timeline;
pub mod tts_trace;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use chrono::Local;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::COMPANION_VERSION;
use crate::storage;
use session::DiagnosticSession;
use tts_trace::TtsTraceEvent;

static SESSION_SEQ: AtomicU32 = AtomicU32::new(0);

pub struct DiagnosticsState(pub Mutex<DiagnosticsInner>);

#[derive(Default)]
pub struct DiagnosticsInner {
    pub session: Option<DiagnosticSession>,
}

impl DiagnosticsState {
    pub fn new() -> Self {
        DiagnosticsState(Mutex::new(DiagnosticsInner::default()))
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiagnosticsStatusSnapshot {
    pub active: bool,
    pub has_session: bool,
    pub session_id: Option<String>,
    pub started_at: Option<String>,
    pub request_count: u64,
    pub snapshot_count: u64,
    pub error_count: u64,
    pub observed_game_states: Vec<String>,
    pub observed_match_ids: Vec<String>,
    pub bytes_written: u64,
    pub size_limit_bytes: u64,
    pub size_limit_reached: bool,
    pub tts_trace_count: u64,
}

fn snapshot_of(session: &DiagnosticSession) -> DiagnosticsStatusSnapshot {
    DiagnosticsStatusSnapshot {
        active: !session.finalized,
        has_session: true,
        session_id: Some(session.session_id.clone()),
        started_at: Some(session.started_at.to_rfc3339()),
        request_count: session.request_count,
        snapshot_count: session.snapshot_count,
        error_count: session.error_count,
        observed_game_states: session.observed_game_states.iter().cloned().collect(),
        observed_match_ids: session.observed_match_ids.iter().cloned().collect(),
        bytes_written: session.bytes_written,
        size_limit_bytes: session::SIZE_LIMIT_BYTES,
        size_limit_reached: session.size_limit_reached,
        tts_trace_count: session.tts_trace_count,
    }
}

fn diagnostics_root(app: &AppHandle) -> PathBuf {
    storage::logs_root(app).join("diagnostics")
}

pub fn status(app: &AppHandle) -> DiagnosticsStatusSnapshot {
    let state = app.state::<DiagnosticsState>();
    let inner = state.0.lock().unwrap();
    match &inner.session {
        Some(session) => snapshot_of(session),
        None => DiagnosticsStatusSnapshot {
            size_limit_bytes: session::SIZE_LIMIT_BYTES,
            ..Default::default()
        },
    }
}

/// Called once at startup (lib.rs::run().setup()). If the previous
/// Companion process was still recording a diagnostics session when it
/// exited (crash, force-quit, OS shutdown - anything that skipped the
/// "Остановить диагностику" button), this makes that session exportable
/// again instead of losing it. Never resumes live recording into it - see
/// `DiagnosticSession::load_from_disk`. Best-effort: failures are logged,
/// never fatal to startup.
pub fn recover_last_session(app: &AppHandle) {
    let root = diagnostics_root(app);
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    let mut dirs: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    // Session directory names embed a sortable timestamp (diag_<ts>_<seq>),
    // so lexicographic order is chronological order.
    dirs.sort();
    let Some(latest) = dirs.into_iter().last() else { return };

    match session::DiagnosticSession::load_from_disk(latest) {
        Ok(Some(recovered)) => {
            let session_id = recovered.session_id.clone();
            let request_count = recovered.request_count;
            let state = app.state::<DiagnosticsState>();
            let mut inner = state.0.lock().unwrap();
            inner.session = Some(recovered);
            drop(inner);
            storage::append_rolling_log(
                app,
                &format!("Diagnostics: recovered session {session_id} from a previous run for export (requests={request_count})"),
            );
        }
        Ok(None) => {}
        Err(e) => storage::append_rolling_log(app, &format!("Diagnostics: failed to recover previous session (non-fatal): {e}")),
    }
}

/// Called once per GSI HTTP request (server/mod.rs), before/independent of
/// normal validation and backend forwarding. No-op (one lock + one `is_none`
/// check) whenever diagnostics isn't running, so this never touches the
/// regular-user path in practice.
pub fn observe(app: &AppHandle, parsed: Option<&Value>, raw_len: usize) {
    let state = app.state::<DiagnosticsState>();
    let mut inner = state.0.lock().unwrap();
    let Some(session) = inner.session.as_mut() else { return };
    if session.finalized {
        return;
    }
    if let Some(err) = session.record_tick(parsed, raw_len, Local::now()) {
        storage::append_rolling_log(app, &format!("Diagnostics write error (non-fatal): {err}"));
    }
}

/// Called from the TTS pipeline (tts.rs's synthesize(), and the
/// `diagnostics_trace_tts_frontend` command for frontend-owned stages).
/// Same no-op-unless-a-session-is-active shape as `observe()` above - a
/// diagnostics session captures both GSI and TTS trace data together, so
/// there is only one Start/Stop/Export flow for the user to operate.
pub fn observe_tts_stage(app: &AppHandle, event: &TtsTraceEvent) {
    let state = app.state::<DiagnosticsState>();
    let mut inner = state.0.lock().unwrap();
    let Some(session) = inner.session.as_mut() else { return };
    if session.finalized {
        return;
    }
    if let Some(err) = session.record_tts_trace(event) {
        storage::append_rolling_log(app, &format!("Diagnostics TTS trace write error (non-fatal): {err}"));
    }
}

pub fn start(app: &AppHandle) -> Result<DiagnosticsStatusSnapshot, String> {
    let state = app.state::<DiagnosticsState>();
    {
        let inner = state.0.lock().unwrap();
        if let Some(session) = &inner.session {
            if !session.finalized {
                return Err("Диагностика уже запущена.".to_string());
            }
        }
    }

    let now = Local::now();
    let seq = SESSION_SEQ.fetch_add(1, Ordering::SeqCst);
    let session_id = format!("diag_{}_{seq:04}", now.format("%Y%m%dT%H%M%S"));
    let dir = diagnostics_root(app).join(&session_id);

    let mut session = DiagnosticSession::new(dir, session_id.clone(), now)
        .map_err(|e| format!("Could not create diagnostics session directory: {e}"))?;
    // Forced (not debounced) initial write, so session-state.json exists
    // for recovery even if Companion crashes before the first GSI tick.
    if let Some(err) = session.flush_meta(now) {
        storage::append_rolling_log(app, &format!("Diagnostics initial meta write error (non-fatal): {err}"));
    }

    {
        let mut inner = state.0.lock().unwrap();
        inner.session = Some(session);
    }

    storage::append_rolling_log(app, &format!("Diagnostics session started: {session_id}"));
    spawn_idle_watchdog(app.clone(), session_id);

    Ok(status(app))
}

pub fn stop(app: &AppHandle) -> Result<DiagnosticsStatusSnapshot, String> {
    let state = app.state::<DiagnosticsState>();
    let mut inner = state.0.lock().unwrap();
    let Some(session) = inner.session.as_mut() else {
        return Err("Нет активной диагностической сессии.".to_string());
    };
    if !session.finalized {
        if let Some(err) = session.finalize_shutdown(Local::now()) {
            storage::append_rolling_log(app, &format!("Diagnostics shutdown write error (non-fatal): {err}"));
        }
        storage::append_rolling_log(
            app,
            &format!(
                "Diagnostics session stopped: {} (requests={}, snapshots={})",
                session.session_id, session.request_count, session.snapshot_count
            ),
        );
    }
    drop(inner);
    Ok(status(app))
}

pub fn clear(app: &AppHandle) -> Result<DiagnosticsStatusSnapshot, String> {
    {
        let state = app.state::<DiagnosticsState>();
        let inner = state.0.lock().unwrap();
        if let Some(session) = &inner.session {
            if !session.finalized {
                return Err("Сначала остановите диагностику, потом очищайте логи.".to_string());
            }
        }
    }

    let root = diagnostics_root(app);
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("Could not clear diagnostics directory: {e}"))?;
    }

    {
        let state = app.state::<DiagnosticsState>();
        let mut inner = state.0.lock().unwrap();
        inner.session = None;
    }

    storage::append_rolling_log(app, "Diagnostics logs cleared by user.");
    Ok(status(app))
}

/// `output_path` is chosen by the caller (a save-file dialog in commands.rs)
/// - kept out of this function so the export logic itself stays testable
/// without a real Tauri dialog.
pub fn export(app: &AppHandle, output_path: PathBuf) -> Result<String, String> {
    let state = app.state::<DiagnosticsState>();
    let inner = state.0.lock().unwrap();
    let Some(session) = &inner.session else {
        return Err("Нет диагностических данных для экспорта — сначала запустите диагностику.".to_string());
    };

    let generated_at = Local::now().to_rfc3339();
    let fields: Vec<&catalog::FieldInfo> = session.catalog.fields.values().collect();
    let manifest = export::Manifest {
        companion_version: COMPANION_VERSION.to_string(),
        diagnostics_schema_version: export::SCHEMA_VERSION.to_string(),
        session_id: session.session_id.clone(),
        started_at: session.started_at.to_rfc3339(),
        ended_at: session.finalized.then(|| generated_at.clone()),
        gsi_request_count: session.request_count,
        snapshot_count: session.snapshot_count,
        error_count: session.error_count,
        observed_game_states: session.observed_game_states.iter().cloned().collect(),
        observed_match_ids: session.observed_match_ids.iter().cloned().collect(),
        os: std::env::consts::OS.to_string(),
        size_bytes_used: session.bytes_written,
        size_limit_bytes: session::SIZE_LIMIT_BYTES,
        size_limit_reached: session.size_limit_reached,
    };

    export::export_zip(&session.dir, &fields, &manifest, &generated_at, &output_path)?;
    drop(inner);

    storage::append_rolling_log(
        app,
        &format!(
            "Diagnostics exported to {}",
            output_path.file_name().and_then(|n| n.to_str()).unwrap_or("gsi-diagnostics.zip")
        ),
    );
    Ok(output_path.to_string_lossy().to_string())
}

const WATCHDOG_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Detects "GSI stopped sending requests" (Dota closed, PC slept, etc.)
/// while a session is active, so the final known state still gets a
/// `shutdown` snapshot instead of silently trailing off. Self-terminates as
/// soon as the session it was spawned for is no longer the active one.
fn spawn_idle_watchdog(app: AppHandle, session_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCHDOG_POLL_INTERVAL);
        let state = app.state::<DiagnosticsState>();
        let mut inner = state.0.lock().unwrap();
        let Some(session) = inner.session.as_mut() else { return };
        if session.session_id != session_id {
            return;
        }
        if session.finalized {
            return;
        }
        if session.check_idle(Local::now()) {
            let request_count = session.request_count;
            drop(inner);
            storage::append_rolling_log(
                &app,
                &format!("Diagnostics: no GSI requests for a while, session {session_id} auto-finalized (requests={request_count})"),
            );
            return;
        }
    });
}
