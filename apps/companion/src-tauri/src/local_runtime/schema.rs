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
];

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    // WAL mode - the whole reason SQLite was chosen over JSON in
    // docs/research/wk-110-local-first-audit.md §9: a crash mid-write must
    // never leave a torn/half-written row. WAL also lets a future read-only
    // diagnostics/debug helper (see WK-111's "no new UI" constraint - use
    // diagnostics/log/test helpers instead) query the file while the GSI
    // thread holds the write connection open.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    let current_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let current_version = current_version.max(0) as usize;

    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current_version) {
        conn.execute_batch(migration)?;
        let next_version = (index + 1) as i64;
        conn.pragma_update(None, "user_version", next_version)?;
    }

    Ok(())
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
}
