use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::analysis;
use super::catalog::FieldInfo;

/// Bumped to 1.2.0 when tts-trace.json was added, so downstream tooling can
/// detect the shape change. (1.1.0 added unused-known-fields.json /
/// possible-features.md / analysis-summary.json.)
pub const SCHEMA_VERSION: &str = "1.2.0";

#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    pub companion_version: String,
    pub diagnostics_schema_version: String,
    pub session_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub gsi_request_count: u64,
    pub snapshot_count: u64,
    pub error_count: u64,
    pub observed_game_states: Vec<String>,
    pub observed_match_ids: Vec<String>,
    pub os: String,
    pub size_bytes_used: u64,
    pub size_limit_bytes: u64,
    pub size_limit_reached: bool,
}

/// "What did Companion actually ask Dota for" - as opposed to everything
/// else in this export, which answers "what did Dota actually send".
/// `requested_sections` is read directly from `gsi::config::data_sections()`,
/// the exact list `install_gsi()` builds the real .cfg file from - there is
/// no second copy of this data anywhere, so this can never show a different
/// set of sections than what was actually installed during the session.
#[derive(Debug, Clone, Serialize)]
pub struct GsiManifest {
    pub companion_version: String,
    pub generated_at: String,
    pub gsi_port: u16,
    pub gsi_config_file_name: String,
    pub requested_sections: std::collections::BTreeMap<String, bool>,
}

fn build_gsi_manifest(companion_version: &str, generated_at: &str) -> GsiManifest {
    GsiManifest {
        companion_version: companion_version.to_string(),
        generated_at: generated_at.to_string(),
        gsi_port: crate::state::GSI_PORT,
        gsi_config_file_name: crate::state::GSI_CONFIG_FILE_NAME.to_string(),
        requested_sections: crate::gsi::config::data_sections()
            .iter()
            .map(|(name, enabled)| (name.to_string(), *enabled))
            .collect(),
    }
}

fn jsonl_to_array(path: &Path) -> Result<Vec<Value>, String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).map_err(|e| format!("malformed line in {}: {e}", path.display())))
        .collect()
}

fn sorted_json_files(dir: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    Ok(files)
}

const README_TEMPLATE: &str = r#"Dota Companion — GSI diagnostics export
========================================

This archive is a passive-observer capture of what Dota's Game State
Integration (GSI) actually sends, collected in Companion's diagnostic mode.
It does not reflect or change Companion's normal behavior — diagnostics run
alongside the regular GSI pipeline without altering it.

