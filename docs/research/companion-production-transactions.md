# Production transaction integration — iteration 13

## Question

Promote the validated adapter/ledger/revision/receipt implementation into core production
code while retaining the existing writer, legacy APIs and built-in live Dota. Provide an
explicit additive migration and safe rollback; do not migrate user data or activate plugins.

## Current state

Iteration 12 supplied an owning fixture adapter and real diagnostic IPC. Legacy uses one
connection behind `LocalRuntimeState`, real `_in` store kernels and the transaction facade.
The separate `plugin_durable` infrastructure database is not a suitable second commit for
match/outbox atomicity. Dota remains blocked by PluginManager, including registry restoration.

## Findings

### Production code and one writer

- `host_execution`, schema migration and authorization now compile without `cfg(test)`.
  The same Adapter implementation borrows the connection supplied by the existing core
  mutex. It owns validation metadata and a coordinator lock, **not a second connection**.
- `LocalRuntimeState` retains its public `lock`/`try_lock` API and adds a dormant Adapter
  slot. Explicit core methods migrate, prepare, execute and recover on that same connection.
  Nothing calls migration or attaches the adapter from ordinary startup or the GSI listener.
- Only the owning fixture wrapper, fault injection and diagnostic bridge remain test-only.
  Fixture wrapper methods delegate to this production kernel; no second algorithm was copied.
- Seven existing transaction-opening legacy wrappers now call the shared
  `transaction_facade::with_transaction`: session insertion/streamed/end, device rating,
  finalize and manual delta/mode correction. Public signatures and transaction timing remain
  unchanged. Existing SQL, MMR rules, detector/watchdog, sync and session lifecycle remain intact.
  Facade operations still borrow their caller's transaction and call the real `_in` kernels.
- Authorized plans use `BEGIN IMMEDIATE` and check durable ownership, session/package,
  snapshot ticket, canonical shared plan and write preconditions inside that transaction.
  Match/session/rating/outbox/revision/ledger/receipt changes commit together. Ledger admission
  is indexed by operation key; payload conflict fails, duplicate returns the persisted receipt.
  Legacy APIs without operation keys do not invent synthetic idempotency identities or automatically
  turn every legacy call into a new receipt. Their writes still update the migrated revision triggers.
- A std OS file lock at `<database>.transaction-coordinator.lock` prevents another adapter or
  migration coordinator claiming that database. It is retained, never unlinked while released.
  This is a lock resource, not another writer/database. Normal legacy single-instance startup
  is unchanged. The lock was tested on macOS, including a competing subprocess.

### Explicit additive migration and backup

`LocalRuntimeState::migrate_transactions` is a **core-only explicit call**, with the existing
connection mutex held. It is not a Tauri command, startup migration, update hook or UI action.

1. Claim coordinator lock; verify the actual legacy schema/user version, SQLite quick check,
   foreign keys and bounded stored game fields. Refuse unknown/partial/corrupt schemas.
2. Use SQLite `VACUUM INTO` for a consistent backup, including committed WAL data. Refuse
   overwrite/symlink backup; reopen read-only and validate before changing the source schema.
3. Begin an immediate transaction; compare the source with that backup to detect intervening
   writes. Install reserved tables/triggers, validate and commit. Any DDL/quota/disk failure rolls back.
4. Re-running migration validates the installed schema and accounting; it does not repeat DDL,
   overwrite a backup or reset epochs. Legacy `user_version` is unchanged; safety schema has
   its own version 1. Ordinary `schema::migrate` has no new migration entry.

Reserved `pc_tx_*` tables contain ownership/checksum, ledger, separate receipts/checksums,
snapshot tickets, revision tombstones, global write epoch, migration baseline/write marker,
quota limits and atomic usage counters. The diagnostic-owner namespace remains isolated for
the existing fixture harness; it is not production ownership. Legacy tables, UUIDs, keys,
outbox and paths are preserved. No rows from user history or the old infrastructure/prototype
databases are automatically copied into the new layer. All match safety state uses this same DB.

