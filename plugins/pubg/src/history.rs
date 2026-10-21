//! Durable match history for one player. Matches are keyed by PUBG match id,
//! so a repeated or overlapping backend page never creates a duplicate.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "history.json";
pub const LIMIT: usize = 200;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Match {
    pub id: String,
    /// Match start (PUBG `createdAt`): session membership is decided by this,
    /// never by when the result reached us.
    pub created_at: DateTime<Utc>,
    pub duration_sec: u32,
    pub map: String,
    pub game_mode: String,
    pub place: Option<u32>,
    pub kills: u32,
    pub damage: u32,
}
impl Match {
    pub fn valid(&self) -> bool {
        (1..=64).contains(&self.id.len()) && self.id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            && !self.map.is_empty() && self.map.len() <= 64 && self.map.chars().all(|c| !c.is_control())
            && self.game_mode.len() <= 32 && self.game_mode.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && self.place.is_none_or(|p| (1..=200).contains(&p)) && self.kills <= 200 && self.damage <= 100_000
            && self.duration_sec <= 6 * 3600
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History {
    pub owner: Option<String>,
    /// Newest first, unique ids.
    pub matches: Vec<Match>,
}
impl History {
    pub fn load(root: &Path) -> Result<Self, String> {
        Ok(crate::files::read(root, FILE, 512 * 1024)?.unwrap_or_default())
    }
    pub fn save(&self, root: &Path) -> Result<(), String> {
        crate::files::write(root, FILE, self, 512 * 1024)
    }
    /// Another player or platform starts from an empty history.
    pub fn bind(&mut self, owner: Option<String>) -> bool {
        if self.owner == owner { return false; }
        self.owner = owner;
        self.matches.clear();
        true
    }
    /// Adds unseen matches, keeps newest first and bounded. Returns how many
    /// were new. A known id is refreshed in place (the backend's projection
    /// is authoritative), never duplicated.
    pub fn merge(&mut self, incoming: Vec<Match>) -> usize {
        let mut added = 0;
        for item in incoming.into_iter().filter(Match::valid) {
            match self.matches.iter_mut().find(|m| m.id == item.id) {
                Some(existing) => *existing = item,
                None => { self.matches.push(item); added += 1; }
            }
        }
        self.matches.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
        self.matches.truncate(LIMIT);
        added
    }
    /// Matches that started at or after the session start, newest first.
    pub fn session(&self, started_at: Option<DateTime<Utc>>) -> Vec<&Match> {
        match started_at {
            Some(start) => self.matches.iter().filter(|m| m.created_at >= start).collect(),
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn sample(n: u32, minutes_ago: i64) -> Match {
        Match {
            id: format!("00000000-0000-4000-8000-{n:012}"),
            created_at: Utc::now() - chrono::Duration::minutes(minutes_ago),
            duration_sec: 1500, map: "Erangel".into(), game_mode: "squad-fpp".into(),
            place: Some(n % 100 + 1), kills: n % 10, damage: 100 * n,
        }
    }
    #[test]
    fn overlapping_pages_never_duplicate_and_stay_newest_first() {
        let mut h = History::default();
        assert_eq!(h.merge(vec![sample(1, 30), sample(2, 20)]), 2);
        assert_eq!(h.merge(vec![sample(3, 10), sample(2, 20), sample(1, 30)]), 1);
        assert_eq!(h.matches.iter().map(|m| m.kills).collect::<Vec<_>>(), vec![3, 2, 1]);
        let mut corrected = sample(2, 20);
        corrected.created_at = h.matches[1].created_at;
        corrected.damage = 7;
        assert_eq!(h.merge(vec![corrected]), 0);
        assert_eq!(h.matches.len(), 3);
        assert_eq!(h.matches[1].damage, 7);
    }
    #[test]
    fn session_counts_by_match_start_not_by_arrival() {
        let mut h = History::default();
        let start = Utc::now() - chrono::Duration::minutes(15);
        // Already running when Companion started, result arrives later.
        h.merge(vec![sample(1, 25)]);
        h.merge(vec![sample(2, 5)]);
        assert_eq!(h.session(Some(start)).iter().map(|m| m.kills).collect::<Vec<_>>(), vec![2]);
        assert!(h.session(None).is_empty());
    }
    #[test]
    fn invalid_entries_are_dropped_and_history_is_bounded() {
        let mut h = History::default();
        let mut bad = sample(1, 1); bad.id = "../x".into();
        let mut bad_mode = sample(2, 1); bad_mode.game_mode = "<script>".into();
        assert_eq!(h.merge(vec![bad, bad_mode]), 0);
        h.merge((0..(LIMIT as u32 + 20)).map(|n| sample(n, n as i64)).collect());
        assert_eq!(h.matches.len(), LIMIT);
        assert_eq!(h.matches[0].kills, 0, "the newest is kept");
    }
    #[test]
    fn switching_owner_clears_and_storage_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let mut h = History::default();
        assert!(h.bind(Some("steam:a".into())));
        h.merge(vec![sample(1, 1)]);
        h.save(root.path()).unwrap();
        let mut loaded = History::load(root.path()).unwrap();
        assert_eq!(loaded, h);
        assert!(!loaded.bind(Some("steam:a".into())));
        assert!(loaded.bind(Some("xbox:a".into())));
        assert!(loaded.matches.is_empty());
    }
}
