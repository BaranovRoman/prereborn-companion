# Companion: production Dota IPC and exclusive admission (iteration 14)

## Question

How can the installed Dota executable use the existing GSI listener, production transaction adapter and core transports without running alongside BuiltIn or replaying uncertain effects?

## Current state

Base: `7ccdc3e`, branch `codex/plugin-runtime-prototype`. The implementation is compiled production code, with the normal listener routed through an admission gate. **User activation and the developer entrypoint remain closed. This is not an enabled or beta-ready live runtime.** No user database was opened by the checks; all migrated/installed fixtures were temporary.

### Connected paths

- `dota::handle_gsi` admits BuiltIn synchronously, or queues the whitelisted DTO for External. The existing `127.0.0.1:3665` listener, HTTP acknowledgement, backend forwarding and parser remain in place. No additional listener or diagnostic harness was added.
- `LiveProcess::process/consume` uses the existing Runtime and actual IPC v1 `MatchExecute/MatchReceipt` and `GameEffect/GameEffectAck` envelopes. Match plans are computed by the real external Rust executable using shared algorithms and the existing receipt-driven worker state. Diagnostic messages remain a separate wire family.
- A signed installed manifest may explicitly declare `dota.match.execute`, `dota.sound.play`, `dota.obs.scene`, `dota.overlay.update`. Hello/replay grants cannot acquire execution. An opaque grant binds manifest/executable hashes, version, session and lease. `start_verified` binds the verified executable/handshake to a fresh process generation. A restarted process cannot reuse the old binding.
- Lock order is Manager pin → process mutex → existing history/adapter mutex. Reverse callbacks reuse the pin; none reacquires Manager. History is released during IPC and native transport/file IO. There is no additional SQLite writer/connection coordinator.
- The production adapter verifies scope during ticket preparation and preconditions inside the match transaction. Match/session/rating/outbox/ledger/receipt still use the existing single transaction. Worker post-state must match the response actually saved by the host; an untrusted echoed success cannot authorize effects.
- Core callbacks use the existing sound binding/asset/volume resolver, OBS semantic resolver/mappings/transport, and local overlay transport. Sound requests include the detected item/ability kind; arbitrary files, scene names, SQL, URLs and credentials are not IPC inputs. Managed sound reads are bounded and reject traversal/symlinks.

### Exclusive ownership and fallback

`LiveDota` modes are BuiltIn, Draining, External, Fallback. Normal startup is BuiltIn without creating safety tables or starting a plugin. An already migrated database with External/Draining/Vacant or invalid safety metadata blocks ingestion until an explicit restart fence; it does not silently restore BuiltIn or activate External. If the existing transaction-coordinator sidecar indicates a safety attempt, missing/unopenable storage or a missing safety namespace also blocks BuiltIn; an ordinary unmigrated mirror failure keeps its previous behavior. No new marker/path is introduced.

Handover closes admission, drops queued frames, waits up to 5s for admitted work, persists Draining, then requires a concrete old-owner fence. The new process handshakes while durable ownership is still Draining and cannot execute; confirmation issues exactly the next epoch before opening admission. An error leaves admission closed. BuiltIn GSI, lifecycle/watchdog sweeps, scheduled OBS operations and queued sound-file tasks participate in admission; sound tasks inherit their parent's admitted work even after draining starts.

External → BuiltIn additionally requires confirmed termination of the owned child and no unresolved ledger entries. Kill/timeout alone is not proof. Reap polls for at most 250ms and retains an unconfirmed child handle. The fallback retains all keys/receipts and advances the BuiltIn epoch. Native fallback resets old sound-diff/pending state and OBS retries while admission is closed, preventing a diff against pre-handover input. Overlay scene publication freezes during Draining/Fallback; raw GSI cannot change it without an admitted owner. Unknown blocks fallback rather than claiming the sound/scene finished. No SQLite backup is restored.

The queue has capacity 8 and never waits on IPC/history at ingress. Overflow, invalid projection and mutex contention mark a gap; backlog is discarded and fenced fallback is required. There is no replay of potentially incomplete live history. Idle child exit is polled every 50ms; Manager shutdown also closes admission. A failure from an old lease cannot overwrite the new owner's mode.

### Durable effect semantics and bounds

Effects share `pc_tx_ledger` / `pc_tx_receipts` / quota counters in the existing migrated history connection, not the older separate infrastructure DB or the 256-entry in-memory model. Match keys cannot use the reserved `effect:` prefix. Before native IO, one transaction stores payload identity, session and an Unknown acknowledgement. A fresh private admission token permits one dispatch; a duplicate returns the saved result and cannot dispatch again. Confirmed completion/rejection settles ledger and receipt together; receipt-byte exhaustion during settlement leaves Unknown intact.

