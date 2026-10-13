# Diagnostic Dota request/receipt bridge — iteration 12

## Question

Complete the diagnostic execution round-trip with the existing external Dota process,
prove capability/session fencing and receipt-driven context, then stop prototyping and
identify the actual production integration work.

## Current state

The iteration-11 adapter executes real facade/store SQL against privately owned temporary
copies of the real schema. Legacy is still the only live runtime. IPC v1 already provided
the bounded reverse read request pattern. Production PluginManager activation of Dota is
still blocked. No GSI listener, history paths, settings, updater or identifiers change here.

## Findings

### Actual process round-trip

1. Fixture host prepares and persists the existing snapshot/context ticket, binding and
   preconditions, then sends `dota.diagnostic_frame` through `Plugin Runtime`.
2. The debug Dota executable computes the canonical `match_shadow` decision itself and
   sends IPC v1 `diagnostic_execute`. No adapter call substitutes for that process exchange.
3. Runtime permits one reverse request with the current command ID and expected identity.
   Host checks the typed request and diagnostic scope, then invokes the existing adapter.
4. Ownership, session, expected ticket, sequence, fingerprint and ticket integrity are
   checked **inside the same SQLite transaction** as preconditions and actual writes.
5. Adapter commits match/session/rating/outbox/revisions/ledger/receipt together. Runtime
   sends `diagnostic_receipt`; worker validates it, adopts confirmed context and replies.
   Host checks that the acknowledgement equals the receipt it actually sent.

No generic SQL/path/URL executor was added. Wire envelopes follow the existing Value-based
protocol convention, but both endpoints deserialize bounded, deny-unknown-fields domain
DTOs. Frame maximum remains 64 KiB; diagnostic command/request/reply caps are 32/20/40 KiB;
the adapter retains its stricter 16 KiB request/ticket and 32 KiB saved receipt caps.

### Capability and fencing

- `dota.diagnostic.execute` is a separate, **host-issued** grant. The Runtime entry point
  granting it is `cfg(test)`; read grants, replay commands, Hello and Ready cannot grant it.
- Runtime checks its handshake-verified expected `dota2` identity/version, command name,
  correlation ID and one reverse request per command. Outside that call, reverse execution
  fails and reaps the process. Handshake fields are not cryptographic executable attestation;
  this harness runs an explicitly trusted locally built binary. Production package signature
  verification remains the existing manager's responsibility and is not bypassed for activation.
- The fixture-only host persists the existing `Ownership::Phase` plus local session/run in
  `pc11_diagnostic_owner`, in **temporary fixture SQLite only**. This does not read/write the
  production ownership database or connect production leases to GSI.
- `DiagnosticScope.epoch` is a process/session ownership counter, separate from
  `Preconditions.epoch` (the fixture write counter). Run UUID also fences reset/restart.
  Active must authorize External at the exact diagnostic epoch; Draining and Vacant reject
  both execution and recovery. Session/run mismatch is rejected before real store operations.
- Reopening Active converts it to Draining, never auto-recovers it. Start requires Vacant.
  Normal restart stops/reaps the owned worker before fencing/recovery. After a host crash,
  the trusted fixture harness explicitly verifies the old worker exited before confirming
  fencing; a fresh Runtime, plugin acknowledgement or timeout is not proof. No production
  cross-platform orphan supervisor was implemented by this diagnostic work.

### Confirmed context

Receipts now include the actual minimal `current_context` and session streamed flag. Legacy
`MatchContext.revision` remains None; persisted diagnostic revisions stay in preconditions.
The host reads a fresh bound ticket and requires equality with the confirmed receipt state;
the worker checks UUID, session flags, actual context and post-write preconditions before the
next frame. Resolved match key/game ID remain in the exact MatchState receipts.

Conditional INSERT OR IGNORE is followed by actual key/active lookup: a conflicted operation
can resolve an existing UUID, and later resume/post-game uses that identity. Skipped actions
do not invent identities. A cached old receipt is returned unchanged but cannot roll back a
newer confirmed context or sequence. Recovery preserves the original operation identity and
never executes missing/Unknown results. Unknown/Rejected/Denied blocks advancement until
recovery or explicit reset. A pending lost frame requires reset; restart clears confirmation,
reaps the worker and creates a fresh epoch/run before a new authoritative ticket is accepted.

### Measured checks

