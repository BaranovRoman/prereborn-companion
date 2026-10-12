# Transaction facade and legacy compatibility — iteration 8

## Question

Can real legacy store operations participate in one caller-owned match/outbox/ledger transaction without replacing game algorithms or migrating production data?

## Current state

Built-in Dota still uses the existing store public API and remains the only live runtime. External Dota is replay/read-only and user activation is blocked. Production schema, paths, settings, identifier, updater, detector and watchdog are unchanged. No ledger is connected to live ingestion. The iteration-7 simplified prototype remains test-only and is not a production replacement.

## Findings

### Real transaction kernel and compatibility adapters

`local_runtime/transaction_facade.rs::Facade` borrows the caller's existing `rusqlite::Transaction`; it creates no connections, commits or workers. It delegates actual store SQL/algorithms for match create/resume, nullable telemetry/nine inventory slots, interrupted/review/post-game, streamed/gameplay sessions, session end, current/device rating, finalize, delta/ranked corrections, outbox enqueue/status and server-originated correction application.

Seven transaction-owning store functions now have composable `_in` kernels: session insertion/promotion, current rating, session end, match finalization, delta correction and ranked-mode correction. Their public signatures remain unchanged; compatibility wrappers open/commit one transaction and invoke that same kernel. Statement-level helpers were reused directly through Transaction's Connection dereference. `sync::apply_one_correction` gained only sibling-module visibility; its SQL and existing caller behavior did not change.

Rating computation, reanchor/cascade, idempotent finalized guards, UUID generation, match keys, telemetry coalescing and exact outbox serialization remain the real implementations. The carried-rating read on session creation is now inside the caller-owned transaction. Returned session/match reads in correction wrappers happen before commit, and are returned only after successful commit. Under the existing single managed connection/lock this preserves the observed state and permits composition without nested commits. No game outcome/reconnect/watchdog heuristic moved or changed.

Local corrections do not invent new sync events: the actual legacy store corrects/reanchors local data, while server corrections are received through the existing pull path. The facade preserves that behavior. Network delivery, correction polling/cursor orchestration, callbacks and live scheduling remain outside this facade.

### Full write-set parity

Two independent temporary file copies of a closed, seeded database produced by the actual `schema::migrate` are used. `fixtures/legacy_store_9d46cc5.rs` and `legacy_sync_9d46cc5.rs` freeze the pre-refactor store, enqueue and server-correction code as an independent test-only oracle; they never run in production and must not be updated to hide future differences.

The test compares every column of every legacy user table after each of 18 transitions, not selected returned values. It covers gameplay session promotion, reconnect with late GSI ID, nullable K/D/A/nine slots, interrupted, needs-review, post-game, finalize, delta edits, ranked/unranked/revert, server correction, session end/start, new match creation/finalization, forward rating cascade and explicit enqueue. Deterministic fixture delivery/dead-letter bookkeeping and outbox status are also compared.

Only newly generated UUIDs are mapped bijectively by table and insertion ordinal, with their references normalized consistently in payloads/keys. Seeded UUIDs are never normalized; the recovered original match ID is explicitly asserted at every step. Timestamps, inventory, payload field names/values, row ordering, rating/device metadata, attempts, delivered/failed status and all other fields are preserved in comparisons. There is no legacy match revision column to normalize or migrate; schema user_version remains unchanged. Outbox UUID bytes naturally differ only when independently generating new events; their referential identity/order is checked rather than pretending both generators produce the same random UUID.

All checked write sets match. Existing store tests additionally validate algorithms/returned models, forward cascades, recovery identity and idempotent finalize. This is scenario coverage, not a proof for every historical database or a native/live game smoke test.

### Atomic rehearsal adapter and indexed ledger

Only the test module installs `pc8_*` ownership, indexed operation-key ledger and receipt tables in copies of the real schema. Match finalization/session rating/device rating/outbox and ledger/receipt inserts are exercised through one caller-owned SQLite transaction. Drop/rollback restores the complete original write set, including outbox UUID rows and reserved records; commit persists them together. Reopen returns the saved Completed receipt, and a duplicate-ledger failure after rating writes rolls those writes back. No independent commits across databases, second writer coordinator or production migration was introduced.