OBS completes on a confirmed WebSocket response or skips IO for the core's known already-active mapping. That cached skip is not a fresh observation of OBS; reconnect/settings inputs remain a beta blocker. Transport ambiguity remains Unknown. Audio emission is **not** proof of playback completion and always remains Unknown after dispatch. Overlay completion means publishing the core-owned state consumed by the existing local renderer, not proof that OBS displayed a frame. Core independently stops further effects after Unknown even if a plugin claims otherwise. No exactly-once claim is made for audio/OBS.

IPC envelope: 64KiB; execution request: 20KiB; reply: 40KiB; native effect request/ack: 2KiB, at most 32 per command. Existing pipe queues are bounded (writer 1, reader 64), with 2s send/reply deadlines. Core SQLite has its existing busy timeout; OBS IO keeps its existing socket timeout (up to 4s). **The 2s IPC deadline is not a hard wall-clock bound on a synchronous native callback.** Slow callbacks can overflow the queue and fence the owner; they do not make the GSI thread wait.

### Capacity assessment

No ticket/operation key is created for an absent/empty detector plan. OBS/overlay keys are created for semantic state changes; sound keys for actual detections. Active-match legacy telemetry/resume SQL really writes on each parsed tick, including last-seen timestamps; dropping these writes would change current semantics and was not done.

| Input / resource | Estimate or current limit |
| --- | --- |
| 1 active GSI/s | 3,600 match transactions/hour |
| 10 active GSI/s (0.1s cadence) | 36,000/hour; 288,000 in 8 hours |
| Additional example: 2 sounds/min, 30 scene transitions/hour | 120 sounds + 60 scene/overlay admissions/hour (assumption, not measured) |
| Current durable keys/tickets | 10,000 each, cumulative across sessions |
| Current receipt/ticket bytes | 64MiB each; revision identities 100,000 |
| Measured synthetic chain | 5 match receipts, 12,709 bytes total; mean 2,541 bytes |
| Key limit alone at 10/s | about 16.7 minutes, before effect admissions |
| Worst permitted 32KiB receipts | 64MiB at 2,048 receipts, about 3.4 minutes at 10/s |

The synthetic mean is not a production distribution; growing outbox receipts can increase it. The supported policy upper bounds (1,000,000 keys, 1GiB) are **not** automatically applied and do not prove safe retention. No keys/Unknown entries are deleted. Quota exhaustion fails closed. The read-only `dota_runtime_safety_status` Tauri command exposes mode, epoch, queue/in-flight/lost counters, blocked activation reason, remaining operation/ticket/receipt capacity and Unknown count; it does not migrate/open an adapter or expose payloads. No new UI page was added.

### Automated checks (macOS, isolated data only)

| Targeted check | Result |
| --- | --- |
| `core::dota_live` | 11 passed: signed executable/real IPC, per-transition full write-set parity, receipt recovery after commit/lost reply, repeated recovery, Unknown, epoch/generation fencing, missing migration/backup/capabilities, hang/nonblocking queue, fallback, exhaustion |
| `host_execution::live_effects` | 5 passed: duplicate/conflict/stale scope, no-op allocation, crash/reopen Unknown, key exhaustion, atomic byte-quota failure during settlement, bounded corrupt admissions |
| `host_execution::tests` | 11 passed, including actual crash children before/after commit, rollback, conditional identity resolution, concurrent stale tickets, corrupt receipts/storage, full write-set parity |
| `core::plugin_runtime` | 8 passed, including failure isolation from core/Twitch state, reverse-request/Hello restrictions and bounded stdin writer |
| `core::plugin_manager` | 6 passed, 1 previously ignored packaging test; signed grants, tampering, replay/Hello/unsigned rejection and closed registry activation |
| `local_runtime::transaction_schema` | 11 passed: verified WAL backup, idempotence, rollback restrictions, corruption, quotas and second coordinator (including another process) |
| `local_runtime::transaction_tests` | 6 passed: frozen legacy/full write-set parity and migration rehearsal |
| Protocol / domain effects / signed manager tests | 2 / 4 / 3 passed |
| Changed plugin crates `cargo check --offline` | passed |
| Managed audio asset boundary | 1 passed: parent/absolute paths, symlinks and oversized files rejected |
| Core `cargo check --lib --offline` and `git diff --check` | passed |

