# Match Detector Shadow Mode — iteration 10

## Question

Can the existing match/watchdog decisions run externally on the exact pre-write context of each observation, while all actual operations remain with built-in Dota?

## Current state

Baseline `9882462`, branch `codex/plugin-runtime-prototype`. The only GSI listener remains `127.0.0.1:3665`. External execution still requires explicit debug `--dota-gsi-observer`/PREREBORN_DOTA_BIN; installed Dota remains disabled and user activation blocked. No history schema/data migration, ownership handover, effect dispatcher, settings/path/identifier/updater or OBS/audio/Twitch/TTS/backend/overlay change.

## Findings

### Shared algorithms and legacy adapters

`dota-domain::match_shadow` owns the original identity/reconnect rule (game ID dominates; otherwise team, five-minute interrupt window and new-match signals), new-match evidence gate, leave decisions, post-game winner resolution/first observation/confirmation/conflict, stale distinct-match interruption, probable/confirmed confidence, and gameplay-session closure predicate. The complete ordered detector decision plan is shared with legacy, rather than a second worker implementation. Core `detector::handle_snapshot` retains its signature and delegates through a compatibility adapter; its store executor performs the same resume/create/lookup/telemetry/pending/finalize/interrupted/review operations in their original order. UUID generation, INSERT OR IGNORE and conditional lookup remain in the real store. The outer local-runtime session resolver and session-ending writes remain core-owned, using the shared evidence/closure predicates.

Watchdog shares the original 20-minute threshold, chronological staleness predicate and sweep eligibility. Existing SQL chooses candidates and the real core sweep still performs interruption. The external report distinguishes `stale` from `autoInterrupt`: silence alone is not recovery. Importantly, the SQL cutoff is a **lexical comparison of persisted RFC3339 TEXT**, while status staleness parses timestamps. The shared eligibility predicate preserves that original difference; a test compares actual SQL at the `Z` vs `+00:00` boundary. This iteration does not silently normalize persisted timestamps or change recovery policy.

No MMR formula, store SQL/schema, history/outbox transport or game parser was rewritten. Bad timestamp wall-clock fallback is injected from core into the pure plan; malformed context timestamps are explicitly inconclusive externally, never positive parity evidence. Pure domain code performs no clock reads, SQLite/network calls, UUID generation or effects.

### Frame-bound read-only API

The legacy entrypoint resolves the same session as before, builds its pre-write match context under the existing LocalRuntimeState connection lock, and uses that exact context for detector execution. When the observer is active it captures a minimal immutable DTO from that same context, adding actual session flags before match writes. Dota's original OBS/sound/local-runtime/draft fan-out order is preserved; afterward only this DTO plus the projected GSI is queued. Context is not obtained by querying arbitrary current state from the IPC worker later.

DTO fields: existing local/session UUID, optional game match ID, state and pending result, authoritative team, ranked mode, started/last-seen/interrupted timestamps, session ended/streamed flags, core observation/fallback time, frame sequence and SHA-256 of the allowed typed snapshot. There are no backend IDs/payloads, account IDs, rating values, auth, SQL/URLs/paths or arbitrary history rows. Snapshot binding and sequence are validated. Strings are bounded; input projection reserves 8192 bytes for context/envelope within existing IPC frame limits. Replies used by diagnostics are typed and capped at 8192 bytes.

`revision` is explicitly **None** because legacy has no stored revision column; the fingerprint binds the GSI projection and is not a pretend database revision/CAS fence. New-match plans carry a conditional creation intent, not a fabricated local UUID. Existing identities are preserved on resume/hero changes. Conditional INSERT OR IGNORE/store outcomes that contradict predicted gameplay-session closure mark context inconclusive rather than hiding the difference. Store failure likewise invalidates shadow comparison. These are remaining execution dependencies, not a simplified replacement store.

### External execution and silence ticks

Replay IPC v1 now accepts optional typed match context and returns optional typed matchAnalysis. Existing context-free replay callers still work. A freshly rebuilt worker is required; old workers fail closed on unsupported input/commands. No new Hello grants or user-installed plugin activation was added.

The worker invokes the shared planner on the projected snapshot/context and returns ordered actions, existing identity, evidence, pending result and confidence. It never executes them. The original watchdog sweep additionally queues a read-only pre-sweep context when diagnostics are active. A separate `dota.watchdog_shadow` command evaluates this without applying an empty snapshot to the sound replay state. Thus total GSI silence can still produce watchdog diagnostics without a second listener/timer/write coordinator. Missing/no-active context is represented explicitly; watchdog-only observations do not overwrite the last detector decision.

