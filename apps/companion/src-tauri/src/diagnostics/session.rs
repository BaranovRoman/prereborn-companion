use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::{FieldCatalog, FieldInfo};
use super::diff::{diff_values, ChangeKind, DiffEntry};
use super::redact::redact;
use super::timeline::{extract_summary, format_changes, is_low_value_path, Reason, TimelineEntry, SIGNIFICANT_PATHS};
use super::tts_trace::TtsTraceEvent;

/// Suggested by the brief as "100-200MB"; picked the middle so there's
/// headroom before the hard stop kicks in mid-match.
pub const SIZE_LIMIT_BYTES: u64 = 150 * 1024 * 1024;
/// Snapshots triggered by nothing else are rate-limited to this cadence.
pub const PERIODIC_INTERVAL_SECS: i64 = 30;
/// Dota's GSI heartbeat is configured at 30s (see gsi/config.rs) - 3 missed
/// heartbeats in a row is a reasonable "GSI has gone quiet" signal without
/// being trigger-happy on a single dropped request.
pub const IDLE_SHUTDOWN_SECS: i64 = 90;
/// How often `catalog.json` / `session-state.json` get rewritten to disk -
/// debounced rather than on every tick (per the brief: "не обязательно после
/// каждого GSI-запроса"), but frequently enough that a crash loses at most a
/// few seconds of bookkeeping. These two files are what makes a session
/// recoverable/exportable after a Companion restart - see `load_from_disk`.
pub const META_FLUSH_INTERVAL_SECS: i64 = 7;

/// Everything needed to recover/export a session after a restart, minus the
/// live-recording bookkeeping (`last_payload` etc.) which only matters while
/// the process that started the session is still running.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStateFile {
    session_id: String,
    started_at: String,
    last_tick_at: String,
    request_count: u64,
    snapshot_count: u64,
    error_count: u64,
    bytes_written: u64,
    size_limit_reached: bool,
    observed_game_states: Vec<String>,
    observed_match_ids: Vec<String>,
    finalized: bool,
    #[serde(default)]
    tts_trace_count: u64,
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> std::io::Result<u64> {
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(path, &bytes)?;
    Ok(bytes.len() as u64)
}

fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> std::io::Result<u64> {
    let mut line = serde_json::to_vec(value)?;
    line.push(b'\n');
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&line)?;
    Ok(line.len() as u64)
}

pub struct DiagnosticSession {
    pub session_id: String,
    pub dir: PathBuf,
    pub started_at: DateTime<Local>,
    pub last_tick_at: DateTime<Local>,
    pub request_count: u64,
    pub snapshot_count: u64,
    pub error_count: u64,
    pub bytes_written: u64,
    pub size_limit_reached: bool,
    pub observed_game_states: std::collections::BTreeSet<String>,
    pub observed_match_ids: std::collections::BTreeSet<String>,
    pub catalog: FieldCatalog,
    pub finalized: bool,
    pub tts_trace_count: u64,
    last_payload: Option<Value>,
    last_snapshot_payload: Option<Value>,
    last_snapshot_at: Option<DateTime<Local>>,
    last_meta_flush_at: Option<DateTime<Local>>,
}

impl DiagnosticSession {
    pub fn new(dir: PathBuf, session_id: String, started_at: DateTime<Local>) -> std::io::Result<Self> {
        fs::create_dir_all(dir.join("snapshots"))?;
        fs::create_dir_all(dir.join("diffs"))?;
        Ok(DiagnosticSession {
            session_id,
            dir,
            started_at,
            last_tick_at: started_at,
            request_count: 0,
            snapshot_count: 0,
            error_count: 0,
            bytes_written: 0,
            size_limit_reached: false,
            observed_game_states: Default::default(),
            observed_match_ids: Default::default(),
            catalog: FieldCatalog::new(),
            finalized: false,
            tts_trace_count: 0,
            last_payload: None,
            last_snapshot_payload: None,
            last_snapshot_at: None,
            last_meta_flush_at: None,
        })
    }

