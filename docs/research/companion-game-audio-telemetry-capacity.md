# Iteration 15: game audio fencing and telemetry capacity

## Question

How can the existing production runtime stop only game audio and avoid allocating an immutable receipt on each telemetry tick, while preserving the built-in Dota runtime?

## Current state

Branch `codex/plugin-runtime-prototype`, baseline `b588667`. Installed activation and the developer entrypoint remain closed. Migration is explicit; no user database has been opened or migrated by these checks. No new listener, execution harness, writer, plugin process architecture, settings or updater changes.

**Iteration 15 is not complete.** This change implements game-only transport fencing and a bounded telemetry register. It does not claim that external session/watchdog/OBS lifecycle or startup recovery is ready.

## Findings

### Game audio

- Core-generated UUID playback IDs carry a core instance, generation, ownership epoch and optional local session (draft can precede a local session). External sounds use the actual granted lease/session; BuiltIn reads the existing local identity without waiting on a busy history mutex.
- The existing sound engine reports queued/playing/completed/cancelled/unknown through two main-window-only Tauri commands. The draft reminder uses its existing independent Silero player and the same game-only registry. Twitch/TTS implementation and queue are unchanged.
- A fence closes core admission before sending the request. Asset reads check the token again before emitting. Frontend revokes the generation before cancelling pending/active players, calls pause, clears src, aborts loading, and verifies paused. Late synthesis results and notifications cannot start revoked playback.
- Stop proof requires a matching request UUID/instance/generation and successful frontend cancellation ACK within two seconds. Emit, pause-request, child exit and timeout are insufficient. Unconfirmed cancellation retains the player cancellation callback, so a second fence cannot falsely succeed.
- Production fallback now performs the game-only frontend fence after process exit and before confirming a new owner. Its existing Unknown ledger check remains conservative. A missing frontend leaves Draining blocked.
- This is a transport stop proof, **not durable sound completion reconciliation**. `dispatch_plugin_sound` still returns Unknown; frontend completion has not been attached to its persisted effect receipt. Normal asynchronous playback therefore cannot yet continue as a successful live effect. Developer activation stays closed.

### Telemetry register

- Production preparation selects a `telemetry:<epoch>:<local UUID>` register only for canonical ordinary active Resume/Ensure/Telemetry plans or a post-game-pending telemetry-only plan. Real detector decisions, facade calls and SQL run at the original frequency. Create/finalize/review/interrupted/session/rating/outbox/effects retain immutable operation keys.
- The existing indexed ticket/ledger/receipt tables are reused; schema and quotas are unchanged. Only the latest **confirmed telemetry register value** is superseded. Unknown, rejected or uncommitted values cannot be overwritten. No rows or irreversible keys are deleted.
- Core checks monotonic sequence and persisted commit identity before replacing a ticket, then revalidates the current epoch, canonical plan and real revisions inside the execution transaction. Old bindings/epochs cannot execute; a duplicate of the latest request returns the saved receipt. ABA after preparation rejects execution without changing legacy rows.
- Match/session identity is not regenerated. A new epoch gets a separate register, retaining old receipts and Unknown. Byte quotas are checked for updates as well as inserts.
- Reverse effect requests must belong to the actual process generation/frame and a canonical unique index 0..31. Replay keys and repeated indices cannot introduce a second effect within the command.

### Lifecycle

The existing pure OBS/session decisions are moved to `dota-domain::session_lifecycle`; legacy public names and SQL/application behavior are preserved. Existing 30-second grace, 12-hour stale threshold and gameplay-session graduation rules are unchanged. **External routing is not implemented**: the existing sweeps still only admit BuiltIn. Manual actions, session rebinding and OBS reapply/reconciliation need the production receipt/context path before activation.

## Options

1. Increase quotas: rejected; at 10 Hz immutable telemetry consumes 288,000 keys in eight hours.
2. Delete old arbitrary receipts: rejected; replayable keys and Unknown must be retained.
3. Keep irreversible operations immutable and use a fenced monotonic register for ordinary telemetry: implemented. Superseding confirmed telemetry is safe because it is a state observation, has no independent outbox/native effect, and older bindings cannot be admitted.

