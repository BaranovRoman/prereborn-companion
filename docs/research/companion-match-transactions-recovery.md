# Match transactions and recovery — iteration 7

## Question

How can future external Dota commit a match transition, outbox intent and operation ledger atomically while retaining existing working Dota and preparing a reversible data migration?

## Current state

Built-in Dota is still the only live runtime. The external worker accepts replay/read-only commands; `dota.match_transaction` is **not registered or implemented in that worker**. The iteration-6 infrastructure database and user history are not changed by this prototype. New executable prototype code and its store hooks are compiled only with `cfg(test)` and opened only under test temporary directories. No app-data path, settings, identifier, updater or production bootstrap changed.

## Findings

### Existing algorithms and transaction boundaries

- `local_runtime/store.rs::finalize_match` already wraps finalized match fields, session/device rating and `sync::enqueue(match_finalized)` in one transaction. Its conditional `state != finalized` update and `changed > 0` gates prevent duplicate rating credits/outbox rows. Session start/end and correction operations also have their own transactional write paths; the future facade must preserve their complete write sets, not just match rows.
- `create_match` preserves UUID local identity and uses `gsi:<match_id>` or `session:<session_id>:<milliseconds>:<hero>` match keys. Uniqueness is session/match-key scoped. Resume uses the existing row, fills a previously missing game ID and does not regenerate local identity. Telemetry retains known nullable K/D/A and inventory when a partial frame contains no usable observations. Main inventory/backpack is nine slots.
- Detector post-game processing uses observations and existing state, not a timer-only guess: pending/unconfirmed observations, matching observations, conflict/review and reconnect have distinct decisions. Its telemetry update and subsequent decision are not one encompassing transaction today. Preserve these rules; do not move them into a new guessed policy.
- Watchdog persists `last_seen_at`; silence alone only derives staleness. Automatic interruption additionally needs session-ended or genuinely distinct-match evidence. It does not fabricate a winner/MMR. Reconnect and crash retain existing match identity rather than creating another match automatically.
- Outbox enqueue is transactional but creates a fresh UUID per enqueue call. Semantic guards matter: two unguarded enqueues would create two events. Sync drains in insertion order and stops on retry. HTTP success and local delivered marking are separate boundaries; lost response or failure to persist delivered state can cause another send of the same event UUID. Current purge removes sufficiently old delivered/failed rows; that policy is **not** suitable for deleting effect keys.
- Backend `stream-sync-service.ts::withIdempotency` records event result in the same PostgreSQL transaction as apply. `applyMatchFinalized` also checks stable local match identity. These existing defenses explain same-event retries; this prototype does not change them or infer external success from a local commit. Future safe resend needs preserved UUID/payload/account context and a confirmed supported recovery policy.

Core must retain credentials, backend serialization/delivery, UUID assignment, SQLite transactions, rating/session aggregates and outbox ordering. The future plugin supplies bounded observations/semantic proposals; core must verify session/evidence/lease. IDs, timestamps, nullable telemetry, mode/outcome/confidence and expected revision are required across that boundary. Pure game decisions and existing MMR algorithms still need reuse/parity; this prototype does not replace detector/watchdog or compute rating deltas.

### One-database prototype

`core/plugin_match_transactions.rs` owns `proto_matches`, `proto_outbox`, `proto_receipts`, a cached `proto_overlay` and schema marker alongside the **same** `plugin_control` ledger/ownership record in a temporary SQLite file. It uses the existing durable store's IMMEDIATE transaction, checksum and exclusive coordinator lock. No ATTACH, second database commit, real HTTP or live effect exists.

`settle_local` checks ownership epoch, grants and full operation fingerprint before invoking a new operation. Match mutation, outbox enqueue, immutable result receipt, ledger terminal status and acknowledgement commit together. A semantic rejection rolls back operation writes to a savepoint, then persists a terminal Rejected receipt/ledger in that same outer transaction. Storage failures roll back the complete operation. Duplicate keys skip the operation entirely and return the saved result with the current correlation ID. Same key with changed operation fields conflicts. Expected revisions guard stale updates independently of operation-key deduplication.