    /// Rebuilds a session from its debounced-persisted `session-state.json` +
    /// `catalog.json` (see `flush_meta`) - the recovery path for "Companion
    /// restarted while a diagnostics session was running". Returns `Ok(None)`
    /// if `dir` has no `session-state.json` yet (nothing worth recovering -
    /// e.g. the session was started and crashed before the first flush).
    /// The recovered session is always `finalized: true` - Companion never
    /// silently resumes live recording into a session from a previous
    /// process, it only becomes exportable again.
    pub fn load_from_disk(dir: PathBuf) -> Result<Option<Self>, String> {
        let state_path = dir.join("session-state.json");
        if !state_path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&state_path).map_err(|e| format!("reading session-state.json: {e}"))?;
        let state: SessionStateFile =
            serde_json::from_str(&raw).map_err(|e| format!("parsing session-state.json: {e}"))?;

        let started_at = DateTime::parse_from_rfc3339(&state.started_at)
            .map(|d| d.with_timezone(&Local))
            .map_err(|e| format!("bad started_at in session-state.json: {e}"))?;
        let last_tick_at = DateTime::parse_from_rfc3339(&state.last_tick_at)
            .map(|d| d.with_timezone(&Local))
            .unwrap_or(started_at);

        let catalog = fs::read_to_string(dir.join("catalog.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<FieldInfo>>(&raw).ok())
            .map(FieldCatalog::from_field_list)
            .unwrap_or_default();

        Ok(Some(DiagnosticSession {
            session_id: state.session_id,
            dir,
            started_at,
            last_tick_at,
            request_count: state.request_count,
            snapshot_count: state.snapshot_count,
            error_count: state.error_count,
            bytes_written: state.bytes_written,
            size_limit_reached: state.size_limit_reached,
            observed_game_states: state.observed_game_states.into_iter().collect(),
            observed_match_ids: state.observed_match_ids.into_iter().collect(),
            catalog,
            finalized: true,
            tts_trace_count: state.tts_trace_count,
            last_payload: None,
            last_snapshot_payload: None,
            last_snapshot_at: None,
            last_meta_flush_at: None,
        }))
    }

    fn timeline_path(&self) -> PathBuf {
        self.dir.join("timeline.jsonl")
    }

    fn errors_path(&self) -> PathBuf {
        self.dir.join("errors.jsonl")
    }

    fn tts_trace_path(&self) -> PathBuf {
        self.dir.join("tts-trace.jsonl")
    }

    /// Appends one TTS trace record (see tts_trace.rs). Not gated by
    /// `size_limit_reached` - like timeline.jsonl/errors.jsonl, these are a
    /// tiny fraction of a session's byte budget and stay useful even after
    /// full GSI snapshots have stopped. Still counted into `bytes_written`
    /// for an honest total, and a no-op once the session is finalized (the
    /// caller in mod.rs already checks this, but this method double-checks
    /// so it's never wrong to call directly, e.g. from a test).
    pub fn record_tts_trace(&mut self, event: &TtsTraceEvent) -> Option<String> {
        if self.finalized {
            return None;
        }
        match append_jsonl(&self.tts_trace_path(), event) {
            Ok(bytes) => {
                self.bytes_written += bytes;
                self.tts_trace_count += 1;
                None
            }
            Err(e) => Some(format!("tts-trace.jsonl: {e}")),
        }
    }

    /// Errors writing diagnostic files are swallowed into this session's own
    /// bookkeeping (never surfaced as a hard failure) - a diagnostics disk
    /// error must never interrupt GSI receipt/forwarding. Callers may log the
    /// returned message via the app's rolling log if they want visibility.
    pub fn record_tick(&mut self, parsed: Option<&Value>, raw_len: usize, now: DateTime<Local>) -> Option<String> {
        self.request_count += 1;
        self.last_tick_at = now;

        let error = match parsed {
            None => self.record_request_error(now, raw_len, "raw body was not valid JSON"),
            Some(value) if !value.is_object() => self.record_request_error(now, raw_len, "JSON body was not an object"),
            Some(value) => self.record_payload(value, now),
        };

        // Debounced regardless of which branch above ran, so a session that
        // only ever sees malformed bodies still gets its counters persisted.
        error.or_else(|| self.maybe_flush_meta(now))
    }

    fn record_payload(&mut self, value: &Value, now: DateTime<Local>) -> Option<String> {
        let redacted = redact(value);
        let summary = extract_summary(&redacted);
        if let Some(gs) = &summary.game_state {
            self.observed_game_states.insert(gs.clone());
        }
        if let Some(mid) = &summary.match_id {
            self.observed_match_ids.insert(mid.clone());
        }

        let is_first = self.last_payload.is_none();
        // Filtered to drop clock-like fields (map.clock_time/game_time) that
        // change almost every tick and would otherwise both trigger spurious
        // snapshots and flood every other entry's human-readable change list
        // - see timeline::LOW_VALUE_PATHS. The raw snapshot files and the
        // diffs/*.json between two saved snapshots stay fully unfiltered.
        let filtered_diff: Vec<DiffEntry> = match &self.last_payload {
            Some(prev) => diff_values(prev, &redacted).into_iter().filter(|e| !is_low_value_path(&e.path)).collect(),
            None => Vec::new(),
        };

        self.catalog.observe(&redacted, summary.game_state.as_deref());

        let reason = if is_first {
            Some(Reason::Initial)
        } else {
            classify(&filtered_diff, self.last_snapshot_at, now)
        };

        self.last_payload = Some(redacted.clone());

        let mut error: Option<String> = None;
        if let Some(reason) = reason {
            if let Err(e) = self.commit_snapshot(reason, &redacted, &filtered_diff, now) {
                error = Some(e);
            }
        }
        error
    }

    fn record_request_error(&mut self, now: DateTime<Local>, raw_len: usize, message: &str) -> Option<String> {
        self.error_count += 1;
        let record = serde_json::json!({
            "local_time": now.to_rfc3339(),
            "elapsed_seconds": (now - self.started_at).num_milliseconds() as f64 / 1000.0,
            "message": message,
            "raw_body_bytes": raw_len,
        });
        let write_err = append_jsonl(&self.errors_path(), &record).err();
        if let Some(e) = &write_err {
            return Some(format!("failed to write errors.jsonl: {e}"));
        }
        self.bytes_written += serde_json::to_vec(&record).map(|v| v.len() as u64).unwrap_or(0);

        let summary = self
            .last_payload
            .as_ref()
            .map(extract_summary)
            .unwrap_or_default();
        let entry = TimelineEntry {
            local_time: now.to_rfc3339(),
            elapsed_seconds: (now - self.started_at).num_milliseconds() as f64 / 1000.0,
            reason: Reason::RequestError,
            summary,
            changes: vec![message.to_string()],
        };
        append_jsonl(&self.timeline_path(), &entry).err().map(|e| format!("failed to write timeline.jsonl: {e}"))
    }

    fn commit_snapshot(
        &mut self,
        reason: Reason,
        redacted_payload: &Value,
        tick_diff: &[DiffEntry],
        now: DateTime<Local>,
    ) -> Result<(), String> {
        self.snapshot_count += 1;
        let seq = self.snapshot_count;

        let entry = TimelineEntry {
            local_time: now.to_rfc3339(),
            elapsed_seconds: (now - self.started_at).num_milliseconds() as f64 / 1000.0,
            reason,
            summary: extract_summary(redacted_payload),
            changes: format_changes(tick_diff),
        };
        let timeline_bytes = append_jsonl(&self.timeline_path(), &entry).map_err(|e| format!("timeline.jsonl: {e}"))?;
        self.bytes_written += timeline_bytes;

        if !self.size_limit_reached {
            let reason_tag = serde_json::to_value(reason)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            let snapshot_name = format!("{seq:04}-{reason_tag}.json");
            let snapshot_path = self.dir.join("snapshots").join(&snapshot_name);
            let snapshot_bytes = write_json_file(&snapshot_path, redacted_payload)
                .map_err(|e| format!("snapshot write failed: {e}"))?;
            self.bytes_written += snapshot_bytes;

            if let Some(prev_snapshot) = &self.last_snapshot_payload {
                // Unfiltered (unlike the `tick_diff` param above) - this is
                // meant to be a complete technical record between two saved
                // snapshots, not a human-curated summary.
                let snap_diff = diff_values(prev_snapshot, redacted_payload);
                let diff_path = self.dir.join("diffs").join(format!("{seq:04}.json"));
                let diff_bytes = write_json_file(&diff_path, &snap_diff).map_err(|e| format!("diff write failed: {e}"))?;
                self.bytes_written += diff_bytes;
            }

            if self.bytes_written >= SIZE_LIMIT_BYTES {
                self.size_limit_reached = true;
            }
        }

        self.last_snapshot_payload = Some(redacted_payload.clone());
        self.last_snapshot_at = Some(now);
        Ok(())
    }

    fn write_catalog_file(&self) -> Result<(), String> {
        let fields: Vec<_> = self.catalog.fields.values().collect();
        write_json_file(&self.dir.join("catalog.json"), &fields)
            .map(|_| ())
            .map_err(|e| format!("catalog.json write failed: {e}"))
    }

    /// Rewrites `session-state.json` and `catalog.json` unconditionally -
    /// this is what makes a session recoverable via `load_from_disk` after a
    /// Companion restart. Not counted against `bytes_written` (the
    /// user-facing session size budget is about captured GSI data, not this
    /// small bookkeeping). Called on a debounce from `record_tick` and
    /// unconditionally from `finalize_shutdown` / right after a session is
    /// created.
    pub fn flush_meta(&mut self, now: DateTime<Local>) -> Option<String> {
        let state_file = SessionStateFile {
            session_id: self.session_id.clone(),
            started_at: self.started_at.to_rfc3339(),
            last_tick_at: self.last_tick_at.to_rfc3339(),
            request_count: self.request_count,
            snapshot_count: self.snapshot_count,
            error_count: self.error_count,
            bytes_written: self.bytes_written,
            size_limit_reached: self.size_limit_reached,
            observed_game_states: self.observed_game_states.iter().cloned().collect(),
            observed_match_ids: self.observed_match_ids.iter().cloned().collect(),
            finalized: self.finalized,
            tts_trace_count: self.tts_trace_count,
        };
        let state_err = write_json_file(&self.dir.join("session-state.json"), &state_file)
            .err()
            .map(|e| format!("session-state.json write failed: {e}"));
        let catalog_err = self.write_catalog_file().err();
        self.last_meta_flush_at = Some(now);
        state_err.or(catalog_err)
    }

    fn maybe_flush_meta(&mut self, now: DateTime<Local>) -> Option<String> {
        let due = match self.last_meta_flush_at {
            None => true,
            Some(last) => (now - last).num_seconds() >= META_FLUSH_INTERVAL_SECS,
        };
        if due {
            self.flush_meta(now)
        } else {
            None
        }
    }

    /// Called on explicit "stop" and by the idle watchdog. Idempotent -
    /// a session only ever gets one `shutdown` entry. Always force-flushes
    /// meta afterwards (not debounced) per the brief's "обязательная запись
    /// при остановке диагностики".
    pub fn finalize_shutdown(&mut self, now: DateTime<Local>) -> Option<String> {
        if self.finalized {
            return None;
        }
        self.finalized = true;

        let mut error = None;
        if let Some(last) = self.last_payload.clone() {
            let diff: Vec<DiffEntry> = self
                .last_snapshot_payload
                .as_ref()
                .map(|prev| diff_values(prev, &last))
                .unwrap_or_default()
                .into_iter()
                .filter(|e| !is_low_value_path(&e.path))
                .collect();
            error = self.commit_snapshot(Reason::Shutdown, &last, &diff, now).err();
        }
        error.or_else(|| self.flush_meta(now))
    }

    /// Polled by a background thread; returns true if it just finalized the
    /// session due to GSI going quiet (no request for IDLE_SHUTDOWN_SECS).
    pub fn check_idle(&mut self, now: DateTime<Local>) -> bool {
        if self.finalized || self.last_payload.is_none() {
            return false;
        }
        if (now - self.last_tick_at).num_seconds() >= IDLE_SHUTDOWN_SECS {
            self.finalize_shutdown(now);
            true
        } else {
            false
        }
    }
}

/// Priority order matches the brief's reason list; the first applicable one
/// wins so a tick with multiple simultaneous changes gets one clear label
/// (the full change list still goes into the timeline entry regardless).
fn classify(tick_diff: &[DiffEntry], last_snapshot_at: Option<DateTime<Local>>, now: DateTime<Local>) -> Option<Reason> {
    let game_state_changed = tick_diff.iter().any(|e| e.path == "$.map.game_state");
    if game_state_changed {
        return Some(Reason::GameStateChanged);
    }
    if tick_diff.iter().any(|e| e.kind == ChangeKind::TypeChanged) {
        return Some(Reason::FieldTypeChanged);
    }
    if tick_diff.iter().any(|e| e.kind == ChangeKind::Removed) {
        return Some(Reason::FieldRemoved);
    }
    if tick_diff.iter().any(|e| e.kind == ChangeKind::Added) {
        return Some(Reason::FieldAdded);
    }
    // draft.*/abilities.*/items.* aren't in SIGNIFICANT_PATHS (their
    // sub-field names - ability0..abilityN, slot0..slotN, whatever draft.*
    // actually contains - are unknown until a real session captures them,
    // so nothing is hardcoded here) - a prefix match instead, so any value
    // change under any of the three sections gets its own snapshot
    // immediately rather than waiting for the next periodic checkpoint.
    // This is specifically for WK-diagnostics field-timing resolution: the
    // generic diff already records every changed field regardless, this
    // only controls how promptly it's captured. If abilities.*/items.*
    // cooldown/charges turn out to be a live per-tick countdown this can
    // snapshot every tick during any cooldown - accepted, the existing
    // SIZE_LIMIT_BYTES cap already degrades gracefully (stops full
    // snapshots, keeps timeline/catalog) for exactly this kind of case.
    //
    // WK-106 follow-up - items.* was missing from this prefix list even
    // though abilities.* was already covered: an item-only change (e.g.
    // using a Tango) had no significant-path trigger of its own and would
    // silently fall through to whatever the next periodic (30s) snapshot
    // happened to catch, unlike an ability cast. Needed for WK-106's
    // production verification - the new Custom Game Sounds feature detects
    // item.used the same way it detects ability.cast (see
    // game_sounds::events::detect_item_events), and a tester needs the raw
    // GSI transition captured promptly enough to actually correlate with a
    // detected event.
    //
    // WK-138 - couriers.* added for the same reason, now that
    // gsi/config.rs's GSI_DATA_SECTIONS actually subscribes to it: the next
    // real reproduction of a courier-mediated item transition needs this
    // section's actual shape captured promptly (it is not parsed by the
    // detector yet - see game_sounds::events's WK-138 doc comment - and its
    // real field layout is currently unconfirmed).
    let significant_changed = tick_diff.iter().any(|e| {
        e.kind == ChangeKind::ValueChanged
            && (SIGNIFICANT_PATHS.iter().any(|p| e.path == format!("$.{p}"))
                || e.path.starts_with("$.draft")
                || e.path.starts_with("$.abilities")
                || e.path.starts_with("$.items")
                || e.path.starts_with("$.couriers"))
    });
    if significant_changed {
        return Some(Reason::SignificantValueChanged);
    }
    let periodic_due = match last_snapshot_at {
        None => true,
        Some(last) => (now - last).num_seconds() >= PERIODIC_INTERVAL_SECS,
    };
    if periodic_due {
        return Some(Reason::PeriodicSnapshot);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use serde_json::json;
    use tempfile::tempdir;

    fn new_session() -> (tempfile::TempDir, DiagnosticSession) {
        let dir = tempdir().unwrap();
        let started = Local::now();
        let session = DiagnosticSession::new(dir.path().join("s1"), "s1".into(), started).unwrap();
        (dir, session)
    }

    #[test]
    fn first_tick_is_initial_and_writes_snapshot_with_no_diff_file() {
        let (_guard, mut session) = new_session();
        let now = session.started_at;
        let payload = json!({ "map": { "game_state": "MENU" } });
        session.record_tick(Some(&payload), 10, now);
        assert_eq!(session.snapshot_count, 1);
        let snapshots = fs::read_dir(session.dir.join("snapshots")).unwrap().count();
        assert_eq!(snapshots, 1);
        let diffs = fs::read_dir(session.dir.join("diffs")).unwrap().count();
        assert_eq!(diffs, 0);
    }

    #[test]
    fn game_state_change_triggers_snapshot_and_diff() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0);
        let t1 = t0 + Duration::seconds(1);
        session.record_tick(Some(&json!({ "map": { "game_state": "HERO_SELECTION" } })), 10, t1);
        assert_eq!(session.snapshot_count, 2);
        assert_eq!(fs::read_dir(session.dir.join("diffs")).unwrap().count(), 1);
        assert!(session.observed_game_states.contains("MENU"));
        assert!(session.observed_game_states.contains("HERO_SELECTION"));
    }

