use rusqlite::Connection;

/// Ordered list of migrations. Each entry is the SQL that takes the schema
/// from version `index` to version `index + 1` - `migrate` below applies
/// only the ones a given (possibly pre-existing) database file hasn't seen
/// yet, tracked via SQLite's own `PRAGMA user_version` (an integer baked
/// into the file header - no extra bookkeeping table needed, and it's the
/// same mechanism this project's own docs/research/wk-110-local-first-audit.md
/// §9 compared against `apps/api/src/db/migrate.ts`'s `IF NOT EXISTS` style
/// for Postgres). Appending a new migration for a future change is safe on
/// an existing install; rewriting an already-shipped entry is not.
const MIGRATIONS: &[&str] = &[
    // v0 -> v1
    r#"
    CREATE TABLE local_sessions (
        local_id        TEXT PRIMARY KEY,
        backend_id      TEXT,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        rating_start    INTEGER,
        rating_current  INTEGER,
        sync_state      TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE local_matches (
        local_id              TEXT PRIMARY KEY,
        session_local_id      TEXT NOT NULL REFERENCES local_sessions(local_id),
        backend_id            TEXT,
        match_id              TEXT,
        match_key             TEXT NOT NULL,
        hero_id               INTEGER NOT NULL,
        player_team           TEXT NOT NULL,
        result                TEXT,
        ranked_mode           TEXT NOT NULL DEFAULT 'unknown',
        rating_before         INTEGER,
        detected_rating_delta INTEGER,
        rating_after          INTEGER,
        state                 TEXT NOT NULL,
        started_at            TEXT NOT NULL,
        interrupted_at        TEXT,
        finalized_at          TEXT,
        sync_state            TEXT NOT NULL DEFAULT 'pending',
        UNIQUE (session_local_id, match_key)
    );

    -- One query per GSI tick (find_active_match) - state is nearly
    -- unselective (almost every row ends up finalized/needs_review) but
    -- session_local_id narrows it to "this stream" first, and only a
    -- handful of rows per session are ever in an active state at once.
    CREATE INDEX idx_local_matches_active
        ON local_matches (session_local_id, state);
    "#,
    // v1 -> v2 (WK-112) - OBS-driven lifecycle. `pending_end_at` is the
    // durable form of the 30s "Stop Streaming" grace countdown: it is
    // committed to disk the moment the grace period begins, so a Companion
    // crash/restart mid-countdown reconciles from this column plus a fresh
    // `GetStreamStatus` call (see lifecycle.rs), never from an in-memory
    // timer that could have silently stopped ticking. `stale_ack` records
    // that the user explicitly chose "continue this session" during
    // stale-session manual recovery (see lifecycle::is_stale) - without it,
    // a legitimately long-running stream the user already confirmed would
    // otherwise re-trigger the same recovery prompt on every reconciliation
    // tick.
    r#"
    ALTER TABLE local_sessions ADD COLUMN pending_end_at TEXT;
    ALTER TABLE local_sessions ADD COLUMN stale_ack INTEGER NOT NULL DEFAULT 0;
    "#,
    // v2 -> v3 (WK-113) - durable transactional outbox for backend sync,
    // plus a small key/value table for sync bookkeeping (the cutover marker,
    // the corrections-pull cursor, the cached ranked/unranked toggle - see
    // local_runtime::sync). `sync_outbox` rows are written in the SAME
    // SQLite transaction as the local_sessions/local_matches mutation they
    // describe (see store.rs's ensure_active_session/finalize_session_end/
    // finalize_match) - this is what makes "entity changed" and "sync event
    // recorded" atomic, per the ticket's requirement, without needing a
    // second storage system. `delivered_at`/`failed_at` are mutually
    // exclusive terminal markers (successfully applied vs. permanently
    // rejected by the backend, e.g. a 4xx) - a row with both NULL is still
    // pending/retrying. No FOREIGN KEY to local_sessions/local_matches:
    // entity_local_id intentionally outlives the entity it describes (rows
    // are retained for a bounded window after delivery for
    // observability/debugging, see sync::PURGE_AFTER, then swept) - a hard
    // FK would fight that retention model for no benefit.
    r#"
    CREATE TABLE sync_outbox (
        id              TEXT PRIMARY KEY,
        entity_type     TEXT NOT NULL,
        entity_local_id TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        delivered_at    TEXT,
        failed_at       TEXT
    );

    CREATE INDEX idx_sync_outbox_pending
        ON sync_outbox (delivered_at, failed_at, next_attempt_at);

    CREATE TABLE sync_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- Mirrors stream_matches.rating_delta_correction on the backend
    -- (WK-105): the diff a server-originated correction applies ON TOP OF
    -- detected_rating_delta, never overwriting it - see
    -- local_runtime::sync's apply_one_correction, the only writer. DEFAULT 0
    -- means "never corrected" for every existing row, exactly like the
    -- backend's own DEFAULT 0 (migrate.ts) meant the same thing there.
    ALTER TABLE local_matches ADD COLUMN rating_delta_correction INTEGER NOT NULL DEFAULT 0;
    "#,
    // v3 -> v4 - local-first equivalent of WK-105's absolute Current MMR
    // correction. The adjustment is session-level bookkeeping only: match
    // rating_before/rating_after/detected_rating_delta rows remain immutable,
    // while `rating_current - rating_start - rating_adjustment` continues to
    // mean "MMR earned/lost through finalized matches in this session".
    r#"
    ALTER TABLE local_sessions ADD COLUMN rating_adjustment INTEGER NOT NULL DEFAULT 0;
    "#,
    // v4 -> v5 - production Between Matches needs the same finalized-match
    // KDA/main-inventory/backpack data the Web overlay already reads from
    // GSI. Nullable KDA preserves "not observed" for existing rows; the
    // nine-slot JSON array maps directly to Dota's slot0..slot8.
    r#"
    ALTER TABLE local_matches ADD COLUMN kills INTEGER;
    ALTER TABLE local_matches ADD COLUMN deaths INTEGER;
    ALTER TABLE local_matches ADD COLUMN assists INTEGER;
    ALTER TABLE local_matches ADD COLUMN inventory TEXT NOT NULL DEFAULT '[]';
    "#,
    // v5 -> v6 (WK-115) - the Home dashboard's per-match Ranked/Unranked
    // correction needs to remember what was actually detected (GSI/account
    // setting, "unknown" by default per model::RankedMode's doc comment) so
    // an Unranked correction is reversible back to the real original value,
    // not hardcoded back to "ranked". Mirrors the
    // detected_rating_delta/rating_delta_correction split already on this
    // table: `ranked_mode` becomes the authoritative/correctable column,
    // `ranked_mode_detected` never changes once written. Backfilled from
    // the existing `ranked_mode` column - every pre-existing row's stored
    // value IS what was detected, since no writer has ever corrected
    // `ranked_mode` before this migration.
    r#"
    ALTER TABLE local_matches ADD COLUMN ranked_mode_detected TEXT NOT NULL DEFAULT 'unknown';
    UPDATE local_matches SET ranked_mode_detected = ranked_mode;
    "#,
];

/// WK-127 - applies one migration's DDL/DML and its `user_version` bump as a
/// single atomic unit: `BEGIN` up front, `COMMIT` only if both the migration
/// body and the version bump succeed, `ROLLBACK` (best-effort - the
/// connection is about to be treated as failed either way, see `migrate`'s
/// caller) on any error in between. Before this, `migrate` ran a migration's
/// `execute_batch` and its separate `pragma_update(user_version)` call as two
/// independent statements with no enclosing transaction - a crash/power-loss
/// between them (or mid-batch, since `execute_batch` alone does not wrap
/// multiple DDL statements in a transaction) could leave the schema
/// partially applied while `user_version` still read the OLD value, so the
/// next startup would replay the same migration SQL against an
/// already-partially-migrated schema and hit "table already exists"/
/// "duplicate column" - bricking the local runtime on restart instead of
/// safely retrying. SQLite supports fully transactional DDL (unlike some
/// other engines), and `PRAGMA user_version` is just an ordinary write to
/// the database header, so wrapping both in one transaction is enough - no
/// second bookkeeping table needed.
fn apply_migration(conn: &Connection, sql: &str, next_version: i64) -> rusqlite::Result<()> {
    conn.execute_batch("BEGIN;")?;
    let applied = conn.execute_batch(sql).and_then(|_| conn.execute_batch(&format!("PRAGMA user_version = {next_version};")));
    match applied {
        Ok(()) => conn.execute_batch("COMMIT;"),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

/// Returns the journal mode SQLite actually engaged (normally `"wal"`) so
/// the caller can log/surface it if the environment silently couldn't honor
/// WAL (e.g. some network-redirected profile directories don't support the
/// shared-memory file WAL needs, and SQLite falls back to a rollback journal
/// without erroring) - see this module's own top comment for why WAL is the
/// crash-safety property the local runtime depends on. Plain `pragma_update`
/// (used for every other pragma here) discards PRAGMA's own returned row, so
/// a silent fallback would previously have gone completely unnoticed.
pub fn migrate(conn: &Connection) -> rusqlite::Result<String> {
    let journal_mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // WK-127 - native SQLite bound on how long a call waits for the
    // connection's lock instead of failing immediately with SQLITE_BUSY.
    // Not currently load-bearing (there is exactly one `rusqlite::Connection`
    // per process - see `LocalRuntimeState` - and `tauri_plugin_single_instance`
    // is registered before anything opens SQLite, so no second process ever
    // reaches this file either), but it's a zero-cost, SQLite-native
    // safeguard against a future second connection (e.g. a manual read-only
    // diagnostics tool) hitting an immediate hard failure instead of a
    // bounded wait - see the ticket's explicit preference for the built-in
    // mechanism over an application-level retry loop.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    let current_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let current_version = current_version.max(0) as usize;

    // WK-127 - a `user_version` newer than this binary's own migration list
    // means the file was last written by a newer Companion build (or
    // corrupted/tampered into claiming one). Silently proceeding used to
    // mean `.skip(current_version)` simply skipped every migration and
    // returned `Ok(())`, leaving an old binary reading/writing a schema it
    // does not understand - exactly what the ticket calls out as
    // unacceptable. Refusing here routes into the SAME "open/migrate
    // failed" error path `local_runtime::init` already has for a corrupt
    // file (log once, leave the connection `None`, rest of Companion keeps
    // working) - no new failure mode, just a new reason to take the
    // existing one.
    if current_version > MIGRATIONS.len() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
            Some(format!(
                "local-runtime.sqlite3 schema version {current_version} is newer than this Companion build understands (supports up to {}) - refusing to open it",
                MIGRATIONS.len()
            )),
        ));
    }

    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current_version) {
        let next_version = (index + 1) as i64;
        apply_migration(conn, migration, next_version)?;
    }

    Ok(journal_mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_migrates_to_the_latest_version() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }

    #[test]
    fn migrating_twice_is_a_safe_no_op() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Re-running against an already-migrated connection (simulates
        // reopening an existing db file on a later Companion startup) must
        // not try to re-create tables that already exist.
        migrate(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }

    #[test]
    fn tables_are_queryable_after_migration() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO local_sessions (local_id, started_at) VALUES ('s1', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn existing_v4_database_adds_match_telemetry_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().take(4) {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 4).unwrap();
        conn.execute("INSERT INTO local_sessions (local_id, started_at) VALUES ('s1', '2026-01-01T00:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO local_matches (local_id, session_local_id, match_key, hero_id, player_team, state, started_at) VALUES ('m1', 's1', 'gsi:1', 14, 'radiant', 'finalized', '2026-01-01T00:00:00Z')", []).unwrap();

        migrate(&conn).unwrap();
        let row: (Option<i64>, String) = conn.query_row(
            "SELECT kills, inventory FROM local_matches WHERE local_id = 'm1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(row, (None, "[]".to_string()));
    }

    #[test]
    fn existing_v5_database_backfills_ranked_mode_detected_from_ranked_mode() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().take(5) {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 5).unwrap();
        conn.execute("INSERT INTO local_sessions (local_id, started_at) VALUES ('s1', '2026-01-01T00:00:00Z')", []).unwrap();
        conn.execute(
            "INSERT INTO local_matches (local_id, session_local_id, match_key, hero_id, player_team, ranked_mode, state, started_at) \
             VALUES ('m1', 's1', 'gsi:1', 14, 'radiant', 'ranked', 'finalized', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();
        let detected: String = conn
            .query_row("SELECT ranked_mode_detected FROM local_matches WHERE local_id = 'm1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(detected, "ranked", "a pre-existing row's already-stored ranked_mode is what was actually detected");
    }

    // WK-127 - `migrate` reports the journal mode SQLite actually engaged so
    // a silent WAL fallback (e.g. an environment that can't honor it) is
    // detectable instead of assumed. On every normal desktop filesystem this
    // is "wal".
    #[test]
    fn migrate_reports_wal_as_the_actually_applied_journal_mode() {
        // WAL needs a real file on disk (SQLite can't honor it for an
        // in-memory database - an in-memory `Connection::open_in_memory()`
        // reports back "memory" regardless, which is `migrate`'s WAL-
        // verification working correctly, not a bug in it).
        let temp = tempfile::NamedTempFile::new().unwrap();
        let conn = Connection::open(temp.path()).unwrap();
        let journal_mode = migrate(&conn).unwrap();
        assert_eq!(journal_mode.to_lowercase(), "wal");
    }

    #[test]
    fn migrate_sets_a_nonzero_busy_timeout() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let timeout_ms: i64 = conn.query_row("PRAGMA busy_timeout", [], |row| row.get(0)).unwrap();
        assert!(timeout_ms > 0, "busy_timeout must be set to a nonzero value, got {timeout_ms}");
    }

    // WK-127 P1 - a `user_version` newer than this binary's migration list
    // must be rejected outright, not silently skipped past (see `migrate`'s
    // own doc comment for the risk of an old binary using an unknown schema).
    #[test]
    fn a_future_schema_version_is_rejected_not_silently_skipped() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.pragma_update(None, "user_version", (MIGRATIONS.len() + 1) as i64).unwrap();

        let result = migrate(&conn);
        assert!(result.is_err(), "opening a DB with a newer-than-understood schema version must fail, not silently proceed");
    }

    // WK-127 P1 - `apply_migration` is what makes each migration step
    // atomic: its DDL/DML and the `user_version` bump either both land or
    // neither does. A malformed migration body must leave `user_version`
    // exactly where it was, so a retry on next startup replays the SAME
    // migration from a clean slate instead of hitting "table already
    // exists" against a half-applied schema.
    #[test]
    fn apply_migration_leaves_user_version_untouched_when_the_migration_body_fails() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();

        let result = apply_migration(&conn, "CREATE TABLE this_is_not_valid_sql_!!!", 1);
        assert!(result.is_err());

        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 0, "a failed migration body must not advance user_version");
    }

    #[test]
    fn apply_migration_leaves_no_partial_ddl_behind_when_the_migration_body_fails_partway() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();

        // First statement succeeds, second is malformed - if `apply_migration`
        // weren't transactional, `survives` would exist despite the overall
        // migration having "failed".
        let result = apply_migration(&conn, "CREATE TABLE survives (id INTEGER); THIS IS NOT SQL;", 1);
        assert!(result.is_err());

        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'survives'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 0, "a failed migration must roll back every statement it already applied, not just skip the version bump");

        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 0);
    }

    #[test]
    fn apply_migration_commits_both_the_ddl_and_the_version_bump_together() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();

        apply_migration(&conn, "CREATE TABLE both_or_nothing (id INTEGER);", 1).unwrap();

        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'both_or_nothing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 1);
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 1);
    }
}