The bounded queue, try-lock producer, write/reply deadlines, process crash isolation and explicit restart remain from iteration 9. Snapshots and watchdog jobs share a core sequence/mailbox; received/processed/lost counters therefore count diagnostic jobs, not only HTTP requests.

### Parity and inconclusive semantics

Detector and watchdog each expose state matched/mismatched/inconclusive, counters, reason, capturedAt and last legacy/external typed analyses. Their freshness/generation tracking is independent: a fresh sweep cannot refresh an old detector result. Both old contexts and contexts delayed more than five seconds are inconclusive. The first observation after reset/start/restart, frame loss/overflow/reconnect, missing/unbound/invalid context, absent detector game state and uncertain store outcomes cannot count as match success. Resets and reconnects have separate counters. A malformed or oversized external analysis is not exposed as a decision.

Matching compares semantic actions, existing IDs, game IDs, evidence, result/confidence and watchdog predicates, not merely a reply. These diagnostics compare actual shared legacy computations; they do not prove effect delivery or that a conditional creation/store operation succeeded. Native debug event/UI receipt is not measured here. Raw GSI/account data is not added to logs; debug stderr remains counters/fixed error codes. Status/control use the existing iteration-9 debug IPC/event surface; no frontend changes.

### Focused verification

55 targeted tests passed:

- 20 existing detector tests: actual SQLite lifecycle, confirmation/conflicts, reconnect/identity, distinct-match stale handling and evidence gates.
- 7 existing watchdog tests: stale threshold, actual mock-core sweep/idempotency and manual recovery policy.
- 3 new match-shadow tests: real external process plus real SQLite/legacy executor over 18 synthetic GSI observations (start/resume/hero/partial/interrupted/reconnect/confirmed/probable/ambiguous/review/session-ended), actual SQL/watchdog comparisons, privacy/bounded/unbound/malformed context checks. Existing IDs remain stable; confirmed win changes the real fixture rating through the unchanged store implementation.
- 14 observer tests: existing process/overflow/privacy/error isolation plus independent detector/watchdog parity, stale/unbound/reset/restart/loss inconclusive, deliberate semantic mismatches, watchdog-only sound-history preservation and independent freshness.
- 6 existing Runtime tests including read-grant/core-state isolation and nonreading-child writer deadline.
- 5 targeted domain replay regression tests.

Host library cargo check passed. Four pre-existing durable/facade dead-code warnings plus two intentionally retained legacy compatibility entrypoints remain. The independent Dota debug executable was built offline; domain adds cached chrono with clock/default features disabled and cached sha2 for typed time/fingerprint. No heavy dependency installation.

No full suites, production build/Tauri app/DMG/NSIS/bundles, old overlay/Silero rebuild, cargo clean, frontend checks, native WebView, Windows or real game/GSI smoke were run. SQLite fixtures are in-memory and anonymous; no user history database was opened or migrated. Unix crash/hang fixture coverage is not Windows process-cleanup evidence.

## Options

1. Copy legacy detector/watchdog into worker or create simplified rules: rejected; diverging algorithms.
2. Read current DB state after a queued frame: rejected; mismatch with the original observation.
3. Common ordered pure plan, legacy store adapter, frame-bound immutable context and explicit inconclusive handling: chosen.

## Recommendation

Keep this shadow-only. Resolve conditional store outcomes/identity receipts and persisted revisions before treating the context as an execution precondition. Validate real GSI and Windows/native behavior before handover. Current epoch/ledger infrastructure is still unwired to live ingestion; no exactly-once/ownership guarantee is claimed from parity results.

## Follow-up

Next practical slice: implement a diagnostic host adapter that resolves conditional plan operations and returns typed identity/post-state receipts on isolated copies of the real schema, using the existing transaction facade. Compare the full decision/write set and gameplay-session closure, including duplicate match-key recovery, without touching user history. Only afterward prepare live capability/epoch fencing, atomic ledger/outbox admission, revision/migration/rollback policy and Windows smoke gates. Core must remain the sole credential/OBS transport/Twitch/TTS and write coordinator owner.

## Sources

Repository sources: local_runtime detector/watchdog/mod/store, new domain match_shadow and context contracts, core observer/runtime, Dota worker and targeted tests. No external research sources or new backend contracts.