    #[test]
    fn unchanged_ticks_do_not_snapshot_until_periodic_interval_elapses() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        let payload = json!({ "map": { "game_state": "MENU" } });
        session.record_tick(Some(&payload), 10, t0);
        assert_eq!(session.snapshot_count, 1);

        // 5s later, identical payload - no new trigger yet.
        session.record_tick(Some(&payload), 10, t0 + Duration::seconds(5));
        assert_eq!(session.snapshot_count, 1);

        // 31s after the first snapshot - periodic trigger fires.
        session.record_tick(Some(&payload), 10, t0 + Duration::seconds(31));
        assert_eq!(session.snapshot_count, 2);
    }

    // WK-106 follow-up - items.* used to be absent from classify()'s
    // significant-path prefix list (unlike abilities.*/draft.*, see the
    // comment on `significant_changed` above) - an item-only change had to
    // wait up to PERIODIC_INTERVAL_SECS (30s) to be captured at all, long
    // after the moment a real item use actually happened. This pins the fix:
    // an items.* value change gets its own snapshot immediately, the same
    // way an abilities.* change already did.
    #[test]
    fn item_only_change_triggers_an_immediate_snapshot_like_abilities_already_did() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(
            Some(&json!({ "items": { "slot0": { "name": "item_tango", "charges": 2 } } })),
            10,
            t0,
        );
        assert_eq!(session.snapshot_count, 1);

        // 1s later - well within PERIODIC_INTERVAL_SECS - only `items`
        // changed (a Tango charge was consumed).
        session.record_tick(
            Some(&json!({ "items": { "slot0": { "name": "item_tango", "charges": 1 } } })),
            10,
            t0 + Duration::seconds(1),
        );
        assert_eq!(session.snapshot_count, 2);
        assert_eq!(fs::read_dir(session.dir.join("diffs")).unwrap().count(), 1);
    }

    #[test]
    fn field_added_and_removed_trigger_snapshots() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0);
        session.record_tick(
            Some(&json!({ "map": { "game_state": "MENU", "matchid": "1" } })),
            10,
            t0 + Duration::seconds(1),
        );
        assert_eq!(session.snapshot_count, 2);
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0 + Duration::seconds(2));
        assert_eq!(session.snapshot_count, 3);
    }

    #[test]
    fn non_json_and_non_object_bodies_are_recorded_as_errors_not_snapshots() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(None, 5, t0);
        session.record_tick(Some(&json!([1, 2, 3])), 5, t0 + Duration::seconds(1));
        assert_eq!(session.snapshot_count, 0);
        assert_eq!(session.error_count, 2);
        let errors_content = fs::read_to_string(session.errors_path()).unwrap();
        assert_eq!(errors_content.lines().count(), 2);
    }

    #[test]
    fn shutdown_snapshot_is_written_once_and_only_if_a_payload_was_seen() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0);
        let after = t0 + Duration::seconds(2);
        session.finalize_shutdown(after);
        assert_eq!(session.snapshot_count, 2);
        session.finalize_shutdown(after + Duration::seconds(1));
        assert_eq!(session.snapshot_count, 2, "shutdown must be idempotent");
    }

    #[test]
    fn idle_watchdog_finalizes_after_timeout() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(Some(&json!({ "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" } })), 10, t0);
        assert!(!session.check_idle(t0 + Duration::seconds(10)));
        assert!(session.check_idle(t0 + Duration::seconds(IDLE_SHUTDOWN_SECS + 1)));
        assert!(session.finalized);
    }

    #[test]
    fn size_limit_stops_snapshots_but_keeps_timeline_and_catalog() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.size_limit_reached = true; // simulate limit already hit
        session.bytes_written = SIZE_LIMIT_BYTES;
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0);
        assert_eq!(fs::read_dir(session.dir.join("snapshots")).unwrap().count(), 0);
        let timeline_content = fs::read_to_string(session.timeline_path()).unwrap();
        assert_eq!(timeline_content.lines().count(), 1);
        assert_eq!(session.catalog.fields.len() > 0, true);
        // Meta (catalog.json/session-state.json) keeps getting written even
        // past the snapshot size limit - it's tiny, bounded by field count.
        assert!(session.dir.join("catalog.json").exists());
    }

    #[test]
    fn meta_is_debounced_but_forced_on_shutdown() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        let state_path = session.dir.join("session-state.json");

        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0);
        let after_first: Value = serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        assert_eq!(after_first["request_count"], json!(1));

        // Well within the debounce window (META_FLUSH_INTERVAL_SECS = 7s) -
        // must not have rewritten the file yet.
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU" } })), 10, t0 + Duration::seconds(3));
        let still_stale: Value = serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        assert_eq!(still_stale["request_count"], json!(1), "should still be debounced");

        // Stopping forces an immediate flush regardless of the debounce window.
        session.finalize_shutdown(t0 + Duration::seconds(4));
        let after_stop: Value = serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        assert_eq!(after_stop["request_count"], json!(2));
        assert_eq!(after_stop["finalized"], json!(true));
    }

    #[test]
    fn recovers_session_from_disk_for_export_after_a_restart() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(Some(&json!({ "map": { "game_state": "MENU", "matchid": "555" } })), 10, t0);

        let dir = session.dir.clone();
        let recovered = DiagnosticSession::load_from_disk(dir)
            .expect("load should succeed")
            .expect("session-state.json should exist after the first tick");

        assert_eq!(recovered.session_id, session.session_id);
        assert!(recovered.finalized, "recovered sessions are always treated as ended, never silently resumed");
        assert!(recovered.observed_match_ids.contains("555"));
        assert!(recovered.catalog.fields.contains_key("map.game_state"));
    }

    #[test]
    fn load_from_disk_returns_none_when_nothing_was_ever_flushed() {
        let dir = tempdir().unwrap();
        let never_flushed = dir.path().join("never-flushed");
        fs::create_dir_all(&never_flushed).unwrap();
        assert!(DiagnosticSession::load_from_disk(never_flushed).unwrap().is_none());
    }

    #[test]
    fn low_value_clock_changes_do_not_spam_triggers_or_change_lists() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(
            Some(&json!({ "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "clock_time": 10 } })),
            10,
            t0,
        );
        assert_eq!(session.snapshot_count, 1);

        for i in 1..10 {
            session.record_tick(
                Some(&json!({ "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "clock_time": 10 + i } })),
                10,
                t0 + Duration::seconds(i),
            );
        }
        assert_eq!(session.snapshot_count, 1, "clock_time changing alone must never trigger a new snapshot");

        session.record_tick(
            Some(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "clock_time": 999, "win_team": "radiant" }
            })),
            10,
            t0 + Duration::seconds(11),
        );
        assert_eq!(session.snapshot_count, 2);
        let timeline_content = fs::read_to_string(session.timeline_path()).unwrap();
        let last_line = timeline_content.lines().last().unwrap();
        assert!(!last_line.contains("clock_time"), "clock_time must be filtered out of the human-readable change list");
        assert!(last_line.contains("win_team"));
    }

    #[test]
    fn draft_field_value_change_alone_triggers_an_immediate_snapshot() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(
            Some(&json!({ "map": { "game_state": "MENU" }, "draft": { "activeteam": 0 } })),
            10,
            t0,
        );
        assert_eq!(session.snapshot_count, 1);

        // Nothing else in this tick changed (no game_state/add/remove) - only
        // a draft.* leaf value - must still snapshot immediately, not wait
        // for the 30s periodic checkpoint like an ordinary unlisted field
        // would (see low_value_clock_changes_do_not_spam_triggers_or_change_lists).
        session.record_tick(
            Some(&json!({ "map": { "game_state": "MENU" }, "draft": { "activeteam": 2 } })),
            10,
            t0 + Duration::seconds(1),
        );
        assert_eq!(session.snapshot_count, 2, "draft.* value change must trigger its own snapshot immediately");
        let timeline_content = fs::read_to_string(session.timeline_path()).unwrap();
        assert!(timeline_content.lines().last().unwrap().contains("draft.activeteam"));
    }

    #[test]
    fn ability_field_value_change_alone_triggers_an_immediate_snapshot() {
        let (_guard, mut session) = new_session();
        let t0 = session.started_at;
        session.record_tick(
            Some(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                "abilities": { "ability0": { "cooldown": 10, "level": 1 } }
            })),
            10,
            t0,
        );
        assert_eq!(session.snapshot_count, 1);

        session.record_tick(
            Some(&json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                "abilities": { "ability0": { "cooldown": 9, "level": 1 } }
            })),
            10,
            t0 + Duration::seconds(1),
        );
        assert_eq!(session.snapshot_count, 2, "abilities.* value change must trigger its own snapshot immediately");
        let timeline_content = fs::read_to_string(session.timeline_path()).unwrap();
        assert!(timeline_content.lines().last().unwrap().contains("abilities.ability0.cooldown"));
    }

    #[test]
    fn records_tts_trace_events_and_counts_them() {
        use super::super::tts_trace::{TtsTraceEvent, TtsTraceSource};
        let (_guard, mut session) = new_session();
        let mut stages = std::collections::BTreeMap::new();
        stages.insert("receivedAt".to_string(), 0.0);
        let event = TtsTraceEvent {
            message_id: "msg-1".to_string(),
            source: TtsTraceSource::Frontend,
            local_time: "now".to_string(),
            engine: Some("silero-xenia".to_string()),
            stages,
            detail: json!({}),
        };
        assert!(session.record_tts_trace(&event).is_none());
        assert_eq!(session.tts_trace_count, 1);
        let content = fs::read_to_string(session.tts_trace_path()).unwrap();
        assert_eq!(content.lines().count(), 1);
        assert!(content.contains("msg-1"));
    }

    #[test]
    fn tts_trace_is_not_recorded_after_finalization() {
        use super::super::tts_trace::{TtsTraceEvent, TtsTraceSource};
        let (_guard, mut session) = new_session();
        session.finalize_shutdown(session.started_at);
        let event = TtsTraceEvent {
            message_id: "msg-1".to_string(),
            source: TtsTraceSource::SileroSidecar,
            local_time: "now".to_string(),
            engine: None,
            stages: std::collections::BTreeMap::new(),
            detail: Value::Null,
        };
        assert!(session.record_tts_trace(&event).is_none());
        assert_eq!(session.tts_trace_count, 0, "must not record into a finalized session");
    }
}