68 targeted tests passed, with one pre-existing ignored test; child executions are included in their parent scenarios, not counted twice. Node built-in crypto and Python stdlib create disposable signed fixtures; the private key stays in memory. Only the changed Rust worker executable was built for IPC tests. No full suite, frontend bundle, Tauri app/DMG/NSIS, Silero/old overlay rebuild, native WebView, Windows or real game/OBS/audio smoke ran. Rustfmt is absent in the installed toolchain; no dependency/component was installed for formatting.

## Findings

**The release/developer activation gate cannot currently be opened safely.** The principal missing proof is frontend playback cancellation/completion: current audio emits into WebView, and already queued/playing audio outlives a Rust callback. Core does not have a selective acknowledgement/fence that leaves Twitch/TTS intact. Legacy draft reminders using the shared TTS queue also need an explicit game-only fence.

Other live blockers are concrete production inputs, not another harness:

- External forwarding currently drives detector plans for a resolved session; independent watchdog ticks and new/streamed session start/end inputs are not executed by External. Existing legacy lifecycle/watchdog writes are paused during External. Core OBS streaming/config changes and manual session actions need receipt/revision-aware routing, including legitimate concurrent sync/manual writes changing preconditions.
- Core native OBS dispatch reuses the semantic resolver and one transport attempt. Missing-scene recovery, mapping changes/reapply and stream/manual changes without GSI still need preservation across External ownership. Scene-transition-only intents cannot alone reproduce every existing retry/settings behavior.
- Default quotas cannot cover an ordinary long stream at current telemetry cadence. Long-term indexed retention/tombstones or an explicit validated beta budget must be implemented without deleting reusable/Unknown keys or changing detector timing silently.
- Windows child fencing, native WebView audio cancellation and real game/OBS stream transitions remain unverified. The current signed distributed Dota package remains replay-only; live fixture packages are generated only in temporary test directories.

## Options

1. Open a developer flag with inferred fences or declare emitted audio completed. This would conceal unresolved playback and enable unsafe fallback; rejected.
2. Keep the real connected code gated, preserve BuiltIn startup, and require verified migration/backup plus concrete fences. Chosen. Tests use actual signed installed processes and temporary real schemas; production does not use a new diagnostic storage harness.
3. Throttle telemetry or erase old keys to fit quotas. Rejected for this iteration: it changes behavior or loses repeat protection without a demonstrated retention rule.

## Recommendation

Keep user and developer activation closed. Native callback implementations are present, but **no actual game/audio/OBS/overlay effect was executed by validation**; transports in production IPC tests return controlled acknowledgements. Windows beta must not be described as enabled on the strength of these tests.

## Follow-up

Iteration 15 should complete production fencing and inputs:

1. Add bounded, epoch/session-scoped audio playback acknowledgements and selective game-audio cancellation in the existing frontend sound engine. Fence pending asset reads, emitted requests and playing audio; leave Twitch/TTS intact. Identify/fence Dota draft-reminder TTS separately.
2. Route OBS stream/config/manual changes, session resolution/start/end and watchdog ticks through the existing shared algorithms/host facade. Use actual receipts/revisions to refresh context after legitimate core changes; preserve missing-scene/settings/retry rules while keeping ambiguous OBS results non-repeatable.
3. Add an explicit core-only recovery path for migrated Draining startup, using confirmed child/transport fences and a fresh BuiltIn epoch. Keep safety tables, Unknown and all receipts. Do not restore old backups after new writes.
4. Establish a tested long-stream budget/retention policy, expose consumption warnings in existing diagnostics, then prepare a signed Windows live candidate package. Only after fencing, backup/migration, quotas and these inputs pass may a narrow developer activation flag call `handover_external(...).consume(app)`.
5. Run scheduled Windows native WebView/OBS/game smoke and BuiltIn rollback under interrupted IPC/audio. Preserve the stable build and updater until those gates pass.

No further diagnostic harness is needed.

## Sources

Repository source inspected: `apps/companion/src-tauri/src/dota/mod.rs`, `server/mod.rs`, `core/dota_live.rs`, `core/dota_live/ipc.rs`, `core/plugin_runtime.rs`, `core/plugin_manager.rs`, `local_runtime/host_execution.rs`, `local_runtime/transaction_authorization.rs`, `local_runtime/transaction_schema.rs`, `local_runtime/lifecycle.rs`, `local_runtime/watchdog.rs`, `obs.rs`, `game_sounds/mod.rs`, `overlay_server.rs`; `plugins/dota/src/diagnostic.rs`, `plugins/dota/src/live_effects.rs`, `plugins/dota-domain/src/match_shadow.rs`, `effects.rs`, `match_execution.rs`, `plugins/manager/src/lib.rs`, `plugins/protocol/src/lib.rs`. Prior record: [production transactions](companion-production-transactions.md).
