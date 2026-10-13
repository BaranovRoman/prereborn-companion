# External Dota: iteration 16 / Windows beta readiness

## Question

Can the production External paths complete admitted audio, maintain session identity and reconcile OBS, without changing ordinary BuiltIn startup? What still prevents developer activation?

## Current state

Work continues on `codex/plugin-runtime-prototype` from `bdb8f41`. Installed Dota activation and the developer activation gate remain closed. No CLI, registry restore or updater starts External. The user database was not opened or migrated by this work; migration/recovery checks use temporary files with the real schema. No application bundles or native/game smoke tests were run.

## Findings

### Connected production paths

- An admitted sound is bound to one playback token in `pc_tx_receipts` **before** WebView emission. Its token contains the core instance, audio generation, session and owner epoch; the operation key includes the verified Runtime generation. The main-window ACK validates the exact token. Ledger and receipt updates use one transaction on the existing history connection.
- Audio receipts persist `queued`, `playing`, `completed`, `cancelled` or `unknown`. Queued/playing have ledger status Unknown until a terminal observation; the current live request can return Accepted for that known pending sound. Accepted is not playback success. Cancelled maps to a terminal Rejected effect ACK with an explicit cancelled playback receipt. Terminal receipts do not replay. Restart converts pending playback observations to Unknown without re-admission.
- A frontend Unknown ACK closes External admission. Unload reports Unknown on a best-effort basis; missing ACKs already leave the durable result Unknown. A new/reloaded registry cannot prove stopping playback IDs it never owned. Game-only fencing waits for durable terminal ACKs before dropping pending bindings. No history mutex is held while waiting for IPC or frontend fencing.
- Draft reminder retains the existing latch/decision and separate Silero player. External uses a core-only reminder admission with the same audio ledger/fence. The ordinary plugin sound request cannot request this fixed source. BuiltIn reminder behavior and Twitch/TTS implementation are retained.
- The existing External consumer invokes shared `session_lifecycle` rules, real facade/store SQL, and the existing watchdog cutoff query on the same writer. Lifecycle transitions, watchdog interruptions, outbox and lifecycle receipts commit together. No-op ticks allocate no ledger key. Gameplay closure does not become an OBS stream-end intent; the committed lifecycle decision controls that distinction. Unchanged session/scene flags do not request repeated reconciliation. Production preserves the two-second lifecycle and sixty-second watchdog cadences.
- Session selection follows legacy: an unresolved match's session wins, including a closed session with an interrupted/reconnectable match; otherwise the open session wins; otherwise genuine new-match evidence can create a gameplay session. Reconnect retains identity. A session rebind is committed inside the transaction before updating the verified grant's session.
- The next execution frame carries a bounded, snapshot-bound current context receipt containing real persisted revisions and actual session/match state. The worker accepts a monotonic core refresh for legitimate core/backend writers and session resolution, while rejecting stale/inconsistent refreshes. A write racing with a prepared ticket still fails its transactional precondition. Unknown does not authorize continuing.
- OBS mapping, stream observations/reconnect, manual summary/resume and session closure request reconciliation through the existing effect bridge. An idle observation uses the existing sequence and IPC path, without match writes or sound dispatch. Core still owns settings, credentials and transport.
- External OBS uses fresh correlated `GetCurrentProgramScene` responses, never cached names, to confirm desired state. An ambiguous Set is queried once rather than blindly repeated. An unconfirmed state remains Unknown. Definitive 604 rejection of Post Stream retains the existing Between Matches fallback; this is not retrying an ambiguous Set. Configuration/manual changes during IO invalidate confirmation.
- External OBS uses a 1.5-second owned-socket deadline, including connect/handshakes/requests, and 64 KiB message/frame limits. The socket deadline also closes continuous partial/Ping traffic. The bounded path accepts literal IPv4/IPv6 or local `localhost`; arbitrary DNS hostnames are refused. BuiltIn connection behavior retains its existing path.
- Manual lifecycle/watchdog actions and manual scene IO hold the existing admission gate, so Draining cannot acquire new game writes/effects. Fallback can finish the same drain after a later confirmed fence, with a new BuiltIn epoch; it never clears receipts or restores an old backup.

### Process recovery boundary

The existing owner document now records Runtime generation, verified package identity and diagnostic PID. The journal is committed **before spawn**, including the uncertain no-PID gap. A normal stop is recorded only after the original Runtime's owned Child handle confirms termination. Wrong generations, an empty fresh Runtime, PID absence/reuse, or an unfinished journal cannot prove old-process termination. Startup stays blocked on uncertainty.

This does **not** implement cross-core-restart Windows process supervision. There is no Windows OS supervisor/birth-identity proof in this change. The original owned handle cannot be recovered by trusting a saved PID. Keep the developer gate closed until Windows implements and verifies that proof in the existing Runtime. Native WebView/audio and OBS application behavior are also unverified.

### Eight-hour storage budget

A single explicit targeted test used the existing signed-package fixture, a real Rust worker and production request/receipt bridge, real schema/facade/ledger transactions, twelve forty-minute match cycles, hero changes, six-second observations, stream reconnect/cancel-pending-end transitions, OBS reapply, post-game and final session closure. Audio progress/terminal acknowledgements and transport results were controlled callbacks; no actual sound, OBS, overlay or HTTP effect ran. The stream was already active, so draft reminder firing was zero; its core-only admission/completion is covered separately.