Contents:
  manifest.json          Session metadata: versions, time range, counts, the
                         game_state values and match IDs observed. No tokens,
                         no file paths, no usernames.
  gsi-manifest.json       What Companion asked Dota for, not what Dota sent -
                         the GSI port, config file name, and the exact
                         `requested_sections` map (provider/map/player/hero/
                         ...) read directly from the same source the installed
                         .cfg file is generated from, so it can't disagree
                         with what was actually running during this session.
  timeline.json           Human-readable chronological log. One entry per
                         notable moment (first payload, a game_state change, a
                         field appearing/disappearing, a type change, a
                         significant value change, a periodic checkpoint, or
                         session shutdown), each with the key/value summary
                         fields and a compact list of what changed since the
                         previous entry. Clock-like fields (map.clock_time,
                         map.game_time) are excluded from both the trigger
                         logic and this change list - see field-catalog.json
                         if you need their exact values.
  field-catalog.json      Every distinct JSON path seen across the whole
                         session (arrays and steamid/slot-index-style dynamic
                         keys are normalized so the catalog doesn't explode in
                         size), with the type(s) seen, first/last game_state it
                         appeared in, how many times its value changed, a few
                         sample values, whether it ever disappeared again after
                         first appearing, `known_to_companion` (its top-level
                         GSI section - map/player/hero/... - is one Companion's
                         config requests) and `currently_used` (some Companion
                         code actually reads this exact path today).
  unknown-fields.json      Catalog entries where known_to_companion is false -
                         a GSI section Companion never even asked for.
  unused-known-fields.json Catalog entries where known_to_companion is true
                         but currently_used is false - i.e. Dota is already
                         sending it and nothing reads it yet. These are the
                         best feature candidates.
  possible-features.md     Auto-generated, human-readable "what can we build"
                         summary derived from field-catalog.json - confirmed
                         candidates, notable absences, and a scan for
                         disconnect/reconnect/abandon/safe_to_leave-shaped
                         field names. Heuristic and name-based - read the
                         disclaimer at the bottom before trusting it.
  analysis-summary.json    Same analysis as possible-features.md, machine-
                         readable.
  snapshots/                Full raw JSON payloads (secrets redacted) saved at
                         the moments listed in timeline.json — NOT every GSI
                         tick, only the sampled ones.
  diffs/                     Recursive diff between each snapshot and the
                         previous one (unfiltered, including clock fields),
                         numbered to match the snapshot it belongs to.
  errors.json                Requests that failed to parse as a JSON object
                         (raw content is never stored here, only length/time).
  tts-trace.json           TTS pipeline timing, present only if TTS was used
                         during this session. One record per (messageId,
                         source) pair - `source` is "frontend" (queue/
                         playback stage timestamps from the Companion UI) or
                         "silero_sidecar" (synthesis-stage timestamps from
                         the Rust/Silero side). Sessions exported by an older
                         Companion version may also contain legacy
                         "piper_sidecar" records (Piper was removed in
                         WK-80) - still valid, just no longer produced. The
                         sources for the same message are written independently
                         as soon as each side observes its own stages - group by messageId to
                         see one message's full timeline. `stages` is a map
                         of stage name -> milliseconds (monotonic, relative -
                         compare stages within the same record, not across
                         records/sources). Chat message text is included
                         here deliberately (unlike GSI's secret-key
                         redaction, this is about diagnosing exactly what
                         text reached the TTS engine and how much audio came
                         back for it, e.g. for a message that gets cut off
                         mid-sentence).

