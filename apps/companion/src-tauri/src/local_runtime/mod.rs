// WK-111 - local durable runtime: a passive, crash-safe SQLite mirror of
// stream-session/match/MMR state, built entirely from the same local GSI
// stream `obs::handle_gsi`/`game_sounds::handle_gsi` already consume (see
// `server::process_gsi_body`). This module is a SHADOW MIRROR ONLY (see
// docs/research/wk-110-local-first-audit.md §11):
//
// - it runs *alongside* today's `backend::try_send_pending` GSI-forwarding,
//   never in place of it;
// - it never calls the backend, never reads `AppState`'s `backend_*`
//   fields, and never makes a network call of any kind - `handle_gsi`
//   below only ever touches the local SQLite connection this module owns;
// - it does not decide when a stream session starts/ends (that's WK-112,
//   OBS-driven lifecycle) - `ensure_active_session` only ever lazily
//   creates one if none is open yet, mirroring the backend's
//   `getOrCreateActiveSession`, and nothing here ever closes one;
// - it has no manual-correction workflow and no `CorrectionLedgerEntry` -
//   see model.rs's `RankedMode::Unknown` comment for why MMR tracking stays
//   inert until a future ticket sources the ranked/unranked toggle locally.
//
// See detector.rs's `match_transition_never_depends_on_backend_state` for
// the compiled-in regression test pinning the backend-independence
// guarantee, by direct analogy with Game Sounds'
// `playback_resolution_never_depends_on_backend_state`
// (game_sounds/mod.rs) - the reference architecture this module was built
// to match.

mod detector;
mod gsi;
pub mod lifecycle;
mod model;
mod schema;
mod store;
pub mod summary;
pub mod sync;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub struct LocalRuntimeState(Mutex<Option<Connection>>);

impl LocalRuntimeState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Convenience accessor used by `lifecycle.rs` (and anything else that
    /// needs the connection outside this file) - same lock, just without
    /// spelling out `.0.lock().unwrap()` at every call site.
    pub fn lock(&self) -> MutexGuard<'_, Option<Connection>> {
        self.0.lock().unwrap()
    }
}

impl Default for LocalRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

fn db_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app_data_dir must resolve")
        .join("local-runtime.sqlite3")
}

/// Opens (creating if needed) the local runtime's SQLite file and runs
/// migrations - called once from `lib.rs`'s `setup()`, same lifecycle
/// point as `game_sounds::init`/`hotkeys::init`. A failure here (corrupt
/// file, disk full, migration error) is logged and left as `None` rather
/// than panicking the whole app - WK-111's acceptance criteria explicitly
/// require that a local-runtime storage failure must not take down
/// Companion; the existing backend-driven runtime (GSI ingest, OBS
/// automation, backend forwarding - none of which read this state) keeps
/// working exactly as it does today with this module simply inert.
pub fn init(app: &AppHandle) {
    let path = db_path(app);
    if let Some(dir) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(dir) {
            crate::storage::append_rolling_log(
                app,
                &format!("Local runtime: could not create data dir ({error}); shadow mirror disabled this run."),
            );
            return;
        }
    }
    match Connection::open(&path).and_then(|conn| schema::migrate(&conn).map(|_| conn)) {
        Ok(conn) => {
            if let Ok(summary) = store::log_summary(&conn) {
                crate::storage::append_rolling_log(app, &format!("Local runtime: opened ({summary})"));
            }
            *app.state::<LocalRuntimeState>().0.lock().unwrap() = Some(conn);
        }
        Err(error) => {
            // Deliberately not a retry loop and not a delete-and-recreate
            // fallback - a corrupt local-runtime file is exactly the kind
            // of thing a human should look at once (it's a shadow mirror,
            // not load-bearing yet), not something Companion should ever
            // silently discard on its own.
            crate::storage::append_rolling_log(
                app,
                &format!("Local runtime: failed to open/migrate {path:?} ({error}); shadow mirror disabled this run."),
            );
        }
    }
}