### Revisions, quotas and retention

- Policy 1 uses integer match/session counters, immutable UUIDs and deletion tombstones.
  Every legacy match/session/device-meta/outbox mutation advances the write epoch, including
  corrections and delivery bookkeeping. ABA and UUID reuse cannot revive an old precondition.
  Counter overflow rolls back. Legacy `MatchContext.revision` stays None: no fingerprint is a revision.
- Defaults: 10,000 operation keys/receipts, 10,000 tickets, 64 MiB receipt payload and 64 MiB
  ticket payload, 100,000 revision identities. Limits are explicit core-owned policy rows with
  bounded maxima, not plugin settings. No automatic increase or cleanup was implemented.
- Trigger-maintained usage counters make admission checks constant-time with respect to ledger
  size; updates roll back with the write set. Opening/validation checks actual totals, checksum,
  schema/triggers and policy. Hot-path field integrity is scoped to the relevant session rather
  than scanning all historical inventories each frame. Recovery/duplicate receipts also check
  physical/logical integrity. SQLite/storage errors fail closed without recreating the file.
- Quota exhaustion aborts the entire operation. Duplicate/Unknown lookups remain readable;
  terminal receipts cannot be downgraded to Unknown. Safety-table DELETE guards prevent deleting
  keys, receipts, tickets or revision tombstones. Unknown never causes automatic execution.
- **Live capacity is not established**: defaults are deliberately finite and may be unsuitable
  for a long high-rate stream. Before activation, review admission frequency and retention;
  any archival/compaction must prove retired scopes cannot admit old keys. No unsafe cleanup
  or unlimited exactly-once guarantee was introduced.

### Production authorization

- Existing `Store::executable` verifies the signed manifest, signature trust key, all inventory
  hashes, platform/API and executable path. PluginManager issues an opaque match grant only
  for installed `dota2`, signed `execution: live` and `dota.match.execute`, plus an explicit
  grant supplied by core. Old manifests default to replay-only and serialize compatibly.
  Hello/replay-only/missing capabilities/unsigned or tampered packages are rejected.
- Grant binds the exact active version/path, executable hash, canonical signed-manifest hash,
  session and owner lease. Before execution/recovery, Manager re-verifies and pins the installed
  binding. A non-constructible verified pin is required by the adapter. Changed/deleted/tampered
  installations cannot use an old grant, even to retrieve a cached result through that API.
- Lock order is **Manager pin -> existing history mutex -> adapter**. The pin performs no
  process-lock acquisition. Future IPC must acquire this pin before locking a Runtime; it must
  not acquire Manager from an already-held Runtime lock during a reverse callback.
- Same-DB ownership uses the existing domain `Ownership` state machine and checksums. Reopen
  keeps uncertain Active as Draining; Vacant/Draining, stale epoch/session/package or preconditions
  deny execution. Explicit fenced recovery advances epoch. This metadata is not attached to live
  GSI/bootstrap. New match authorization does not use diagnostic epochs or the old infrastructure DB.
- Dota start/enable/restore still fails with `dota_live_activation_deferred`; a signed live profile
  is preparation, not activation. No production reverse dispatcher or process/GSI fence is enabled.

### Rollback

`restore_before_writes` validates backup, baseline, legacy write epoch and retained safety write
marker inside a transaction. Before any new records, source history already equals the verified
backup: logical restoration requires **no file replacement**, WAL race or safety-table removal.
It retains safety metadata and advances BuiltIn ownership to a new epoch.

After history or safety writes, restoration of the old backup is rejected. Runtime fallback
must instead drain/fence and transfer ownership using the state machine, preserve all keys and
receipts, and advance epoch. Production APIs expose those metadata transitions; proving actual
ingestion/process/effect fencing is next-stage work. A timeout or new coordinator is not proof.
Local atomicity does not imply exactly-once HTTP/OBS; existing backend sync semantics are unchanged.

