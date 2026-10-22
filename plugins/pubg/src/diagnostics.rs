//! Latency diagnostics: one JSON object per line in the plugin's private data
//! directory (`diagnostics.log`), from the backend request to the moment the
//! OBS page first reads a new state. Bounded: past 256 KB the file becomes
//! `diagnostics.1.log` (replacing the older one). Writing never fails the
//! worker; a lost line is only a lost diagnostic.
use chrono::Utc;
use serde_json::{json, Value};
use std::{io::Write, path::Path};

pub const FILE: &str = "diagnostics.log";
pub const ROTATED: &str = "diagnostics.1.log";
const LIMIT: u64 = 256 * 1024;

pub fn record(root: &Path, event: &str, fields: Value) {
    let mut line = json!({"at": Utc::now(), "event": event});
    if let (Some(line), Value::Object(fields)) = (line.as_object_mut(), fields) { line.extend(fields); }
    let _ = append(root, &line);
}

fn append(root: &Path, line: &Value) -> std::io::Result<()> {
    let path = root.join(FILE);
    if let Ok(metadata) = path.symlink_metadata() {
        if !metadata.is_file() { return Ok(()); }
        if metadata.len() > LIMIT {
            let rotated = root.join(ROTATED);
            if rotated.symlink_metadata().is_ok_and(|m| !m.is_file()) { return Ok(()); }
            std::fs::rename(&path, rotated)?;
        }
    }
    let mut bytes = serde_json::to_vec(line).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn read(root: &Path) -> Vec<Value> {
        std::fs::read_to_string(root.join(FILE)).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
    #[test]
    fn appends_timestamped_events_and_rotates_when_large() {
        let root = tempfile::tempdir().unwrap();
        record(root.path(), "request", json!({"seq": 1}));
        let events = read(root.path());
        assert_eq!((events[0]["event"].as_str(), events[0]["seq"].as_u64()), (Some("request"), Some(1)));
        assert!(events[0]["at"].is_string());
        std::fs::write(root.path().join(FILE), vec![b' '; LIMIT as usize + 1]).unwrap();
        record(root.path(), "response", json!({}));
        assert_eq!(read(root.path()).len(), 1, "a fresh file after rotation");
        assert!(root.path().join(ROTATED).exists());
    }
}
