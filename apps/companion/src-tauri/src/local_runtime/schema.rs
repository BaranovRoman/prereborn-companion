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
}
