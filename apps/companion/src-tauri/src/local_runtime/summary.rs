// WK-114 - read-only projection of the local runtime for the Home page: the
// first thing outside `local_runtime` that ever needs LocalSession/LocalMatch
// data (previously only `lifecycle::status` exposed anything, and only the
// lifecycle state machine's own fields - see that module's doc comment).
// Purely additive: no new writes, no new tables, just two more SELECT-style
// queries (`store::list_recent_matches`/`store::session_match_tally`) composed
// into one DTO. Never touches sync/outbox/lifecycle decision-making.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::model::{LocalMatch, LocalMatchState, MatchResult, RankedMode};
use super::store;
use super::LocalRuntimeState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMatchSummary {
    pub match_id: Option<String>,
    pub hero_id: i64,
    pub result: Option<MatchResult>,
    pub ranked_mode: RankedMode,
    pub state: LocalMatchState,
    pub rating_before: Option<i64>,
    pub rating_after: Option<i64>,
    pub started_at: String,
    pub finalized_at: Option<String>,
}

impl From<&LocalMatch> for LocalMatchSummary {
    fn from(value: &LocalMatch) -> Self {
        Self {
            match_id: value.match_id.clone(),
            hero_id: value.hero_id,
            result: value.result,
            ranked_mode: value.ranked_mode,
            state: value.state,
            rating_before: value.rating_before,
            rating_after: value.rating_after,
            started_at: value.started_at.clone(),
            finalized_at: value.finalized_at.clone(),
        }
    }
}

const ACTIVE_STATES: &[LocalMatchState] = &[
    LocalMatchState::InProgress,
    LocalMatchState::PostGamePending,
    LocalMatchState::Interrupted,
];

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionSummary {
    pub has_session: bool,
    pub started_at: Option<String>,
    pub rating_start: Option<i64>,
    pub rating_current: Option<i64>,
    pub wins: i64,
    pub losses: i64,
    pub current_match: Option<LocalMatchSummary>,
    // Newest first, finalized matches only - the in-progress match (if any)
    // is `current_match` above, not repeated here.
    pub recent_matches: Vec<LocalMatchSummary>,
}

const RECENT_MATCHES_LIMIT: i64 = 30;
const RECENT_MATCHES_DISPLAY: usize = 10;

/// Reads the currently open local session (if any) plus its recent match
/// history - never creates or mutates anything (mirrors `lifecycle::status`'s
/// read-only contract). Returns the empty/default summary if the local
/// runtime failed to open (see `local_runtime::init`'s doc comment: a
/// storage failure must leave the rest of Companion working, just with
/// nothing to show here) or if no session is currently open.
pub fn get(app: &AppHandle) -> LocalSessionSummary {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else {
        return LocalSessionSummary::default();
    };
    let Some(session) = store::find_open_session(conn).ok().flatten() else {
        return LocalSessionSummary::default();
    };

    let current_match = store::find_active_match(conn, &session.local_id)
        .ok()
        .flatten()
        .map(|m| LocalMatchSummary::from(&m));
    let recent_matches = store::list_recent_matches(conn, &session.local_id, RECENT_MATCHES_LIMIT)
        .unwrap_or_default()
        .iter()
        .filter(|m| !ACTIVE_STATES.contains(&m.state))
        .take(RECENT_MATCHES_DISPLAY)
        .map(LocalMatchSummary::from)
        .collect();
    let (wins, losses) = store::session_match_tally(conn, &session.local_id).unwrap_or((0, 0));

    LocalSessionSummary {
        has_session: true,
        started_at: Some(session.started_at),
        rating_start: session.rating_start,
        rating_current: session.rating_current,
        wins,
        losses,
        current_match,
        recent_matches,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::schema;
    use chrono::Utc;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    // These tests exercise the query composition directly against a real
    // connection (not through the AppHandle-based `get`, which needs a full
    // Tauri app context) - the same "test the store logic directly, wire the
    // Tauri glue thinly" split already used by store.rs/lifecycle.rs's own
    // test modules.

    #[test]
    fn a_session_with_no_matches_reports_zero_tally_and_no_current_match() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        assert!(store::find_active_match(&conn, &session.local_id).unwrap().is_none());
        let (wins, losses) = store::session_match_tally(&conn, &session.local_id).unwrap();
        assert_eq!((wins, losses), (0, 0));
    }

    #[test]
    fn an_in_progress_match_is_excluded_from_recent_but_available_as_current() {
        let mut conn = test_conn();
        let now = Utc::now();
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        store::create_match(&conn, &session.local_id, Some("1"), 14, "radiant", RankedMode::Unknown, now).unwrap();

        let current = store::find_active_match(&conn, &session.local_id).unwrap();
        assert!(current.is_some());

        let recent = store::list_recent_matches(&conn, &session.local_id, RECENT_MATCHES_LIMIT).unwrap();
        let finalized_only: Vec<_> = recent.iter().filter(|m| !ACTIVE_STATES.contains(&m.state)).collect();
        assert!(finalized_only.is_empty(), "an in-progress match must not appear in the finalized recent-matches list");
    }
}