- `local_runtime::host_execution`: **19 passed**, including iteration-11 adapter coverage
  and two child-process harness entries. Full real IPC chain covers resume, interrupted,
  post-game and session closure, and compares every legacy table/column after each frame.
  Conditional key conflict preserves the existing UUID and proceeds through resume/closure.
- Actual host exits before commit and after commit before IPC reply: rollback/Unknown vs
  saved Completed receipt; reopen stays Draining until old worker exit is confirmed. Repeat
  recovery returns the same receipt without new UUIDs or writes.
- Duplicate keys, payload conflict, Unknown, stale revisions, stale epoch, session mismatch,
  Draining/Vacant, reset/lost frames and old-receipt monotonicity are covered through IPC.
  An adversarial test process proves the host rejects a forged fingerprint even when worker
  validation is bypassed. Adapter corruption/atomicity tests continue passing.
- `core::plugin_runtime::`: **8 passed**, including existing lifecycle/read-only/error/timeout
  tests and new adversarial identity/capability/correlation/repeated-reverse/Hello tests.
- `local_runtime::transaction_tests`: **5 passed**, including frozen legacy full write-set
  parity, rollback and migration rehearsal. Diagnostic IPC v1 envelope test: **1 passed**.
- Independent debug executable built with `cargo build -p companion-dota-plugin --offline`.
  Only touched-crate compilation and scoped tests; no full suites, frontend changes, Tauri
  packaging, production bundles, Silero/old overlay rebuild or cache cleaning.
- Native WebView, Windows, real-game and actual-user migration tests were **not run**.
  The Unix crash test uses `ps` only for its fixture worker PID; this required running the
  scoped host tests outside the sandbox. No unrelated processes were inspected or stopped.

## Options

Use a new host service/protocol/framework, or extend the existing reverse-request loop and
fixture adapter. The latter was chosen: one Runtime loop, one existing Ownership state
machine and one transaction adapter. No production dispatcher was introduced.

## Recommendation

Diagnostic infrastructure is complete at the fixture harness boundary. The host/bridge is
`cfg(test)`; worker diagnostic commands are `cfg(debug_assertions)`. This is not a new in-app
debug screen or an installed-plugin execution path. Do not interpret successful local
transactions as exactly-once external HTTP/OBS effects or readiness to switch live ownership.

## Follow-up

Next iteration should implement **production transaction integration**, not another diagnostic
host or replay prototype:

1. Approve the real schema/rollback plan: backup, reserved ownership/ledger/receipt/revision
   tables in the same history transaction DB, preserve UUIDs/keys/outbox and existing paths.
   Define retention before activation; don't auto-migrate the separate prototype databases.
   Rollback after new writes requires restoration/reconciliation, not dropping safety tables.
2. Promote the validated adapter operations into the existing core match writer, route legacy
   and external execution through that same transaction boundary, and verify one coordinator.
   Add real session start/stream/end contexts and compatibility adapters without changing rules.
3. Bind production reverse requests to verified installed packages, explicit scoped capabilities
   and durable live ownership checked in that transaction. Implement ingestion pause/drain,
   process reaping and fenced fallback using the existing state machine. Keep external activation
   off while this integration is being completed; do not keep a parallel diagnostic mechanism.
4. Complete typed OBS/audio/overlay effect dispatch and backend/outbox Unknown reconciliation
   so disabling legacy handling does not remove those features. Core keeps sockets, tokens,
   SQLite and network authority; the plugin only submits bounded intents. No false exactly-once
   guarantees, secret access or repeat HTTP calls after an uncertain result.
5. Run required Windows/game/OBS/overlay smoke and backup/rollback checks before controlled
   activation. At handover, built-in Dota handlers must be fenced before external live handling
   begins; the existing single GSI listener remains the producer. Preserve built-in fallback.

Current blockers are those production storage/activation/fencing/effect integrations and
platform smoke checks. None were silently enabled by this iteration.

## Sources

Repository: `plugins/protocol/src/lib.rs`, `plugins/dota/src/{main,diagnostic}.rs`,
`plugins/dota-domain/src/{match_execution,match_shadow,ownership}.rs`,
`apps/companion/src-tauri/src/core/plugin_runtime.rs`,
`apps/companion/src-tauri/src/local_runtime/host_execution{.rs,/bridge.rs,/bridge/tests.rs}`,
`transaction_facade.rs` and existing store/detector/sync implementations. No external
research, new dependencies or architectural framework was needed.