The indexed rehearsal handles 300 retained keys without the monolithic 256-entry limitation. Primary-key conflicts preserve existing identity/status. Recovery converts only Accepted to Unknown; it does not infer Completed, resend HTTP or execute OBS. No keys are removed. This is an indexed-schema/recovery rehearsal, not a routed production ledger or a complete replacement for iteration-6 admission/epoch logic. The existing production/debug infrastructure ledger is deliberately unchanged. A real adapter still needs authenticated lease/grants, payload hashes, quota enforcement, receipt reconciliation and durability integration before adoption.

Long-term retention remains fail-closed: define disk/session quotas before activation, preserve exact keys/payload identity or a proven sealed-session replay fence, and never delete Unknown/in-flight records. No automatic compaction/archive cleanup runs. Removing the in-memory count cap is not a claim of unlimited safe disk growth.

### Migration rehearsal and rollback

Installation validates SQLite quick_check, exact current legacy schema signature and user_version against the actual migrator's reference schema before adding reserved tables. Existing rows and IDs/outbox are unchanged, old queries still work, and reopening retains data. Invalid/newer version and a corrupt file are refused. The production `schema.rs` has no new migration.

The rehearsal records a baseline fingerprint and creates test-only reserved-prefix write-watermark triggers. These capture INSERT/UPDATE/DELETE on legacy tables and reserved ownership/ledger/receipts, so an ordinary legacy write without ledger also prohibits rollback. Before new writes, rollback removes only reserved tables/triggers and restores the original schema signature. After new writes, rollback refuses instead of dropping keys or restoring stale history. A future migration cannot rely only on a snapshot comparison, because changes can later return data to the old value; the monotonic watermark addresses that gap in the rehearsal.

No real user database was read/copied/migrated. These are generated temporary copies of the real user **schema** with anonymous fixtures. Power-loss, actual historical data, old application binaries, Windows locking and live writer fencing remain unverified. The planned production additive migration still needs a consistent WAL-aware backup, frozen writers and a compatible rollback build as described in iteration 7.

### Focused verification

- 5 transaction/parity/migration tests passed, including all write-set comparisons, atomic rollback/commit, reopen, unsafe rollback refusal, indexed retention/recovery and corrupt/incompatible schema rejection.
- 56 tests of the changed store module passed; no whole application/workspace test suite ran.
- Host library cargo check passed. Unused facade/durable method warnings reflect the intentionally absent live routing.
- No frontend changes/checks, dependency installation, app/installer/production build, old overlay/Silero rebuild, cache cleanup, native WebView, Windows or game smoke.

## Options

1. Replace legacy persistence with iteration-7 simplified rows: loses real MMR/session/correction semantics; rejected.
2. Reuse transaction-aware kernels under unchanged public adapters, test against a frozen legacy oracle, rehearse reserved tables only on copies: chosen.
3. Commit ledger in the separate infrastructure DB after store commit: fails required atomicity; rejected.

## Recommendation

Keep the facade available to host code but unrouted to external Dota. Do not migrate production or connect ledger based only on these fixtures. Preserve one existing managed connection/coordinator and reuse current detector/watchdog decisions when the future typed command dispatcher is introduced.

## Follow-up

Iteration 9: debug-only GSI forwarding to the external replay process with **no effects**. Retain the existing listener/core as the only ingest owner, project sanitized bounded fields, assign monotonic sequence and session context, and send frames to an isolated external analyzer. Never let its results call facade/OBS/audio/sync/overlay. Compare outputs against built-in pure rules; handle backpressure, drops/reconnect/reset and process crash while core streaming stays independent. First expand replay DTO coverage where required, then implement the bridge behind explicit debug activation. Production dispatch, full match-detector parity, correction cursor/batch transactions, live lease/fencing proof, indexed-ledger quota/admission and migration on user data remain later gates.

## Sources

Repository `local_runtime/{store,detector,watchdog,sync,schema}.rs`, new facade/tests and frozen pre-refactor fixtures from commit 9d46cc5. Actual source and caller signatures were inspected; no external sources were needed.