Recommended order to read this export:
  1. timeline.json                              - the story of the session
  2. field-catalog.json                         - every field, how it behaved
  3. unknown-fields.json, unused-known-fields.json,
     possible-features.md / analysis-summary.json - what's new, unused, buildable
  4. gsi-manifest.json                           - what was even asked for (context for #3)
  5. snapshots/                                   - full raw payloads for anything surprising
  6. diffs/                                        - exact field-by-field changes between snapshots
  7. tts-trace.json                               - TTS pipeline timing, if TTS was used this session

Note on "currently_used": field-catalog.json's `currently_used` flag only
reflects what Companion's own Rust code reads (server/mod.rs's
summarize_payload) - it does NOT cover the separate browser overlay, which
reads two more already-flowing fields client-side (`player.team_name` and
`hero.id`/`hero.name`, see docs/draft-gsi-contract.md's WK-77 addendum). A
field showing `currently_used: false` here means "nothing in Companion's
Rust layer reads this exact path today," not "nothing in the product reads
it."

Redaction: any JSON object key containing "token", "auth", "password",
"secret" or "authorization" (case-insensitive, at any nesting depth) has
its value replaced with "[REDACTED]" before anything is written to disk.

This capture does not draw conclusions about disconnects/abandons/etc. — it
only records what GSI sent and when. Absence of requests for a period is
recorded as a fact (last payload timestamp), never interpreted as a specific
game event. possible-features.md's "notable absences" and keyword scan work
the same way - they report what wasn't seen, not what doesn't exist.
"#;

/// Builds the diagnostics ZIP. `session_dir` must contain (some may be
/// missing/empty for a very short session) timeline.jsonl, errors.jsonl,
/// snapshots/, diffs/ - written incrementally by `DiagnosticSession`. The
/// field catalog is passed in directly (it only ever lives in memory for the
/// current app run - see module docs) rather than re-read from disk.
pub fn export_zip(
    session_dir: &Path,
    catalog_fields: &[&FieldInfo],
    manifest: &Manifest,
    generated_at: &str,
    app_log: &[u8],
    output_path: &Path,
) -> Result<(), String> {
    let file = fs::File::create(output_path).map_err(|e| format!("could not create {}: {e}", output_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let write_entry = |zip: &mut ZipWriter<fs::File>, name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| format!("{name}: {e}"))?;
        zip.write_all(bytes).map_err(|e| format!("{name}: {e}"))
    };

    write_entry(
        &mut zip,
        "manifest.json",
        &serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?,
    )?;

    let gsi_manifest = build_gsi_manifest(&manifest.companion_version, generated_at);
    write_entry(
        &mut zip,
        "gsi-manifest.json",
        &serde_json::to_vec_pretty(&gsi_manifest).map_err(|e| e.to_string())?,
    )?;

    let timeline = jsonl_to_array(&session_dir.join("timeline.jsonl"))?;
    write_entry(&mut zip, "timeline.json", &serde_json::to_vec_pretty(&timeline).map_err(|e| e.to_string())?)?;

    write_entry(
        &mut zip,
        "field-catalog.json",
        &serde_json::to_vec_pretty(catalog_fields).map_err(|e| e.to_string())?,
    )?;

    let unknown: Vec<&&FieldInfo> = catalog_fields.iter().filter(|f| !f.known_to_companion).collect();
    write_entry(
        &mut zip,
        "unknown-fields.json",
        &serde_json::to_vec_pretty(&unknown).map_err(|e| e.to_string())?,
    )?;

    let unused_known: Vec<&&FieldInfo> =
        catalog_fields.iter().filter(|f| f.known_to_companion && !f.currently_used).collect();
    write_entry(
        &mut zip,
        "unused-known-fields.json",
        &serde_json::to_vec_pretty(&unused_known).map_err(|e| e.to_string())?,
    )?;

    let analysis_summary = analysis::analyze(catalog_fields, &manifest.session_id, generated_at);
    write_entry(
        &mut zip,
        "analysis-summary.json",
        &serde_json::to_vec_pretty(&analysis_summary).map_err(|e| e.to_string())?,
    )?;
    write_entry(&mut zip, "possible-features.md", analysis::render_markdown(&analysis_summary).as_bytes())?;

    let errors = jsonl_to_array(&session_dir.join("errors.jsonl"))?;
    write_entry(&mut zip, "errors.json", &serde_json::to_vec_pretty(&errors).map_err(|e| e.to_string())?)?;

    let tts_trace = jsonl_to_array(&session_dir.join("tts-trace.jsonl"))?;
    if !tts_trace.is_empty() {
        write_entry(&mut zip, "tts-trace.json", &serde_json::to_vec_pretty(&tts_trace).map_err(|e| e.to_string())?)?;
    }

    for path in sorted_json_files(&session_dir.join("snapshots"))? {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("snapshot.json");
        let bytes = fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
        write_entry(&mut zip, &format!("snapshots/{name}"), &bytes)?;
    }
    for path in sorted_json_files(&session_dir.join("diffs"))? {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("diff.json");
        let bytes = fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
        write_entry(&mut zip, &format!("diffs/{name}"), &bytes)?;
    }

    write_entry(&mut zip, "README.txt", README_TEMPLATE.as_bytes())?;

    // WK-116 - the always-on bounded runtime log (session/match/scene/sync
    // checkpoints - see storage::append_rolling_log's call sites), included
    // unconditionally so this ZIP alone is enough to investigate a wiring
    // problem even if diagnostics-mode capture was never explicitly started.
    write_entry(&mut zip, "app.log", app_log)?;

    zip.finish().map_err(|e| format!("finalizing zip: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::catalog::FieldCatalog;
    use serde_json::json;
    use std::io::Read;
    use tempfile::tempdir;

    #[test]
    fn builds_zip_with_expected_entries_and_readable_manifest() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("session");
        fs::create_dir_all(session_dir.join("snapshots")).unwrap();
        fs::create_dir_all(session_dir.join("diffs")).unwrap();
        fs::write(
            session_dir.join("timeline.jsonl"),
            format!("{}\n", serde_json::to_string(&json!({"reason": "initial"})).unwrap()),
        )
        .unwrap();
        fs::write(session_dir.join("errors.jsonl"), "").unwrap();
        fs::write(session_dir.join("snapshots/0001-initial.json"), r#"{"map":{"game_state":"MENU"}}"#).unwrap();

        let mut catalog = FieldCatalog::new();
        catalog.observe(&json!({ "map": { "game_state": "MENU" } }), Some("MENU"));
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();

        let manifest = Manifest {
            companion_version: "0.2.1".into(),
            diagnostics_schema_version: SCHEMA_VERSION.into(),
            session_id: "s1".into(),
            started_at: "2026-07-25T10:00:00+07:00".into(),
            ended_at: None,
            gsi_request_count: 1,
            snapshot_count: 1,
            error_count: 0,
            observed_game_states: vec!["MENU".into()],
            observed_match_ids: vec![],
            os: "windows".into(),
            size_bytes_used: 123,
            size_limit_bytes: super::super::session::SIZE_LIMIT_BYTES,
            size_limit_reached: false,
        };

        let output = dir.path().join("out.zip");
        export_zip(&session_dir, &fields, &manifest, "2026-07-25T11:00:00+07:00", b"[log] line one\n", &output).expect("export should succeed");

        let file = fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        for expected in [
            "manifest.json",
            "gsi-manifest.json",
            "timeline.json",
            "field-catalog.json",
            "unknown-fields.json",
            "unused-known-fields.json",
            "analysis-summary.json",
            "possible-features.md",
            "errors.json",
            "snapshots/0001-initial.json",
            "README.txt",
            "app.log",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected} in {names:?}");
        }

        let mut app_log_content = String::new();
        archive.by_name("app.log").unwrap().read_to_string(&mut app_log_content).unwrap();
        assert_eq!(app_log_content, "[log] line one\n");

        let mut content = String::new();
        archive.by_name("manifest.json").unwrap().read_to_string(&mut content).unwrap();
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["session_id"], json!("s1"));
        assert_eq!(parsed["companion_version"], json!("0.2.1"));

        let mut gsi_manifest_content = String::new();
        archive.by_name("gsi-manifest.json").unwrap().read_to_string(&mut gsi_manifest_content).unwrap();
        let gsi_manifest: Value = serde_json::from_str(&gsi_manifest_content).unwrap();
        // Must match crate::gsi::config::data_sections() exactly - that's the
        // whole point of gsi-manifest.json (can't drift from the real .cfg).
        for (name, enabled) in crate::gsi::config::data_sections() {
            assert_eq!(
                gsi_manifest["requested_sections"][name],
                json!(enabled),
                "gsi-manifest.json disagreed with gsi::config::data_sections() for {name}"
            );
        }
        assert_eq!(gsi_manifest["gsi_port"], json!(crate::state::GSI_PORT));
    }

    #[test]
    fn includes_tts_trace_json_only_when_the_session_captured_any() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("session-with-tts");
        fs::create_dir_all(session_dir.join("snapshots")).unwrap();
        fs::create_dir_all(session_dir.join("diffs")).unwrap();
        fs::write(session_dir.join("timeline.jsonl"), "").unwrap();
        fs::write(session_dir.join("errors.jsonl"), "").unwrap();
        fs::write(
            session_dir.join("tts-trace.jsonl"),
            format!(
                "{}\n",
                serde_json::to_string(&json!({"messageId": "msg-1", "source": "frontend"})).unwrap()
            ),
        )
        .unwrap();

        let manifest = Manifest {
            companion_version: "0.4.0".into(),
            diagnostics_schema_version: SCHEMA_VERSION.into(),
            session_id: "s3".into(),
            started_at: "2026-08-19T10:00:00+03:00".into(),
            ended_at: None,
            gsi_request_count: 0,
            snapshot_count: 0,
            error_count: 0,
            observed_game_states: vec![],
            observed_match_ids: vec![],
            os: "windows".into(),
            size_bytes_used: 10,
            size_limit_bytes: super::super::session::SIZE_LIMIT_BYTES,
            size_limit_reached: false,
        };
        let output = dir.path().join("with-tts.zip");
        export_zip(&session_dir, &[], &manifest, "2026-08-19T10:05:00+03:00", b"", &output).unwrap();

        let file = fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"tts-trace.json".to_string()));

        // A session that never captured TTS trace events must not get an
        // empty tts-trace.json entry - matches the README's "present only
        // if TTS was used".
        let session_dir_no_tts = dir.path().join("session-without-tts");
        fs::create_dir_all(session_dir_no_tts.join("snapshots")).unwrap();
        fs::create_dir_all(session_dir_no_tts.join("diffs")).unwrap();
        fs::write(session_dir_no_tts.join("timeline.jsonl"), "").unwrap();
        fs::write(session_dir_no_tts.join("errors.jsonl"), "").unwrap();
        let output2 = dir.path().join("without-tts.zip");
        export_zip(&session_dir_no_tts, &[], &manifest, "2026-08-19T10:05:00+03:00", b"", &output2).unwrap();
        let file2 = fs::File::open(&output2).unwrap();
        let mut archive2 = zip::ZipArchive::new(file2).unwrap();
        let names2: Vec<String> = (0..archive2.len()).map(|i| archive2.by_index(i).unwrap().name().to_string()).collect();
        assert!(!names2.contains(&"tts-trace.json".to_string()));
    }

    #[test]
    fn handles_empty_session_without_erroring() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("empty-session");
        fs::create_dir_all(&session_dir).unwrap();
        let manifest = Manifest {
            companion_version: "0.2.1".into(),
            diagnostics_schema_version: SCHEMA_VERSION.into(),
            session_id: "empty".into(),
            started_at: "2026-07-25T10:00:00+07:00".into(),
            ended_at: Some("2026-07-25T10:00:01+07:00".into()),
            gsi_request_count: 0,
            snapshot_count: 0,
            error_count: 0,
            observed_game_states: vec![],
            observed_match_ids: vec![],
            os: "windows".into(),
            size_bytes_used: 0,
            size_limit_bytes: super::super::session::SIZE_LIMIT_BYTES,
            size_limit_reached: false,
        };
        let output = dir.path().join("empty.zip");
        export_zip(&session_dir, &[], &manifest, "2026-07-25T10:00:01+07:00", b"", &output)
            .expect("export of an empty session should still succeed");
        assert!(output.exists());
    }

    #[test]
    fn unused_known_fields_only_contains_known_but_unread_paths() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("session2");
        fs::create_dir_all(session_dir.join("snapshots")).unwrap();
        fs::create_dir_all(session_dir.join("diffs")).unwrap();
        fs::write(session_dir.join("timeline.jsonl"), "").unwrap();
        fs::write(session_dir.join("errors.jsonl"), "").unwrap();

        let mut catalog = FieldCatalog::new();
        // map.game_state is known + used; player.team_name is known + unused;
        // some_future_section.x is neither.
        catalog.observe(
            &json!({
                "map": { "game_state": "MENU" },
                "player": { "team_name": "radiant" },
                "some_future_section": { "x": 1 }
            }),
            Some("MENU"),
        );
        let fields: Vec<&FieldInfo> = catalog.fields.values().collect();

        let manifest = Manifest {
            companion_version: "0.2.1".into(),
            diagnostics_schema_version: SCHEMA_VERSION.into(),
            session_id: "s2".into(),
            started_at: "2026-07-25T10:00:00+07:00".into(),
            ended_at: None,
            gsi_request_count: 1,
            snapshot_count: 1,
            error_count: 0,
            observed_game_states: vec!["MENU".into()],
            observed_match_ids: vec![],
            os: "windows".into(),
            size_bytes_used: 10,
            size_limit_bytes: super::super::session::SIZE_LIMIT_BYTES,
            size_limit_reached: false,
        };
        let output = dir.path().join("out2.zip");
        export_zip(&session_dir, &fields, &manifest, "2026-07-25T11:00:00+07:00", b"", &output).unwrap();

        let file = fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();

        let mut unused = String::new();
        archive.by_name("unused-known-fields.json").unwrap().read_to_string(&mut unused).unwrap();
        assert!(unused.contains("player.team_name"));
        assert!(!unused.contains("map.game_state"), "map.game_state is currently_used, must not appear");
        assert!(!unused.contains("some_future_section"), "unknown section belongs in unknown-fields.json, not here");

        let mut features = String::new();
        archive.by_name("possible-features.md").unwrap().read_to_string(&mut features).unwrap();
        assert!(features.contains("player.team_name") || features.contains("heuristic"));
    }
}
