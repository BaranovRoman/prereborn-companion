use serde::Serialize;
use serde_json::Value;

use super::diff::DiffEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Initial,
    GameStateChanged,
    FieldAdded,
    FieldRemoved,
    FieldTypeChanged,
    SignificantValueChanged,
    PeriodicSnapshot,
    Shutdown,
    RequestError,
}

/// A handful of leaf paths worth an extra snapshot the moment their *value*
/// changes, even when nothing was added/removed/retyped - these are the
/// fields most likely to matter for match-lifecycle detection (win/loss,
/// pause, activity, disconnect-adjacent state). Not exhaustive - anything
/// else that changes still shows up via the generic diff, just doesn't by
/// itself force an extra snapshot.
pub const SIGNIFICANT_PATHS: &[&str] = &[
    "map.game_state",
    "map.matchid",
    "map.win_team",
    "map.paused",
    "map.game_mode",
    "map.round_wins",
    "player.activity",
    "player.kills",
    "player.deaths",
    "player.assists",
    "player.team_name",
    "hero.alive",
    "hero.respawn_seconds",
    "hero.id",
    "hero.name",
    "provider.appid",
];

/// Best-effort, defensive field extraction for the human-readable timeline -
/// mirrors server/mod.rs's `summarize_payload` in spirit (never assumes a
/// field exists) but pulls a few more columns useful for lifecycle analysis.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SummaryFields {
    pub game_state: Option<String>,
    pub match_id: Option<String>,
    pub hero_id: Option<i64>,
    pub hero_name: Option<String>,
    pub kills: Option<i64>,
    pub deaths: Option<i64>,
    pub assists: Option<i64>,
    pub team_name: Option<String>,
    pub win_team: Option<String>,
    pub activity: Option<String>,
}

fn as_str(v: &Value, obj_key: &str, field: &str) -> Option<String> {
    v.get(obj_key)?.get(field)?.as_str().map(str::to_string)
}

fn as_i64(v: &Value, obj_key: &str, field: &str) -> Option<i64> {
    v.get(obj_key)?.get(field)?.as_i64()
}

pub fn extract_summary(payload: &Value) -> SummaryFields {
    SummaryFields {
        game_state: as_str(payload, "map", "game_state"),
        match_id: as_str(payload, "map", "matchid"),
        hero_id: as_i64(payload, "hero", "id"),
        hero_name: as_str(payload, "hero", "name"),
        kills: as_i64(payload, "player", "kills"),
        deaths: as_i64(payload, "player", "deaths"),
        assists: as_i64(payload, "player", "assists"),
        team_name: as_str(payload, "player", "team_name"),
        win_team: as_str(payload, "map", "win_team"),
        activity: as_str(payload, "player", "activity"),
    }
}

/// Fields that change on essentially every tick and carry no lifecycle
/// information by themselves (a running clock). Changes to these paths never
/// by themselves justify a new snapshot/timeline entry, and are stripped out
/// of the human-readable "changes" list on entries triggered for other
/// reasons - otherwise a session's timeline reads as half clock ticks. They
/// are NOT stripped from the raw snapshot files themselves (still the full,
/// unfiltered payload) or from diffs/*.json (still a complete technical
/// diff between two saved snapshots) - only from the curated summary.
const LOW_VALUE_PATHS: &[&str] = &["map.clock_time", "map.game_time"];

/// `diff_path` is in diff.rs's `$.a.b[0].c` format - strip the leading `$.`
/// before comparing against the plain dotted paths in `LOW_VALUE_PATHS`.
pub fn is_low_value_path(diff_path: &str) -> bool {
    let trimmed = diff_path.strip_prefix("$.").unwrap_or(diff_path);
    LOW_VALUE_PATHS.contains(&trimmed)
}

const MAX_CHANGES_LISTED: usize = 25;

/// Renders a bounded list of human-readable one-line change summaries from a
/// full recursive diff, e.g. "player.kills: 3 -> 4 (value_changed)".
pub fn format_changes(diff: &[DiffEntry]) -> Vec<String> {
    let mut lines: Vec<String> = diff
        .iter()
        .take(MAX_CHANGES_LISTED)
        .map(|entry| {
            let kind = serde_json::to_value(entry.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            match (&entry.old_value, &entry.new_value) {
                (Some(o), Some(n)) => format!("{}: {} -> {} ({kind})", entry.path, o, n),
                (None, Some(n)) => format!("{}: (added) {} ({kind})", entry.path, n),
                (Some(o), None) => format!("{}: {} -> (removed) ({kind})", entry.path, o),
                (None, None) => format!("{}: ({kind})", entry.path),
            }
        })
        .collect();
    if diff.len() > MAX_CHANGES_LISTED {
        lines.push(format!("... and {} more change(s)", diff.len() - MAX_CHANGES_LISTED));
    }
    lines
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineEntry {
    pub local_time: String,
    pub elapsed_seconds: f64,
    pub reason: Reason,
    #[serde(flatten)]
    pub summary: SummaryFields,
    pub changes: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_known_fields_defensively() {
        let payload = json!({
            "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "matchid": "111", "win_team": "radiant" },
            "hero": { "id": 1, "name": "npc_dota_hero_axe" },
            "player": { "kills": 2, "deaths": 1, "assists": 3, "team_name": "radiant", "activity": "playing" }
        });
        let summary = extract_summary(&payload);
        assert_eq!(summary.game_state.as_deref(), Some("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"));
        assert_eq!(summary.match_id.as_deref(), Some("111"));
        assert_eq!(summary.hero_id, Some(1));
        assert_eq!(summary.kills, Some(2));
    }

    #[test]
    fn missing_sections_never_panic() {
        let summary = extract_summary(&json!({}));
        assert!(summary.game_state.is_none());
        assert!(summary.hero_id.is_none());
    }

    #[test]
    fn recognizes_low_value_clock_paths_and_leaves_others_alone() {
        assert!(is_low_value_path("$.map.clock_time"));
        assert!(is_low_value_path("$.map.game_time"));
        assert!(!is_low_value_path("$.map.game_state"));
        assert!(!is_low_value_path("$.player.kills"));
    }

    #[test]
    fn format_changes_is_bounded() {
        let diff: Vec<DiffEntry> = (0..40)
            .map(|i| DiffEntry {
                path: format!("field{i}"),
                kind: super::super::diff::ChangeKind::Added,
                old_value: None,
                new_value: Some(json!(i)),
            })
            .collect();
        let lines = format_changes(&diff);
        assert_eq!(lines.len(), MAX_CHANGES_LISTED + 1);
        assert!(lines.last().unwrap().contains("more change"));
    }
}
