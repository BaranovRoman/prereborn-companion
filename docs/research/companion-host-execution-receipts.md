# Diagnostic match execution and receipts — iteration 11

## Question

Can an external detector plan execute through the real transaction facade, resolve
conditional identities, and acknowledge an atomic write set without touching live Dota?

## Current state

Iteration 10 shares `dota-domain::match_shadow` decisions with the legacy detector.
Legacy owns live GSI and all effects. The transaction facade borrows the caller's
transaction and delegates to real store/sync kernels. Legacy has no persisted match
revision. Iterations 7/8 supplied isolated ledger/rehearsal patterns, not production tables.

## Findings

- `local_runtime::host_execution` is **compiled only under `cfg(test)`**. Its Rust harness
  starts the existing external replay executable through IPC v1, takes its typed detector
  decision, and passes a bounded `match_execution::Request` into the adapter. There is no
  Tauri command, iframe bridge, live observer hook or new production IPC dispatcher.
- The adapter only accepts its privately owned temporary fixture, copied from a closed
  database created with the actual schema and the frozen legacy fixture seed. A crash
  child adopts that parent's marked fixture for process-exit tests. No user path is an API.
- A host-issued ticket persists the sanitized snapshot, sequence, capture/fallback clock,
  session/match context, ranked mode, revisions and SHA-256 binding. Execution revalidates
  the canonical shared decision and ticket inside `BEGIN IMMEDIATE`; the plugin cannot
  supply its own authoritative context, clock, SQL, backend payload or operation sequence.
- Supported actions: telemetry, interrupted, needs-review, pending post-game, finalization,
  resume, conditional create/lookup and current-match telemetry. Actual session closure
  uses the same post-store lookup criterion as `handle_gsi`, not the plan's predicted flag.
  Corrections are tested through existing kernels but are **not** a plugin permission.
- Real match/session/rating/outbox SQL, sidecar revisions and terminal receipt/ledger row
  commit in **one database transaction**. Store failure, stale context or receipt-size
  failure cannot leave a partially applied write set. No independent infrastructure DB commit.
- Conditional creation uses real `INSERT OR IGNORE`, then reads both the unique key and
  active match. A historical row occupying the key resolves to its original UUID/key and
  reports `conflicted`; subsequent operations use the actual active-match lookup.
- Receipts contain per-operation applied/skipped/conflicted outcomes and post-state,
  resolved match/session UUIDs, game ID/key, closure outcome, separate diagnostic revisions,
  bounded outbox UUID/status/attempts/payload hash, operation key and original correlation.
  Session `disposition` denotes closure, not every session counter change. Final state is
  read inside the transaction. Backend payloads and account data are not returned.
- A duplicate key with identical identity returns the saved immutable receipt before
  testing now-stale preconditions. A new retry correlation is returned in the response
  envelope; the receipt retains its committed correlation. A different payload is rejected.
  `Unknown` is never treated as success or dispatched by recovery. Explicit stored Unknown
  blocks execution; absent receipts recover as Unknown and do not trigger a retry.
- Limits: request/ticket 16 KiB, receipt 32 KiB, shared detector plan at most eight actions;
  outbox scoped to session/touched matches, at most 64 rows, each payload at most 64 KiB.
  Oversized stored ticket/receipt is rejected before loading the body. No automatic key cleanup.

### Revision policy 1 (fixture only)

`pc11_revision` contains persisted integer counters for each match/session UUID, including
deletion tombstones; it does not replace `MatchContext.revision = None` or call a fingerprint
a revision. `pc11_epoch` increments on every match/session/device-meta/outbox insert, update
or delete, including writes outside the adapter. Thus ABA changes, corrections and delivery
bookkeeping conservatively invalidate old tickets. Reinserted UUIDs retain increasing counters.
Identity mutation and counter overflow abort. Revision/epoch updates roll back with the writes.
Schema/trigger signatures and SQLite `quick_check` are checked before execution/recovery;
missing triggers, unknown schema, corrupt receipts or an unreadable file fail closed.
Checksums detect corruption; they are not protection against a privileged DB editor.

### Verification

- Eleven focused adapter tests pass (one is the crash-child harness). Real IPC plans are compared
  against real legacy execution after **every transition**, across reconnect/interrupted,
  hero change, partial fields, pending/confirmed/probable/conflicting post-game, needs-review,
  distinct fresh/stale match identity and conditional duplicate keys. Additional correction
  and delivery bookkeeping parity uses actual store/sync kernels without network requests.
- Comparison dumps every legacy table, column and row in insertion order, including device
  rating, nullable telemetry, nine inventory slots, correction events, outbox payload/status
  and session counters. Only independently generated new UUIDs/references are normalized
  by table and insertion ordinal. Seed UUIDs, keys, payload semantics and timestamps are preserved.
- Recovery tests cover actual child exit before commit and after commit before reply, reopen,
  rollback after writes, concurrent duplicate identity resolution, payload conflicts, stale
  preconditions, forged plans, Unknown, corrupt file/receipt, missing triggers, ABA/tombstones,
  overflow and bounded payload failure. Writes preserving column values still report applied
  when their actual persisted revision advances. After-commit retry returns the saved receipt/UUIDs.
- Five existing transaction-facade/rehearsal tests pass, including frozen-oracle write-set
  parity, atomic rollback and retention over 256 indexed keys. No full test suite was run.

## Options

1. Wire the adapter into live GSI now: unsafe without activation/fencing, dispatcher permissions
   and an approved migration of the real transaction database.
2. Reuse the simplified prototype tables: cannot establish real store/write-set parity.
3. Use a test-only adapter on real-schema copies: validates execution and receipts while keeping
   the current runtime and production schema unchanged. **Chosen.**

## Recommendation

Keep the fixture adapter isolated until a diagnostic request/receipt bridge has explicit
capabilities and session fencing. Reserve sidecar tables in the eventual same transaction DB;
rehearse rollback and backup restoration before approving any production migration. Do not
claim exactly-once HTTP/OBS semantics from local transaction atomicity.

## Follow-up

Next: a debug-only dry-run request/receipt bridge from the external process to an isolated
fixture host, with capability denial, ownership-epoch checks and receipt-driven context
refresh. Keep legacy the only live owner. Separately define schema migration and retention
for tickets, tombstones and ledger keys; no automatic cleanup was added here. Watchdog
execution, live session creation, recovery of external effects and ownership handover remain
out of scope. Native WebView, Windows/game smoke, production packaging and real-user migration
were not run and remain required before switching live execution.

## Sources

Repository source: `plugins/dota-domain/src/match_shadow.rs`, `match_execution.rs`;
`apps/companion/src-tauri/src/local_runtime/{detector,store,sync,mod,transaction_facade,
transaction_tests,host_execution}.rs`; `core/plugin_match_transactions.rs`;
`plugins/dota/src/main.rs`. No external research or dependencies were needed.
