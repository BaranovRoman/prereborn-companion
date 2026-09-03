// WK-114 - read-only projection of the local runtime for the Home page: the
// first thing outside `local_runtime` that ever needs LocalSession/LocalMatch
// data (previously only `lifecycle::status` exposed anything, and only the
// lifecycle state machine's own fields - see that module's doc comment).
// Purely additive: no new writes, no new tables, just two more SELECT-style
// queries (`store::list_recent_matches`/`store::session_match_tally`) composed
// into one DTO. Never touches sync/outbox/lifecycle decision-making.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use super::model::{LocalMatch, LocalMatchState, MatchResult, RankedMode};
use super::store;
use super::LocalRuntimeState;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalMatchSummary {
    // WK-115 - the Dashboard's per-match correction commands
    // (correct_local_match_delta/correct_local_match_ranked_mode) address a
    // row by this id; nothing before WK-115 needed to name a specific match
    // back to the backend.
    pub local_id: String,
    pub match_id: Option<String>,
    pub hero_id: i64,
    pub result: Option<MatchResult>,
    pub ranked_mode: RankedMode,
    // WK-115 - lets the Dashboard show "Unranked (corrected)"/offer a
    // revert action only when `ranked_mode != ranked_mode_detected`,
    // without a second frontend-only "was this corrected" flag.
    pub ranked_mode_detected: RankedMode,
    pub state: LocalMatchState,
    pub rating_before: Option<i64>,
    pub rating_after: Option<i64>,
    // WK-115 - immutable observed delta and the correction layered on top;
    // exposed so the Dashboard can derive the ×2 button's active state
    // (`detected_rating_delta != 0 && rating_delta_correction ==
    // detected_rating_delta`) instead of tracking a separate boolean.
    pub detected_rating_delta: Option<i64>,
    pub rating_delta_correction: i64,
    pub kills: Option<i64>,
    pub deaths: Option<i64>,
    pub assists: Option<i64>,
    pub inventory: Vec<Option<String>>,
    pub started_at: String,
    pub finalized_at: Option<String>,
}

impl From<&LocalMatch> for LocalMatchSummary {
    fn from(value: &LocalMatch) -> Self {
        Self {
            local_id: value.local_id.clone(),
            match_id: value.match_id.clone(),
            hero_id: value.hero_id,
            result: value.result,
            ranked_mode: value.ranked_mode,
            ranked_mode_detected: value.ranked_mode_detected,
            state: value.state,
            rating_before: value.rating_before,
            rating_after: value.rating_after,
            detected_rating_delta: value.detected_rating_delta,
            rating_delta_correction: value.rating_delta_correction,
            kills: value.kills,
            deaths: value.deaths,
            assists: value.assists,
            inventory: value.inventory.clone(),
            started_at: value.started_at.clone(),
            finalized_at: value.finalized_at.clone(),
        }
    }
}

// WK-140 - Hero Detail's local statistics zone. A distinct DTO/query from
// `LocalSessionSummary` on purpose: that one is session-scoped and its
// `recentMatches` is capped at 10 for the Главная feed, neither of which is
// the right shape for "how have I done on this hero across my whole local
// history" - see `store::hero_local_stats`'s own doc comment. Labeled
// explicitly as local/Companion-observed data (not lifetime Dota stats) at
// the call site in HeroDetailPage, per the task's semantics requirement -
// this DTO itself just carries the numbers.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeroLocalStats {
    pub matches: i64,
    pub wins: i64,
    pub losses: i64,
    pub avg_kills: Option<f64>,
    pub avg_deaths: Option<f64>,
    pub avg_assists: Option<f64>,
    /// Newest-first, at most `RECENT_RESULTS_LIMIT` entries.
    pub recent_results: Vec<MatchResult>,
}

const RECENT_RESULTS_LIMIT: i64 = 10;