Finished transitions enqueue one `match_finalized` intent per local match. UUID outbox identity is retained across repeated enqueue. The generated payload uses the existing field names, nullable rankedness, nine-slot inventory and RFC3339 timestamps. No sender is attached. The prototype intentionally covers this event, not all session/correction/between-matches/cutover events. Session IDs are preserved namespaces; session rating/tally/device-rating materializations are not implemented here.

Typed DTOs in `dota-domain/match_transactions.rs` cover Started/Updated/Finished, Resume/PostGame/Interrupted/NeedsReview, history, enqueue/status, backend sync intent and overlay state cache. UUID local/session IDs, bounded game IDs/keys, enum-only decisions, nullable telemetry, nine inventory slots, timestamps, rating metadata, revisions, epochs, correlation and operation keys are explicit. Payload limit is 4 KiB; result limit 16 KiB; history/outbox limits are 1–20. Unknown fields/SQL/URLs are rejected. History operations require History, sync intent requires Sync, and overlay cache requires Overlay. IPC v1 Command serialization is tested, but no new live handler or plugin access is granted.

### Unknown and crash outcomes

Local Completed means the SQLite operation committed, **not** that backend/overlay/audio ran. Pending/Unknown delivery is separately visible. A backend sync intent only records Unknown at the oldest outbox row; it sends nothing. The same key returns that recorded Unknown delivery. Another key trying the same uncertain event is Rejected, and an uncertain oldest event blocks later intents. There is no automatic external confirmation or retry.

Unknown local ledger state can be reconciled only against a checksum-valid terminal receipt with the identical operation fingerprint and an authorized current lease. A test creates an iteration-6-style Accepted ledger plus committed receipt, reopens to Unknown and resolves the local result without rerunning mutation. Missing/mismatched/corrupt receipts remain failures. Terminal Completed/Rejected never rerun.

Abrupt child exit before commit rolls back match/outbox changes and admission; no partial operation survives. Exit after commit but before returning a reply preserves match, outbox, receipt and terminal ack; reopen/fencing and retry return the saved result. Reopen still requires explicit fencing; no ownership auto-switch was added. Damaged records, oversized FIFO rows and missing committed tables fail closed, without silently skipping/recreating them.

### Migration and rollback plan (not executed)

Chosen future destination: keep `local-runtime.sqlite3` and its existing history/outbox at the same path. Add reserved plugin ownership/ledger/receipt tables in a reviewed additive schema migration. This avoids moving history and allows the existing store and new coordinator to share **one Connection/Transaction**. Do not put a production ledger in a second writable DB and claim cross-DB atomicity.

1. On test copies first, validate source schema, UUIDs, match keys, session relationships, telemetry, ratings, sync cutover metadata, outbox order and every queued event UUID/payload/status. Report irregular rows; do not silently deduplicate, recalculate ratings or generate replacement IDs.
2. Prepare a compatibility build with an explicit transaction facade: current public methods retain legacy behavior; transaction-aware internals reuse the actual rating/finalization/session/correction rules. Require parity tests for full write sets, including counters and device rating, before any schema rollout.
3. For the later approved migration, pause/fence all writers and delivery workers. Take a consistent SQLite backup including WAL through the backup API/checkpoint under stopped writers; do not copy a live main file without WAL. Validate the backup and prepare rollback evidence.
4. Add reserved tables, provenance/schema marker and any validated key/result import in one destination SQLite transaction. Preserve user history, local/backend IDs, match keys, outbox IDs/raw payloads/order/attempts/delivery/dead-letter/cutover metadata. Never copy replay/test receipts into the live namespace. Freeze the old infrastructure writer; future compatible versions must use one canonical authority and never reopen two coordinators. Historical source/control import is a read-only offline input, not a second commit pretending to be atomic.
5. Initialize/recover ownership only after real fencing proof; epoch must exceed the preserved high-water mark. Start built-in through the new compatible facade first. Keep external activation blocked. Verify counts/hash comparisons/read behavior and Windows/streaming smoke before an opt-in external handover.
6. Before new writes/delivery, rollback may restore the consistent backup under stopped writers. After new writes, restoring it would lose matches/keys and can replay effects: forbidden. Roll back runtime ownership using a fresh epoch and a **compatibility build** that preserves new tables, receipts and Unknown gates. Do not drop tombstones or run an old sender unaware of uncertain rows. No automatic data migration or rollback runs in this iteration.

