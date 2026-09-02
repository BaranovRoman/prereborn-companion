# WK-127: SQLite runtime maintenance / integrity audit

## Question

Is `local-runtime.sqlite3` — the authoritative local store for stream sessions, matches, MMR/
corrections and the sync outbox since WK-111/112/113 — safe and durable enough for long-running
production use? Per the ticket's explicit framing: **audit first**, fix only confirmed or
sufficiently realistic operational gaps, do not build a "SQLite platform."

## Non-goals (per ticket scope)

- No match/MMR business-semantics changes, no rewrite of WK-123's cascade reanchor.
- No backup/restore subsystem, no scheduled `VACUUM`, no startup `integrity_check` — unless the
  audit found a concrete reason (it didn't; see §12–14).
- No logging/retention work (WK-128), no failure/reconnect beta matrix (WK-130).
- No repository/refactoring pass — every change here is scoped to `local_runtime/schema.rs`,
  `local_runtime/mod.rs`, and `runtime_health.rs`.

---

## 1. Architecture as it actually is (read from code, not from older docs)

`local-runtime.sqlite3` lives at `app.path().app_data_dir()/local-runtime.sqlite3`
(`local_runtime/mod.rs::db_path`) — the OS-standard per-user app data directory, never inside the
repo, never on a path that diagnostics export scoops up wholesale (see §19/§23).

**Connection ownership.** Exactly one `rusqlite::Connection` is ever opened in production:
`local_runtime::init` (called once from `lib.rs::setup()`) opens it and stores it in
`LocalRuntimeState(Mutex<Option<Connection>>)`, a Tauri-managed singleton. Every read and write in
the whole module — GSI ingest (`handle_gsi`), lifecycle sweeps, Home/Between-Matches reads
(`summary::get`), Dashboard corrections, the sync worker's outbox drain — goes through
`state.lock()` on that same `Mutex`. A repo-wide grep for `Connection::open`/`open_in_memory`
confirms this: every other call site is inside `#[cfg(test)]`.

**Concurrency model, in one line:** one process (guarded — see below), one connection, one mutex.
There is no scenario in the current codebase where two `rusqlite::Connection`s to this file exist
at the same time.

**Single-instance boundary.** `tauri_plugin_single_instance` is registered as the *first* plugin in
`lib.rs::run()` — its own doc comment confirms (and the plugin's source was read to verify) that it
calls `std::process::exit(0)` synchronously on a second launch, before Tauri runs any other plugin's
`setup()` or the app's own `.setup()` closure. A second Companion process therefore **never reaches
`local_runtime::init`**, i.e. never opens SQLite at all. SQLite is not, and does not need to be, an
implicit single-instance lock — the OS-level guard already exists one layer up.

**Transaction boundaries.** Every store.rs mutation that must be atomic already uses an explicit
`conn.transaction()`:
- `ensure_active_session` — session insert + `session_started` outbox enqueue, one transaction.
- `finalize_session_end` — session end + `session_ended` outbox enqueue (only on real state change).
- `finalize_match` — match finalize + session rating update + `match_finalized` outbox enqueue.
- `correct_match_delta` / `correct_match_ranked_mode` — the correction write + `cascade_reanchor`
  (WK-123's forward walk through every later session) in one transaction each.
- `set_current_rating` — session update + device-wide rating snapshot.

Single-statement mutations (`mark_interrupted`, `resume_match`, `begin_pending_end`, …) need no
explicit transaction — SQLite auto-commits a lone statement, and there's no second write to keep in
lock-step with it.

**Migrations.** `local_runtime/schema.rs` keeps an ordered `MIGRATIONS: &[&str]` array and tracks
progress in SQLite's own `PRAGMA user_version` (no separate bookkeeping table). `migrate()` runs on
every `init()`, applying whichever migrations the file hasn't seen yet.

**Startup/shutdown/error handling.** `init()` treats an open/migrate failure (corrupt file, disk
full, unsupported future schema — see §11) as non-fatal to the rest of Companion: it logs once to
`app.log` and leaves `LocalRuntimeState` at `None`. Every call site downstream already tolerates
that (`summary::get` returns the default/empty summary, `sync::status` returns an all-zero status,
GSI ticks are silently no-ops) — this was already correct going into this audit and needed no
changes. There is no explicit "shutdown" step: the connection is simply dropped at process exit,
and WAL is what makes that safe (see §5) — this is exercised directly by
`crash_mid_match_then_restart_preserves_the_in_progress_match` and
`pending_outbox_rows_survive_a_crash_and_restart`, which drop the connection with no explicit
close/flush and reopen against the same file.

**`sync_outbox` interaction.** `sync::enqueue` takes only an already-open `Transaction` — it is
called from *inside* the same transaction as the domain mutation it describes (see the list above),
never separately. The background sync worker (`start_sync_worker`) drains the outbox on its own
2s-tick loop, strictly in FIFO order, stopping at the first row that needs a retry (preserves
delivery ordering without a second ordering mechanism).

---

## 2. Database ownership / concurrency model

```
┌─────────────────────────────────────────────────────────────┐
│ OS process (tauri_plugin_single_instance blocks a 2nd one)   │
│                                                                │
│  LocalRuntimeState = Mutex<Option<Connection>>  (ONE handle) │
│                                                                │
│  GSI thread ──┐                                               │
│  lifecycle    ├─► guard = state.lock()  (short critical       │
│    sweep      │     section: SQL only, never network I/O)     │
│  Home/Dash    │                                                │
│    reads      │                                                │
│  sync worker ─┘   drops the guard BEFORE any blocking HTTP    │
│                    call (drain_outbox explicitly `drop(guard)`│
│                    before `send_event`) - re-acquires after   │
└─────────────────────────────────────────────────────────────┘
```

- **How many connections can exist at once:** one, always.
- **Across threads:** yes — GSI, lifecycle sweep, and the sync worker are different OS threads, all
  serialized through the same `Mutex`.
- **GSI mutation vs. sync worker:** cannot race at the SQL level (same mutex); `sync.rs`'s own
  regression test (`outbox_enqueue_never_depends_on_backend_state`) plus a direct read of
  `drain_outbox` confirms the lock is dropped before the blocking `reqwest` call and re-acquired
  only after it returns.
- **Correction vs. match finalization:** both take the same mutex; whichever arrives first fully
  commits (or rolls back) before the other's transaction begins.
- **Diagnostics/read vs. write:** `summary::get`, `sync::status`, and the new
  `PRAGMA user_version` read in `runtime_health::compute` (§20) all go through the same mutex —
  never a second, concurrently-opened connection.
- **SQLITE_BUSY / SQLITE_LOCKED:** structurally unreachable today (one process, one connection).
  Not fixed with a retry loop — see §4.
- **Long transactions / transaction held across network I/O:** none found. Every `tx` in store.rs
  spans only SQL statements between `conn.transaction()` and `.commit()`; `drain_outbox` explicitly
  releases the connection guard before its one blocking HTTP call.
- **Nested transactions:** none — `cascade_reanchor`/`reanchor_session` always run on a `&Transaction`
  handed down from the caller, never open one of their own (would be a compile error in rusqlite's
  API anyway: `Connection::transaction()` needs `&mut Connection`, incompatible with an
  already-borrowed `Transaction`).

**Conclusion: no real ownership/concurrency problem exists.** The architecture already enforces
single-writer-single-connection by construction, and the one thing that could have created a second
implicit access path (a diagnostics read opening its own connection) doesn't — it reuses the shared
`Mutex`.

---

## 3. PRAGMA audit

| Pragma | Before WK-127 | After WK-127 | Why |
|---|---|---|---|
| `journal_mode` | Set via `pragma_update(None, "journal_mode", "WAL")`, **return value discarded** | Set via `pragma_update_and_check`, actual applied mode captured and returned from `migrate()`; `init()` logs a line if it isn't `"wal"` | `pragma_update` silently ignores what SQLite actually did. An in-memory DB, for example, always reports back `"memory"` regardless of what's requested (confirmed directly — see the new `migrate_reports_wal_as_the_actually_applied_journal_mode` test) - and some unusual real-world filesystems (network-redirected profile directories) can't honor WAL either. WAL is the one property the whole crash-safety story depends on (see schema.rs's own top comment); a silent fallback going undetected was a real, if narrow, gap. |
| `synchronous` | SQLite default (`FULL` under a rollback journal, effectively `NORMAL`-equivalent safety under WAL) | **Unchanged** | WAL's default `synchronous=NORMAL` already guarantees the database file itself can never be corrupted by an OS crash/power loss (only the last few WAL-only commits could be lost, not corrupted) — exactly the property this module's crash-safety tests exercise. Companion's write rate (a handful of writes per match, not per GSI tick) doesn't justify overriding this. |
| `busy_timeout` | Not set (default `0` — immediate `SQLITE_BUSY`) | `conn.busy_timeout(Duration::from_secs(5))` | Not currently load-bearing (§2: no contention path exists). Added anyway as a zero-cost, SQLite-native safeguard — cheap insurance against a *future* second connection (e.g. a manual diagnostics tool, §21) hitting a hard failure instead of a bounded wait. This is the native mechanism the ticket explicitly prefers over an application-level retry loop. |
| `foreign_keys` | `ON` | **Unchanged** | Already correct; `local_matches.session_local_id REFERENCES local_sessions` is the only FK, and it's enforced. |
| `user_version` | Tracked, but a `user_version` newer than `MIGRATIONS.len()` was silently ignored (see §9) | Rejected with a clear error before any migration runs | See §9/§11. |

`synchronous` was deliberately **not** touched — no evidence a stronger setting is needed, and
`OFF` was never on the table (would reintroduce exactly the corruption risk WAL was chosen to
prevent).

---

## 4. Busy timeout

Real contention is structurally impossible today (§2), so there was no bug to fix here. A
`busy_timeout` of 5s was set anyway as native, zero-cost hardening (see §3's table) — not an
application-level retry loop layered on top of SQLite, per the ticket's explicit preference. No
contention test was added: fabricating realistic multi-connection contention against a codebase
that structurally only ever opens one connection would be a mocked/synthetic test with no
production analogue, which the ticket explicitly warns against ("не воспроизводить нереалистичную
concurrency").

---

## 5. WAL / checkpoint

- **WAL is enabled** (`journal_mode = WAL`, now verified — see §3).
- **Checkpoint strategy:** SQLite's own default auto-checkpoint (WAL file reaches ~1000 pages ⇒
  automatic `PASSIVE` checkpoint back into the main DB file). Companion sets no custom
  `wal_autocheckpoint` and runs no manual checkpoint timer.
- **Can the WAL grow unboundedly?** Only if something holds a read transaction open indefinitely
  (blocks checkpointing) or writes are frequent enough to outrun the default 1000-page threshold.
  Neither applies: every read in this module is `query_row`/`prepare().query_map()` — single
  round-trip, no held read transaction — and writes happen at match/session cadence (a handful of
  transactions per match, not per GSI tick; GSI-tick-frequency telemetry updates
  (`update_match_telemetry`) are simple auto-committed single statements, not held transactions
  either).
- **After a crash:** WAL replay on next open is entirely SQLite's own built-in recovery — nothing
  Companion-specific to verify beyond "the file still opens and the data is there," which
  `crash_mid_match_then_restart_preserves_the_in_progress_match` and
  `pending_outbox_rows_survive_a_crash_and_restart` already cover.

**Conclusion: SQLite's default auto-checkpoint is sufficient for Companion's write rate. No manual
checkpoint timer was added** — there is no growth scenario in evidence that would justify one.

---

## 6. Database growth estimate

`local_matches`/`local_sessions` rows are small (a few dozen scalar columns, no blobs; `inventory`
is a short JSON array of ≤9 short strings). Rough order-of-magnitude, including indexes:

| Matches | Approx. main DB size |
|---|---|
| 100 | well under 1 MB |
| 1,000 | ~1–2 MB |
| 10,000 (the §24 sanity scale) | ~10–20 MB |
| A year of active streaming (a few thousand matches) | low single-digit MB |

This was directly observed while seeding the §25 longevity test (1,250 matches/50 sessions) — no
academic precision needed, just confirmation there is no practical growth problem at any realistic
Companion lifetime. **No retention was added for `local_sessions`/`local_matches`** — there is no
product requirement for it, and match/session history is exactly the durable record this module
exists to keep.

---

## 7. `sync_outbox` retention

This was **already correctly bounded before WK-127** — re-confirmed, not newly built:

- `delivered_at`/`failed_at` are mutually exclusive terminal markers; a row with both `NULL` is
  still pending/retrying (`next_pending`'s own `WHERE` clause).
- `purge_delivered` (`sync.rs`) deletes rows where `delivered_at`/`failed_at` predates
  `RETENTION = Duration::days(7)`, run every `PURGE_EVERY_TICKS` (~1h) from the same background
  worker that drains the outbox.
- Dead-lettered (permanently rejected, e.g. 4xx) rows are swept by the same query — they don't grow
  unboundedly either.
- The 7-day window exists specifically for observability/debugging (a support investigation into
  "did this match sync?" within a reasonable window), per `schema.rs`'s own migration comment.

No change was needed here; `purge_removes_only_old_terminal_rows` already covers it.

---

## 8. Index audit

`EXPLAIN QUERY PLAN` against the real schema for every hot query:

| Query (call site) | Plan | Verdict |
|---|---|---|
| `find_active_match` (every GSI tick) | `SEARCH local_matches USING INDEX idx_local_matches_active (session_local_id=? AND state=?)` | Indexed, correct. |
| `next_pending` (sync drain, every 2s tick) | `SEARCH sync_outbox USING INDEX idx_sync_outbox_pending (...)` | Indexed, correct. |
| `find_match`/`correct_match_delta` (by `local_id`) | `SEARCH local_matches USING INDEX sqlite_autoindex_local_matches_1 (local_id=?)` | Primary key, no extra index needed. |
| `find_open_session` (every GSI tick + lifecycle sweep) | `SCAN local_sessions` (no index on `ended_at`) | **Not indexed, and intentionally left that way** — see below. |
| `list_recent_finalized_matches` (Home/Between Matches) | `SCAN local_matches` (no index on `state` alone) | **Not indexed, and intentionally left that way** — see below. |

Why the two full scans are fine: `local_sessions` gets one new row per stream, realistically
low-thousands of rows over a year — a full scan of that is microseconds. `local_matches` filtered
by `state='finalized'` ordered by `rowid DESC LIMIT N` is a **reverse rowid scan**, not a sorted
scan (no temp b-tree was needed in the `EXPLAIN` output) — it walks backward from the newest row
and stops the moment it collects `N` matches, which in practice is almost immediate since the vast
majority of rows are already finalized. The §25 longevity test measured this directly against
1,250 seeded matches with no observable cost. **No new index was added** — there is no scan/problem
to fix, and an index here would only add write cost and file size for zero measured benefit.

---

## 9/10/11. Migration safety, atomicity, and future-schema handling

**Two real findings, both fixed:**

### P1 — Migration atomicity (fixed)

Before: `migrate()` ran a migration's `conn.execute_batch(sql)` and its separate
`conn.pragma_update(user_version, N)` as two independent statements with **no enclosing
transaction**. `execute_batch` alone does not wrap multiple DDL statements in a transaction either.
A crash/power-loss between the two calls — or mid-`execute_batch`, for any migration with more than
one statement (several of them have 2–4) — could leave the schema partially applied while
`user_version` still read the OLD value. The next startup would then replay the *same* migration
SQL against an already-partially-migrated schema and hit `"table already exists"` /
`"duplicate column name"` — bricking the local runtime on restart instead of safely retrying.

Fix: `apply_migration()` now wraps each migration's SQL **and** its `user_version` bump in one
explicit `BEGIN ... COMMIT` (with an explicit `ROLLBACK` on any failure in between). SQLite supports
fully transactional DDL (unlike some other engines) and `PRAGMA user_version` is an ordinary write
to the database header — both commit or neither does, no second bookkeeping table needed.

Regression tests added (`schema.rs`):
- `apply_migration_leaves_user_version_untouched_when_the_migration_body_fails`
- `apply_migration_leaves_no_partial_ddl_behind_when_the_migration_body_fails_partway`
- `apply_migration_commits_both_the_ddl_and_the_version_bump_together`

### P1 — Future-schema guard (fixed)

Before: if `user_version` in the file was **higher** than `MIGRATIONS.len()` (a file last written by
a newer Companion build, a downgrade, or corruption), `migrate()`'s `.skip(current_version)` loop
simply skipped every migration and returned `Ok(())` — an old binary would silently proceed to
read/write a schema it doesn't understand.

Fix: `migrate()` now checks `current_version > MIGRATIONS.len()` up front and returns
`Err(SqliteFailure(..., "schema version N is newer than this build understands"))` before touching
anything. This routes into the **same** "open/migrate failed" path `local_runtime::init` already had
for a corrupt file — log once, leave `LocalRuntimeState` at `None`, rest of Companion keeps working.
No new failure mode was introduced, just a new (and previously silent) reason to take the existing
one.

Regression test: `a_future_schema_version_is_rejected_not_silently_skipped`.

**Every other migration-safety property was already correct and needed no change:**
sequential `user_version` behavior, idempotency on an already-migrated DB
(`migrating_twice_is_a_safe_no_op`), and backfill-on-migrate correctness for existing rows
(`existing_v4_database_adds_match_telemetry_without_losing_rows`,
`existing_v5_database_backfills_ranked_mode_detected_from_ranked_mode`) were already tested and
pass unchanged. No downgrade migrations exist or were added, per the ticket's explicit rule.

---

## 12/13/14. Corruption policy, `integrity_check`, `VACUUM`

**Corruption policy — already correct, confirmed not changed:** `init()`'s failure path was already
"log once, leave the connection `None`, never delete/recreate/salvage the file" before this ticket
— re-read and re-confirmed, not modified. This is exactly what the ticket calls for: the original
file is preserved as evidence, Companion degrades gracefully instead of losing history, and a human
can look at it. No automatic recovery/salvage was added, per the ticket's explicit boundary.

**`PRAGMA integrity_check` on startup — considered, not added.** SQLite's own WAL+fsync guarantees
already make silent page-level corruption from a crash extremely unlikely (that's the whole point of
WAL), the DB stays small (§6) so a full scan wouldn't even be expensive, but there is **no observed
corruption in production and no reported symptom this would diagnose that the existing "won't
open"/"future schema"/"malformed" open-failure path doesn't already catch**. Running it
unconditionally on every startup would add cost for a risk with no evidence behind it — exactly the
"ritual maintenance" the ticket warns against. **Decision: not added**, `quick_check` either.

**`VACUUM` — considered, not added.** There is no delete-heavy workload: `local_sessions`/
`local_matches` rows are never deleted, and the only deletes (`purge_delivered`'s 7-day-old
delivered/dead-lettered outbox rows) are small, infrequent, and don't leave enough free space to
matter at this DB's size (§6/§7). **Decision: not added** — no scheduled `VACUUM`, and no incremental
vacuum either.

---

## 15. Crash consistency (per mutation flow)

| Flow | Atomic unit | Verified by |
|---|---|---|
| Session start | session insert + `session_started` outbox enqueue | `ensure_active_session_enqueues_exactly_one_outbox_event_on_creation` |
| Session end | `ended_at` update + `session_ended` outbox enqueue (idempotent, only on real change) | `finalize_session_end_is_idempotent_and_clears_pending_end` |
| Match finalization | match finalize + session rating update + `match_finalized` outbox enqueue | `finalize_match_enqueues_exactly_one_outbox_event`, `calling_finalize_match_twice_never_double_credits_the_session_or_the_outbox` |
| MMR correction (`correct_match_delta`) | correction write + full forward cascade reanchor | existing `x2_*`/`a_manual_delta_edit_after_x2_*` tests + **new** failure-injection test (below) |
| Ranked↔Unranked correction | ranked_mode write + full forward cascade reanchor | existing `ranked_to_unranked_*`/`reverting_*` tests |
| Cross-session cascade reanchor (WK-123) | every session/match touched by the forward walk | existing `cascade_propagates_through_three_sessions`, `correction_in_session_a_reanchors_session_b` + **new** failure-injection test |
| Sync outbox enqueue | always inside the domain mutation's own transaction (§1) | `outbox_enqueue_never_depends_on_backend_state` (type-level pin) |
| Sync acknowledgement/dead-letter | single-statement `UPDATE sync_outbox` — no paired write to keep in lock-step | n/a (nothing else needs to change atomically with it) |

**New failure-injection regression test:**
`a_failure_partway_through_cascade_reanchor_rolls_back_the_entire_correction` (store.rs) forces a
**real** SQLite-level abort (a `RAISE(ABORT, ...)` trigger, not a mock) partway through a
cross-session cascade — after the first later-session match has already been reanchored
(uncommitted) in the same transaction, before the second one is. It asserts every earlier write in
that transaction — the correction itself, and the already-reanchored first match — rolled back too,
not just the row that failed. This is `rusqlite::Transaction`'s own roll-back-on-drop-unless-
committed behavior (verified directly against its source: default `DropBehavior::Rollback`, and
`finish_()` issues `ROLLBACK` whenever the connection isn't back in autocommit mode) doing exactly
what WK-123's transaction boundaries already relied on it to do — WK-127 didn't change this
behavior, it proved it.

**No regression versus WK-113/WK-123**: every existing crash-consistency/cascade test still passes
unchanged; nothing about transaction boundaries, MMR arithmetic, or cascade order was touched.

---

## 16. Network I/O inside transactions

None found. `detector.rs`/`store.rs` are backend-independent by construction (no `AppHandle`, no
`reqwest`, no `AppState` — confirmed by grep and by the existing
`match_transition_never_depends_on_backend_state`/`stream_lifecycle_never_depends_on_backend_state`/
`outbox_enqueue_never_depends_on_backend_state` compiled-in pins). `sync.rs`'s `drain_outbox` is the
one place a blocking HTTP call happens anywhere near this module, and it explicitly `drop(guard)`s
the `LocalRuntimeState` mutex guard **before** calling `send_event` (the blocking `reqwest` call),
re-acquiring only after it returns. No transaction, and no connection guard, is ever held across
network I/O.

---

## 17. MMR / reanchor safety

Storage/transaction properties only — business semantics untouched, per the ticket's scope
boundary:
- Correction transaction atomic — yes (§15).
- Cascade reanchor atomic — yes (§15, now with a real failure-injection proof).
- `rating_adjustment` preserved through the cascade — yes, existing
  `multiple_subsequent_sessions_each_keep_their_own_adjustment_through_the_cascade` test.
- Unknown-baseline behavior preserved — yes, existing
  `a_matchless_session_passes_the_shifted_baseline_straight_through`.
- Downstream sessions updated consistently — yes, existing `cascade_propagates_through_three_sessions`.
- Rollback on injected failure — yes, **new** test (§15).

No change to WK-123's cascade logic itself.

---

## 18. Backup policy

**Decision: no automatic backup system.** Per the ticket's own criteria:
- The DB is local-authoritative for runtime/history, but the backend already receives semantic sync
  for everything that matters for cross-device/account continuity (§7's outbox is exactly that
  pipe).
- Product is early beta, single-user-per-install.
- DB is small (§6) — no capacity pressure that would motivate one.
- A backup subsystem would add its own migration/retention/security surface (a second copy of the
  same data to keep consistent, secure, and pruned) for a risk that isn't in evidence.

No strong reason to override this default was found during the audit. **Not implemented**, per the
ticket's explicit instruction not to expand WK-127 into a backup/recovery subsystem without one.

---

## 19. File placement / side files

`local-runtime.sqlite3`(`-wal`/`-shm`) lives in the OS app-data directory
(`app.path().app_data_dir()`), confirmed via `db_path()` — never inside the repo tree. `git ls-files`
and `.gitignore` were checked: no `.sqlite`/`.db` files are tracked, and none need to be
gitignored (the app-data directory is entirely outside the working tree, so there's no accidental-
commit surface to guard against). Diagnostics export (`diagnostics/export.rs`) builds its ZIP from
an explicit whitelist of named entries (`manifest.json`, `timeline.json`, `app.log`,
`runtime-report.json`, …) — it never scoops up a directory wholesale, so the DB/WAL/SHM files cannot
end up in a diagnostics export by construction, confirmed by reading `export_zip` in full. No
stray/old DB copies or temp files were found anywhere in the repo.

---

## 20/21/22. Diagnostics integration

**Added:** `LocalRuntimeHealth.sqlite_schema_version: Option<i64>` (runtime_health.rs) — the live
`PRAGMA user_version` of the open connection, read in `runtime_health::compute` through the same
`LocalRuntimeState` mutex everything else already uses (no new connection, no scan). `None` exactly
when `sqlite` isn't healthy (no open connection to read it from). This directly complements the
future-schema guard added in §9/§11: support can now see which schema version an install is on
without needing `app.log`.

**Considered, not added:**
- **DB/WAL file size.** Would need an `fs::metadata` call per report generation — cheap in
  isolation, but there was no concrete support scenario in evidence that this would have resolved
  (§6 already shows growth is a non-issue at any realistic scale), so it was left out per the
  ticket's "prove the need first" rule. Easy to add later if a real growth question ever comes up.
- **Last DB open/migrate error text in the report.** The error is already logged in full to
  `app.log` (which is itself bundled unconditionally into every diagnostics ZIP), and a raw
  `rusqlite::Error` Display string is not obviously safe to duplicate into a second, more
  UI/machine-facing surface without checking for path leakage case-by-case (the ticket explicitly
  excludes "full filesystem path" from what runtime-report should carry). `app.log` already answers
  "what exactly went wrong" for the rare corrupt-file/permission-denied case; the new
  `sqlite_schema_version` field plus the existing `sqlite.status`/`reason` cover the common case.
- **Manual "Проверить локальную базу" diagnostics action (§21).** No evidence support currently
  lacks a way to diagnose a SQLite problem that the existing `sqlite` health component + `app.log` +
  the new schema-version field don't already cover. **Not built** — this needs its own proven need
  before a UI surface is added for it, per the ticket's explicit instruction.

**Unchanged, re-confirmed:** `runtime-report.json` still contains no raw DB contents, no match/
session dump, no full filesystem paths beyond what already existed, and no secrets — the existing
`runtime_report_never_leaks_synthetic_secrets_even_if_a_field_accidentally_carried_one` test (which
runs the redaction layer against a synthetic leaking report) still passes unchanged, and two new
targeted tests (`sqlite_schema_version_is_none_when_the_local_runtime_failed_to_open`,
`sqlite_schema_version_is_reported_when_the_local_runtime_is_open`) pin the new field's own
behavior.

---

## 23. Security boundary

Re-confirmed, not re-audited from scratch (WK-125 already did the full pass): `schema.rs`'s table
definitions (`local_sessions`, `local_matches`, `sync_outbox`, `sync_meta`) were read in full again
during this audit. No column stores a refresh token, companion token, OBS password, or OAuth
secret. `sync_meta`'s keys (`cutover_at`, `current_rating`, `cached_game_mode`,
`corrections_since`) are all non-secret bookkeeping values. `runtime-report.json` (§20) does not and
was not made to export any DB contents. No regression found.

---

## 24. Performance sanity

Measured directly against the §25 longevity DB (1,250 matches across 50 sessions, real file on
disk, debug build — release would only be faster): seeding all 1,250 matches through the real
`store`/`finalize_match` APIs, closing, reopening (`Connection::open` + `schema::migrate`), a
recent-matches lookup, and a full-history cascade reanchor (correcting the very first match in
history, forcing the cascade through all 49 later sessions — the worst case this DB can produce) —
**the entire test completes in ~0.5s total**, comfortably inside millisecond-per-operation territory
for each individual step. No O(n²) or missing-index behavior was observed anywhere in this flow (see
§8's `EXPLAIN QUERY PLAN` evidence). The test's own thresholds are set 1–2 orders of magnitude above
what was actually measured, specifically so they never flake in CI — their only job is to catch a
future accidental full-table-scan regression, not to serve as a benchmark. **No performance problem
found at this scale**, and 1,250 matches already exceeds what a single Companion install would
realistically accumulate in roughly a year of regular streaming.

---

## 25. Long-lived synthetic DB test

Added: `a_long_lived_database_with_thousands_of_matches_stays_correct_and_fast_after_reopen`
(store.rs). Seeds 50 sessions × 25 matches (1,250 total, mixing win/loss and ranked/unranked) through
the real store APIs, ends every session but the last (so the reopened DB has a genuinely "currently
streaming" open session, matching a real long-lived install), closes the connection, reopens the
same on-disk file via the real startup path, and asserts: every session/match survived reopen
intact, recent-matches ordering is correct, and a correction on the very first historical match
correctly cascades all the way forward to the currently-open session. No year of wall-clock time was
simulated — this is a structural longevity check, not a time-simulation.

---

## 26. Findings summary (P0–P3)

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Migration DDL/DML and its `user_version` bump were two independent, non-transactional steps — a crash between/during them could brick reopen | **P1** | **Fixed** — `apply_migration` wraps both in one transaction |
| 2 | A `user_version` newer than this binary's `MIGRATIONS.len()` was silently skipped past, not rejected | **P1** | **Fixed** — explicit guard, routes into the existing open-failure path |
| 3 | `journal_mode = WAL` was set via `pragma_update`, which discards SQLite's actual applied value — a silent non-WAL fallback would go unnoticed | **P2** | **Fixed** — `pragma_update_and_check`, logged if not `"wal"` |
| 4 | No `busy_timeout` set | **P2** (not a live bug — no contention path exists) | **Fixed** — native, zero-cost hardening |
| 5 | `sqlite` health component had no schema-version visibility | **P2/P3** | **Fixed** — `sqlite_schema_version` added to `runtime-report.json` |
| 6 | No `integrity_check`/`quick_check` anywhere | P3 (theoretical) | **Not implemented** — no evidence of need (§12/§13) |
| 7 | No scheduled/manual `VACUUM` | P3 (theoretical) | **Not implemented** — no delete-heavy workload (§14) |
| 8 | No automatic backup of `local-runtime.sqlite3` | P3 (theoretical) | **Not implemented** — practical risk is low at this stage (§18) |
| 9 | No manual "check local DB" diagnostics action | P3 (theoretical) | **Not implemented** — no proven support need (§21) |
| 10 | `find_open_session`/`list_recent_finalized_matches` are full table scans | P3 (theoretical) | **Not implemented** — tables are tiny / reverse-rowid scan is already fast (§8) |

No P0 found. Nothing here indicated data loss or corruption in progress — the architecture the
WK-110/111/112/113/115/123 work already built was sound; this audit found two real (if narrow)
reliability gaps in the migration path and closed them, confirmed the rest, and deliberately did not
add anything beyond that.

---

## 27. What was intentionally NOT implemented, and why

Every P3 item in §26, plus: no manual VACUUM/backup/integrity-check UI, no retention change for
`local_sessions`/`local_matches`, no new indexes, no checkpoint timer, no change to `synchronous`.
Each of these was evaluated against real evidence (query plans, growth estimates, the existing
crash-safety test suite) and found to have no concrete problem behind it — building any of them now
would be exactly the "SQLite platform"/"maintenance for its own sake" the ticket explicitly warns
against.

## Follow-up recommendation

None. The two P1s were the only genuinely load-bearing gaps found, and they're fixed. If a future
ticket ever surfaces a concrete DB-size, corruption, or backup need with real evidence behind it,
that's the point to revisit §12/§14/§18 — not before.