## Recommendation

Keep the developer gate closed. The telemetry register solves snapshot-proportional key growth for eligible frames; it does not establish an unlimited budget for sound/OBS/history intents. Quotas still fail closed and remaining capacity is available through the existing safety status.

## Validation and budget

- Targeted frontend engine/registry/reminder tests: 24 passed; TypeScript passed.
- Actual Twitch hook isolation test: an active utterance and the next queued Twitch message survive a game-only fence.
- Targeted rolling-register tests (3 passed) cover duplicate/latest receipt, stale sequence, pending commit, full write-set rollback, Unknown, restart/fresh epoch, retained old receipt, ABA preconditions and refusal to restore an old backup after writes.
- Real verified installed Rust worker round-trip checks receipt-driven rolling telemetry over multiple frames.
- Explicit long-stream test invokes production preparation and execution on every frame using temporary real SQLite/WAL. No clock delay and no native transports. **288,000 frames passed**, 973.96 seconds of wall time. Two ledger rows and two tickets remain (initial identity resolution plus the telemetry register); receipts use **6,054 bytes**, tickets **2,131 bytes**. Remaining: 9,998 operation keys, 9,998 tickets, 67,102,810 receipt bytes; Unknown = 0. Match revisions advanced by exactly 576,000, proving both actual writes ran on each tick. Final schema/integrity/quota validation passed.
- This is the measured budget for one continuous eligible match/epoch. Irreversible match transitions and sound/OBS intents are **not included** in those counts. Default quotas remain 10,000 keys/tickets and 64 MiB per byte category. A full eight-hour live workload including effects is not yet certified; quotas must not be raised or Unknown deleted to hide that gap.
- Native WebView, Windows, OBS/audio devices and real game smoke are not run. No production bundles, Silero/overlay rebuild, full test suites, cargo clean or dependency installation.

Final selected checks: 68 distinct Rust tests, 25 frontend tests (24 engine/registry/reminder + 1 actual Twitch queue isolation); core and domain `cargo check --offline`, frontend `tsc --noEmit`, and `git diff --check` passed. The core check retains dead-code warnings for gated infrastructure (70 warnings); no warnings were suppressed. No full suite or native smoke was substituted for these checks.

## Follow-up

Before Windows beta, complete these functional paths in the existing production components:

1. Attach frontend completion/cancellation proof to the admitted durable sound receipt; distinguish a pending playback from an uncertain result without automatically retrying either. Current emit-only Unknown remains a real blocker.
2. Route OBS truth, watchdog ticks and manual session actions through the current owner/coordinator. Resolve new sessions, return actual receipts and refresh the worker context when core writes advance revisions. Currently its strict previous-receipt context comparison rejects such changes.
3. Preserve external semantic scenes across config/manual/reconnect events. Reconcile an ambiguous OBS result before any retry; do not infer success from a cached scene name.
4. Persist enough process-generation identity to prove the previous process is gone after startup. A fresh Runtime with no child handle is not evidence about an older process. Keep migrated Draining blocked until process, audio and OBS fences are proven; preserve Unknown/receipts and issue a fresh BuiltIn epoch, without backup restoration.
5. Measure irreversible intent rates and byte costs across realistic multi-match eight-hour streams. The measured telemetry budget alone must not open the developer gate. Require verified package grants, backup/migration, sufficient quotas and all fences before enabling its narrow entrypoint.

## Sources

Repository implementation: `core/dota_live/ipc.rs`, `game_sounds/audio_fence.rs`, existing frontend sound/reminder engines, `local_runtime/host_execution.rs`, `transaction_authorization.rs`, `transaction_schema.rs` and the original lifecycle rules. No external sources or new dependencies.

Developer safety status now names the remaining gate explicitly: `external_lifecycle_audio_receipts_obs_and_restart_fencing_incomplete`.