### Retention plan

Implemented: the 256-key and record-size limits remain, no key deletion/rotation/automatic cleanup. A saturation test proves fail-closed admission and continued retrieval of existing duplicates. Matches/outbox/receipts can only be created by admitted operations, so the prototype cannot grow without bound by accepting unlimited keys. Routine live reads should ultimately use the iteration-6 read-only API rather than consuming receipt keys.

Future: replace the monolithic bounded ledger with indexed durable operation/receipt rows in the single destination DB. Use core-assigned immutable session/match/operation namespaces, explicit storage quotas and closed-session fences. Archival/compaction requires a proven sealed session, no in-flight or Unknown outcomes, confirmed outbox state, verified archive and a permanent deny/replay-proof boundary. Preserve exact operation-key/payload identity/terminal result tombstones or an authoritative sealed-namespace record that rejects all replay attempts. Hot/cold movement must have an atomic authoritative manifest before any deletion; a file copied to an archive is not proof. Read-only archives, integrity verification and recovery routing need tests. When safe proof or disk budget is absent, fail closed; do not reset to a fresh ledger or remove old keys. No archive/compaction implementation is claimed here.

### Focused validation

9 prototype tests passed: atomic rollback/commit, duplicate/conflicting keys, revision/capability/payload limits, history, updated/reconnect/post-game states, overlay cache/IPC DTO serialization, local Unknown proof, uncertain external delivery, terminal Rejected persistence across reopen, corruption/missing-table refusal, retention saturation and abrupt exits before/after commit. The crash child fixture is ignored standalone and explicitly invoked by its parent.

6 existing durable-store tests and 4 selected effect-model tests passed (19 total). Rust checks target touched domain/host crates. No frontend changes/tests, full suites, production builds, Tauri bundles, old overlay/Silero rebuild, dependency install, cache cleanup, native WebView, Windows or real game smoke. Real power loss, live delivery confirmation and migration on actual user data are unverified.

## Options

1. Independent commits between history and infrastructure DB: cannot provide the required atomicity; rejected.
2. Move history to a new runtime store now: changes user storage and requires risky migration; rejected for this iteration.
3. Prove a single-file temporary prototype, then plan additive ledger/receipt tables at the unchanged production history path: chosen. Migration requires separate approval/testing and is not executed.

## Recommendation

Keep execution test-only and external Dota replay-only. Use local receipts for local transaction recovery; never infer remote success. Preserve existing detector/watchdog/MMR rules and outbox contracts through a future shared transaction facade instead of replacing them with this simplified storage prototype.

## Follow-up

Next implement the transaction-aware facade on temporary copies of the real existing schema, with full match/session/rating/outbox write-set parity and migration/rollback rehearsals. Resolve backend Unknown confirmation/account binding, complete session/correction event coverage, authoritative fencing, persistent retention/tombstones and native/Windows streaming verification before activating external live Dota.

## Sources

Repository source: `local_runtime/{detector,store,watchdog,schema,sync}.rs`, `dota-domain/{gsi,model,effects,match_transactions}.rs`, `core/{plugin_durable,plugin_match_transactions}.rs`, `apps/api/src/{controllers/stream/sync,services/stream-sync-service}.ts`. Known code paths and actual source were read directly; no external sources were required.