/// Entry point called from `server::process_gsi_body`, alongside
/// `obs::handle_gsi`/`game_sounds::handle_gsi` - the one place raw GSI
/// reaches this feature. A no-op whenever `init` didn't manage to open the
/// local store (see above) - mirrors `diagnostics::observe`'s
/// "no-op unless active" shape.
pub fn handle_gsi(app: &AppHandle, payload: &Value) {
    let Some(snapshot) = gsi::parse(payload) else { return };
    let state = app.state::<LocalRuntimeState>();
    let mut guard = state.lock();
    let Some(conn) = guard.as_mut() else { return };

    // WK-113 - session CREATION is exclusively OBS-driven now (see
    // lifecycle::apply's StartNewSession branch, the only place
    // store::ensure_active_session is called). A bare GSI tick used to
    // lazily create one too (WK-111/112's shadow-mirror stage) - now that
    // creating a session must also durably enqueue a session_started sync
    // event, a GSI-triggered creation would bypass that entirely and would
    // never reach the backend. If OBS hasn't told the local lifecycle a
    // stream is live yet, there is nothing to attach this tick's match
    // detection to, and none is attempted.
    let session = match store::find_open_session(conn) {
        Ok(Some(session)) => session,
        Ok(None) => return,
        Err(error) => {
            crate::storage::append_rolling_log(app, &format!("Local runtime: find_open_session failed ({error})"));
            return;
        }
    };

    let now = chrono::Utc::now();
    let ranked_mode = sync::cached_ranked_mode(conn);
    if let Err(error) = detector::handle_snapshot(conn, &session.local_id, ranked_mode, &snapshot, now) {
        crate::storage::append_rolling_log(app, &format!("Local runtime: handle_snapshot failed ({error})"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_runtime::gsi::GsiSnapshot;
    use chrono::Utc;
    use tempfile::TempDir;

    fn open_at(dir: &TempDir) -> Connection {
        let path = dir.path().join("local-runtime.sqlite3");
        let conn = Connection::open(&path).unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    fn in_progress_tick(match_id: &str, hero_id: i64) -> GsiSnapshot {
        GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS".to_string(),
            activity: Some("playing".to_string()),
            custom_game_name: None,
            match_id: Some(match_id.to_string()),
            win_team: None,
            hero_id: Some(hero_id),
            team_name: Some("radiant".to_string()),
        }
    }

    // WK-111 acceptance criterion #2: Companion closed mid-match, reopened -
    // state must not be lost or corrupted. Simulated here by literally
    // closing the SQLite connection (dropping it) and reopening a fresh one
    // against the same on-disk file, exactly what happens across a real
    // process restart.
    #[test]
    fn crash_mid_match_then_restart_preserves_the_in_progress_match() {
        let dir = TempDir::new().unwrap();
        let now = Utc::now();

        {
            let mut conn = open_at(&dir);
            let session = store::ensure_active_session(&mut conn, now).unwrap();
            detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Unknown, &in_progress_tick("111", 14), now).unwrap();
            // Connection dropped here without any explicit close/flush call -
            // WAL mode (schema::migrate) is what makes this safe.
        }

        let mut conn = open_at(&dir);
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        let active = store::find_active_match(&conn, &session.local_id).unwrap();
        assert!(active.is_some(), "the in-progress match must survive a Companion restart");
        assert_eq!(active.unwrap().state, model::LocalMatchState::InProgress);
    }

    // WK-111 acceptance criterion #3: backend unreachable for the whole
    // match - nothing in this test ever touches a network type, only the
    // local SQLite connection, proving the local match is fully created,
    // tracked, and finalized without any backend involvement at all.
    #[test]
    fn backend_offline_for_the_entire_match_still_produces_a_correctly_finalized_local_match() {
        let dir = TempDir::new().unwrap();
        let now = Utc::now();
        let mut conn = open_at(&dir);
        let session = store::ensure_active_session(&mut conn, now).unwrap();

        detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Ranked, &in_progress_tick("222", 14), now).unwrap();
        let post_game = GsiSnapshot {
            game_state: "DOTA_GAMERULES_STATE_POST_GAME".to_string(),
            activity: Some("playing".to_string()),
            custom_game_name: None,
            match_id: Some("222".to_string()),
            win_team: Some("radiant".to_string()),
            hero_id: Some(14),
            team_name: Some("radiant".to_string()),
        };
        detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Ranked, &post_game, now).unwrap();
        detector::handle_snapshot(&mut conn, &session.local_id, model::RankedMode::Ranked, &post_game, now).unwrap();

        let (state, result): (String, String) = conn
            .query_row("SELECT state, result FROM local_matches WHERE match_id = '222'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(state, "finalized");
        assert_eq!(result, "win");
    }

    // WK-111 acceptance criterion #5: restart between matches must keep the
    // session's rating fields as they were (not reset local_id/rating on
    // every reopen).
    #[test]
    fn restart_between_matches_keeps_the_same_session_and_its_rating() {
        let dir = TempDir::new().unwrap();
        let now = Utc::now();

        let session_id = {
            let mut conn = open_at(&dir);
            let session = store::ensure_active_session(&mut conn, now).unwrap();
            conn.execute(
                "UPDATE local_sessions SET rating_current = 6050 WHERE local_id = ?1",
                [&session.local_id],
            )
            .unwrap();
            session.local_id
        };

        let mut conn = open_at(&dir);
        let session = store::ensure_active_session(&mut conn, now).unwrap();
        assert_eq!(session.local_id, session_id);
        assert_eq!(session.rating_current, Some(6050));
    }
}