| Metric | Measured |
| --- | ---: |
| Frames | 4,800 |
| Matches | 12 |
| Sound operations | 4,788 |
| OBS intents | 36 |
| Overlay intents | 36 |
| Ledger keys | 4,959 |
| Tickets | 48 |
| Receipt bytes | 2,541,636 |
| Revision identities | 13 |
| Unknown at completion | 0 |
| Remaining keys | 5,041 |
| Outbox rows | 14 |

The workload passed and fenced back to BuiltIn. Mac debug execution took 2,614.34 seconds. This certifies the storage workload, **not** sustained real-time GSI throughput or native reliability. The earlier telemetry-only 288,000-frame measurement remains separate; this test does not claim 288,000 IPC/effect frames. Release throughput, bursts and package-verification costs need Windows measurement.

Limits stay at 10,000 keys/tickets, 64 MiB per receipt/ticket category and 100,000 revision identities. No automatic deletion/compaction was added. Beta preflight reserves 6,000 keys, 256 tickets, 8 MiB receipt bytes, 1 MiB ticket bytes and 256 revision identities, and requires zero Unknown. These are headroom for the tested model, not a guarantee for every possible legal workload. Existing safety diagnostics expose all remaining categories. The default key quota cannot promise indefinite multi-stream usage: a subsequent activation with insufficient headroom is refused; an already running workload fails closed at the actual admission limit.

### Targeted validation

- Real installed-worker IPC: ownership switching, crash/lost reply, cached receipts, stale generation, hang, queue overflow, denied permissions, quota exhaustion, core-writer refresh, session lifecycle, idle/mapping/reconnect reconciliation, core-only reminder and delayed audio Accepted/cancellation.
- Ledger/audio: progress, exact token binding, terminal/Unknown transitions, no re-admission after reopen, stale/forged ACK, byte-quota rollback and durable fence ordering.
- Legacy full write-set parity and crash/recovery, migration/backup/rollback/quota tests on temporary real schemas; new lifecycle full write-set parity and atomic quota rollback.
- Existing lifecycle, watchdog and draft-reminder tests; synthetic OBS socket correlation and hung-handshake deadline tests (localhost bind required sandbox escalation).
- Frontend game registry/player/reminder tests and the actual Twitch hook's active utterance/queued-message isolation test; TypeScript and affected Rust cargo checks.
- A parallel debug IPC test run hit the existing two-second handshake timeout during fixture startup. The affected group is checked serially on this constrained Mac; production timeouts were not increased. Release-mode load/throughput remains a Windows gate.
- Final targeted coverage totals 113 distinct Rust tests and 27 frontend tests. Affected core/plugin cargo checks, TypeScript and `git diff --check` pass. Core check retains 77 gated/dead-code/unused warnings; they were not suppressed.
- Full suites, production bundles, Silero/overlay rebuilds, native WebView, Windows and game smoke were deliberately deferred.

## Options

1. Open activation based on passing fixtures: insufficient evidence for cross-restart process/audio fencing and real-time/native behavior.
2. Keep the gate closed, build a BuiltIn-only Windows candidate, implement/verify the remaining OS fencing inside the existing Runtime and validate the connected paths: chosen. No additional diagnostic harness or parallel runtime is needed.

## Recommendation

Proceed to Windows candidate assembly with BuiltIn as the normal runtime. Do not call the External developer path ready or publish an External beta yet. Rebuild/re-sign a live Dota package matching these IPC v1 frame extensions before native testing; the official installed replay package gains no activation rights.

## Follow-up

Minimal Windows beta gate:

1. Implement OS-specific supervision/termination proof in the existing Runtime. Kill/crash Companion before spawn, between spawn and handshake/journal completion, during IPC and after commit/before reply. Include an orphan process and reused PID. Without proof, Draining must persist; after proof, audio/OBS reconciliation and a fresh BuiltIn epoch must complete without duplicate execution.
2. Verify the actual WebView players: queued/playing/end/cancel, delayed Silero reminder, disabled/missing player, output-device failures, unload/crash/reload, ACK loss and late ACK. Keep real Twitch TTS plus its next queued utterance running during game-only fencing.
3. Verify OBS stream start/stop/reconnect, manual scenes/summary/resume, mapping/config changes, missing Post Stream fallback and ambiguous/lost response. Fresh authoritative responses must be correlated; cached state and timeouts must not authorize retry/success.
4. On temporary copies of real histories, verify backup/migration, manual/backend revision changes, session transitions, reconnect, post-game, stale/conflicted frames, quotas and BuiltIn fallback. Never roll data back after new writes.
5. Measure release-mode real GSI rate/bursts and an actual multi-match stream. Confirm bounded queue behavior, no double writes/effects, receipt growth and remaining quota. Only then wire the narrow manual developer entrypoint with the existing verified package, backup/migration, headroom and all fencing checks. Restart must not automatically activate External.

These are platform implementation/validation and activation work in the existing components, not further architectural prototyping.

## Sources

Repository source: `core/dota_live/ipc.rs`, `core/obs_transport.rs`, `local_runtime/host_execution/{external_lifecycle,live_effects}.rs`, `local_runtime/transaction_authorization.rs`, `game_sounds/audio_fence.rs`, `draft_reminder.rs`, frontend `sounds/game-audio-fence.ts`, and `plugins/dota/src/{diagnostic,live_effects}.rs`. Targeted validation logs are `/tmp/companion-iteration16-*.log`; the measured result and its limits are recorded above. No external research claims are required for the implemented paths.