### Measured checks

- Production migration/recovery module: **11 passed**, including one coordinator-child entry.
  WAL backup/reopen/idempotence, source preservation, pre-write rollback/new epoch, forbidden
  post-write restore, damaged backup/schema/accounting, quota rollback/Unknown retention,
  stale epoch/session/binding/Draining/Vacant, concurrent-coordinator refusal and a disk-page
  limit failure **mid migration** rolling back all reserved tables.
- Existing real IPC/adapter tests: **19 passed** (two child harness entries). Real process crash
  before commit and after commit before reply, saved receipts, duplicate/conflict/stale/Unknown,
  conditional identity resolution, reopen, full write-set parity and reset/reconnect still pass.
- Facade/legacy tests: **6 passed**. New migrated **public legacy API** comparison verifies all
  columns/tables after each of 18 transitions against the frozen pre-refactor implementation;
  device rating, corrections, sessions, telemetry/inventory, outbox payload/order/status match.
  Only independently generated new UUIDs/references are normalized, preserving seed identities.
- Core PluginManager: **6 passed, 1 existing packaging test ignored**. New positive test uses a
  1 KiB signed disposable live-profile fixture and the real core mutex/adapter API; tampered
  executable and unsigned/replay/Hello grant cases fail. No fixture executable is activated.
- Lightweight package manager signed compatibility tests: **3 passed**. No production package
  or catalog was changed; fixture private key was ephemeral and was not written to the repository.
- Normal production `cargo check --lib --offline` succeeds without `cfg(test)` (Rust 1.93.1).
  Dead-code warnings remain for deliberately dormant entrypoints, not suppressed as live wiring.
  No frontend changes/full suites/production packaging/Silero/old overlay/cache deletion.
  Windows/native WebView/game smoke and real-user migrations were **not performed**.

## Options

Opening a separate writer or committing the infrastructure DB independently would invalidate
atomicity. Copying the fixture kernel would fork algorithms. Chosen: promote that same kernel,
borrow the existing core connection, and keep only ownership/fault/test scaffolding test-specific.

## Recommendation

Use the explicit migration and production API in the next live-integration workstream. Keep
automatic migration and external activation off until fencing, dispatch and manual verification
are ready. Review quotas/long-stream admission and backup operations before enabling execution.

## Follow-up

Iteration 14 should implement **live fencing and the typed effect dispatcher**, not another
diagnostic prototype:

1. Bind the verified package grant to the actual Runtime handshake/process generation. Wire
   production IPC with the defined Manager/process/history lock order and bounded queues.
2. Add ingestion pause/drain barriers to the existing single GSI listener/handlers; persist
   Draining, finish in-flight transactions, and require confirmed process/effect fencing before
   advancing ownership. Never run built-in and external Dota handlers concurrently.
3. Dispatch typed OBS/audio/overlay intents in core, retain sockets/tokens there, and use the
   same safety ledger/receipt boundary for local admission. Reconcile uncertain external outcomes
   without blindly repeating effects or replacing the existing backend sync algorithm.
4. Implement fenced fallback to BuiltIn with a fresh epoch and preserved receipts. Gate actual
   migration/activation on approved backup, quota/retention review and Windows/Dota/OBS/overlay/
   Twitch/TTS/crash smoke. This iteration does not satisfy or replace those manual checks.

## Sources

Repository: `local_runtime/{host_execution,transaction_schema,transaction_authorization,
transaction_facade,store,mod,schema,transaction_tests}.rs`, `core/plugin_manager.rs`,
`plugins/manager/src/lib.rs`, shared domain ownership/match contracts and the frozen legacy
fixtures. Minisign fixture encoding was checked against the installed `minisign-verify` source.
No external service access, new dependency or production environment change was needed.