/// Read-only, mirrors `get`'s "missing runtime -> empty DTO, never an error"
/// contract so a hero with no observed matches (or a runtime that failed to
/// open) renders the same quiet empty state instead of a special-cased error
/// path.
pub fn hero_stats<R: Runtime>(app: &AppHandle<R>, hero_id: i64) -> HeroLocalStats {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else {
        return HeroLocalStats {
            matches: 0,
            wins: 0,
            losses: 0,
            avg_kills: None,
            avg_deaths: None,
            avg_assists: None,
            recent_results: Vec::new(),
        };
    };
    let aggregate = store::hero_local_stats(conn, hero_id, RECENT_RESULTS_LIMIT).unwrap_or(store::HeroMatchAggregate {
        matches: 0,
        wins: 0,
        losses: 0,
        avg_kills: None,
        avg_deaths: None,
        avg_assists: None,
        recent_results: Vec::new(),
    });
    HeroLocalStats {
        matches: aggregate.matches,
        wins: aggregate.wins,
        losses: aggregate.losses,
        avg_kills: aggregate.avg_kills,
        avg_deaths: aggregate.avg_deaths,
        avg_assists: aggregate.avg_assists,
        recent_results: aggregate.recent_results,
    }
}

#[cfg(test)]
const ACTIVE_STATES: &[LocalMatchState] = &[
    LocalMatchState::InProgress,
    LocalMatchState::PostGamePending,
    LocalMatchState::Interrupted,
];

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionSummary {
    pub has_session: bool,
    pub started_at: Option<String>,
    pub rating_start: Option<i64>,
    pub rating_current: Option<i64>,
    pub rating_adjustment: i64,
    pub session_delta: Option<i64>,
    pub wins: i64,
    pub losses: i64,
    pub current_match: Option<LocalMatchSummary>,
    // Newest first, finalized matches only - the in-progress match (if any)
    // is `current_match` above, not repeated here.
    pub recent_matches: Vec<LocalMatchSummary>,
}

const RECENT_MATCHES_LIMIT: i64 = 30;
const RECENT_MATCHES_DISPLAY: usize = 10;

fn log_history_load<R: Runtime>(app: &AppHandle<R>, count: usize, current_session: Option<&str>) {
    let signature = format!("{count}:{current_session:?}");
    let should_log = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        if inner.last_history_log_signature.as_deref() == Some(&signature) {
            false
        } else {
            inner.last_history_log_signature = Some(signature);
            true
        }
    };
    if should_log {
        crate::storage::append_rolling_log(
            app,
            &format!("Local history loaded: matches={count} history_session_filter=none current_session={current_session:?}"),
        );
    }
}

/// Reads the currently open local session (if any) plus its recent match
/// history - never creates or mutates anything (mirrors `lifecycle::status`'s
/// read-only contract). Returns the empty/default summary if the local
/// runtime failed to open (see `local_runtime::init`'s doc comment: a
/// storage failure must leave the rest of Companion working, just with
/// nothing to show here) or if no session is currently open.
///
/// Generic over `R: Runtime` (same pattern as `overlay_server::current`) so
/// WK-121's overlay renderer payload - which reuses this exact function
/// rather than a second session-summary computation - can be exercised end
/// to end by `tauri::test::mock_app()` integration tests. Every existing
/// call site (`commands::get_local_session_summary`, `AppHandle` un-
/// parameterized = `AppHandle<Wry>`) keeps compiling unchanged.
pub fn get<R: Runtime>(app: &AppHandle<R>) -> LocalSessionSummary {
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else {
        return LocalSessionSummary::default();
    };
    let recent_matches: Vec<_> = store::list_recent_finalized_matches(conn, RECENT_MATCHES_LIMIT)
        .unwrap_or_default()
        .iter()
        .take(RECENT_MATCHES_DISPLAY)
        .map(LocalMatchSummary::from)
        .collect();
    let Some(session) = store::find_open_session(conn).ok().flatten() else {
        log_history_load(app, recent_matches.len(), None);
        return LocalSessionSummary {
            rating_current: store::get_current_rating(conn).ok().flatten(),
            recent_matches,
            ..LocalSessionSummary::default()
        };
    };

    let current_match = store::find_active_match(conn, &session.local_id)
        .ok()
        .flatten()
        .map(|m| LocalMatchSummary::from(&m));
    let (wins, losses) = store::session_match_tally(conn, &session.local_id).unwrap_or((0, 0));
    log_history_load(app, recent_matches.len(), Some(&session.local_id));

    LocalSessionSummary {
        has_session: true,
        started_at: Some(session.started_at),
        rating_start: session.rating_start,
        rating_current: session.rating_current,
        rating_adjustment: session.rating_adjustment,
        session_delta: match (session.rating_start, session.rating_current) {
            (Some(start), Some(current)) => Some(current - start - session.rating_adjustment),
            _ => None,
        },
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
