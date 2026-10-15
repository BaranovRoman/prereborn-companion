# Standalone Companion and installable Dota

## Question

Implement the user's replacement strategy: no Dota runtime/UI/assets in Companion,
independent signed Dota package, preserved data and updater, followed by a stable release
only after complete package/install/upgrade validation. This supersedes keeping BuiltIn.

## Current state

Starting source: `f8b4805` on `codex/plugin-runtime-prototype`. Stable remains 0.5.94.
The GSI projection correction in `b8282fa` passed unsigned Windows CI but is unpublished.
User changes to `.gitignore` must remain untouched. No user SQLite is accessed.

## Findings

- `dota/mod.rs` still initializes history, sound state, live GSI and workers in core.
- `core/dota_live` fences BuiltIn/External admission and prepared-database restart. A
  blocked admission is not proof of a detector failure. The specific Windows regression
  is not established without runtime status/logs; the filter defect is established.
- Comparing sound handling to 0.5.90 shows added admission/audio-fence checks around the
  same detector/settings path. Silently removing these checks would erase crash safety.
- Dota 0.1.0 has shared analysis and plan execution requests; it does not own SQL,
  backend sync, GSI/overlay listeners or a full game UI. Its UI is a replay view.
- Existing match/session/rating/correction/outbox SQL is reusable without Tauri or
  account credentials. This is an actual relocation target, not an algorithm rewrite.
- AppShell mounts game audio and session hooks globally. Moving its links alone would
  leave game code and assets in the core bundle and would not satisfy physical separation.
- Existing manager permissions, process binding and reverse callbacks use game-specific
  contracts. Full removal also requires replacing these core dependencies with bounded
  generic host operations and moving game transactions/receipts to the game package.

## Options

- Hide Dota navigation while retaining its code: rejected; not physical separation.
- Remove BuiltIn before a complete package replaces all callers: rejected; loses history,
  configured audio, overlay and sync, and is not releasable.
- Relocate the real implementations, retain temporary compatible adapters in the feature
  branch, and remove adapters/core imports before release: selected. No intermediate
  build is published as a finished migration.

## Recommendation

One implementation per subsystem. Move SQL/store/facade/detector to the plugin workspace
first, prove unchanged write sets, then relocate coordinator/receipts and wire worker
execution. Move the real UI into the package with a bounded iframe bridge. The neutral
core must retain the one Twitch/TTS instance, credential owner and generic OBS/audio
transports. Preserve old safety records and require verified backup before schema changes.

## Follow-up

In progress. First concrete relocation is `companion-dota-storage`: original schema,
store, transaction facade, detector, outbox enqueue/status and correction SQL. Temporary
core modules re-export these functions; this is **not yet a Dota-free core**. The current
worker has not been switched to own production storage, and no package/release is ready.

Release gates remain closed until all core game dependencies/UI/assets are removed,
demo/real-match sound paths and migration/recovery pass, Windows CI passes on the full
replacement, and the signed package is installed/upgraded through Plugin Manager.
Native user Windows game/audio/OBS acceptance must be reported separately from fixtures.

## Sources

Repository source and `prereborn-v0.5.90`; no external architectural claims used.

## Extraction checkpoint (2026-10-15)

- Neutral CoreShell is the active root: overview/chat/speech/OBS/plugins/settings.
  Core playback hooks own transport only; the previous game shell is no longer mounted.
- The real store/schema/detector/facade/outbox SQL, transaction coordinator, safety
  migration, durable authorization, indexed ledger, revisions, receipts and history
  projections now live in `plugins/dota-storage`. Core uses temporary reexports.
- Managed audio settings/assets/binding resolution and Steam GSI discovery/config
  generation now live in `plugins/dota`. Existing filenames and data formats remain.
  A strict settings reader preserves invalid/future files; settings saves are atomic.
- Protocol crate owns the single child runtime, Windows job supervisor, opaque package
  identity and playback tracker. Core supplies verified borrowed grants; IPC Hello
  still cannot grant capabilities. Legacy Dota-specific command policies remain until
  the new generic host API and worker ingestion are wired; they must be removed before release.
- Local checks: 600 frontend tests; 144 storage/coordinator regressions plus the
  2 relocated history projection tests; 22 plugin sound/GSI tests; 7 protocol tests;
  7 core runtime tests; 33 core live IPC/fencing tests. Cargo check passes.
- Explicit ignored long-stream test was run without reducing the frame count:
  288,000 real SQLite prepare/commit cycles passed in 1115.99 seconds. Assertions:
  2 ledger rows, 0 Unknown, 9,998 operation/ticket slots remaining, receipts <32 KiB,
  tickets <16 KiB, persisted revision advance of two writes per frame. This is the
  telemetry storage budget, not a real eight-hour game/audio/OBS acceptance run.

This checkpoint is **not releasable**: core still bootstraps BuiltIn and contains game
backend/UI/assets; worker does not yet own production GSI/history/overlay/full UI.
The published 0.5.94 and Dota 0.1.0 are unchanged. No release/signing gate is satisfied
by these relocation tests alone, and no user-native game/audio smoke is claimed.

## Worker ingestion checkpoint (2026-10-15)

The existing Dota executable now has a host-configured worker entry point using
the same IPC commands/replies, runtime and Windows job supervisor. Its manual
Prepare owns the relocated real history coordinator; opening/status/polling do
not create a database, session or listener. Repeated Prepare retains the verified
backup. Launch validates its own executable hash against the supplied package
binding; the caller must still hold the PluginManager's verified signed-package
pin. Neither Hello nor UI command payloads can supply paths or permissions.

The plugin listener binds 127.0.0.1:3665 with admission initially closed, projects
only bounded permitted fields, and queues at most 64 fresh frames. A lost frame
closes admission; the consumer drains instead of continuing a broken history.
Authorized activation uses OS-attested membership in the exact generation job;
unsupported platforms fail closed. The worker processes bounded batches through
the real lifecycle/coordinator and shared sound detector/bindings. Sound intents
are **not playback receipts** and are not executed by this new entry point yet.
Demo sound detection does not fabricate a SQLite session.

Local checks: 29 plugin library tests, 6 real-process IPC tests, 4 strict projection
tests and core cargo check pass. New Windows-only coverage exercises the actual
supervisor, localhost demo/bot GSI, real SQLite session binding, IPC sound intent,
stop/reopen and session identity reuse. Its result is pending Windows CI.

Previous unsigned Windows run 38714088139 passed supervisor and sound tests but
failed an existing fixture setup wall-time assertion while 140 SQLite fixtures ran
concurrently. Run these fixtures serially before changing any performance threshold;
the existing query/reopen limits remain intact. No signing/publication was run.

The core integration is still incomplete and **not releasable**. In particular,
the verified manager is not yet wired to this worker entry point, the generic
durable audio/OBS transport and complete plugin UI/overlay/backend are not yet
connected, and core still contains temporary BuiltIn compatibility dependencies.

## Host transport checkpoint (2026-10-15)

The generic managed-audio implementation now has indexed durable receipts and a
process journal independent of Dota types/history. This code is not yet initialized
or fed by PluginManager. It therefore does not create a new DB or alter the running
legacy pipeline at application startup. No new plugin activation path is open.

The intended host transport database is distinct from worker history; no cross-DB
atomicity is claimed. Each admission commits the exact package/generation, payload
identity and playback token before emit. Queued/playing remain unconfirmed; only an
authenticated terminal ACK settles them. Unknown survives reopen and blocks fresh
effects/takeover. One playback ID cannot represent two operation keys. Process
reservation precedes spawn, reopen leaves Draining, epochs are monotonic, and exit
must be proved by the native caller. No PID/timeout is an exit proof.

Ten targeted tests pass locally: admission-before-emit, completion/cancellation,
duplicate return after managed-file removal, payload/context conflicts, stale token,
frontend Unknown/reopen, single coordinator, corruption/incompatible schema, process
journal restart fencing/epoch reuse, cancellation without waiting under the ledger,
and 10,000 retained keys refusing new admission without deleting old receipts. The
same actual modules are selected in Windows CI without the combined Tauri lib-test
loader limitation. Native WebView playback and final manager wiring remain untested.

Windows runs 38745334724 and 38747483981 passed manual worker preparation but failed
the first supervised GSI bind. The second preserved native code **10106**, not an
address-in-use error. The supervisor supplied an entirely empty environment. A
minimal fix supplies only OS-derived SystemRoot (GetSystemWindowsDirectoryW), still
excluding caller credentials/environment; the existing native membership fixture
also verifies that sole environment entry and an actual loopback bind. Windows
confirmation of this fix is pending; publication remains blocked.

References: [Microsoft Winsock error codes](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2),
[CreateProcessW environment format](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw).

## Verified worker/UI grants checkpoint

Unsigned Windows CI [38750365996](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38750365996)
passed on c6da167, including the supervised worker's real loopback bind after
supplying OS-derived SystemRoot, storage regressions, NSIS and packaged smoke.
This is not a native user's GSI/audio/OBS acceptance test.

The next source checkpoint negotiates Core API 1/2 over unchanged IPC v1, preserves
old manifest signatures, binds API2 UI commands to signed allowlists and actual
process generation, and uses a nonce/source/correlation-checked sandbox bridge.
The manager's new worker adapter remains unattached until legacy bootstrap and
OBS game automation are removed. No two production game pipelines are enabled.

Local targeted checks: 31 Dota library tests plus 8 external-process IPC tests;
11 generic durable transport tests (including independent plugin audio fences),
protocol/manager/Hello compatibility checks, 27 UI bridge/library tests, TypeScript
and cargo check. Package UI replacement, OBS/backend/overlay integration and final
physical core extraction remain required before any signing/publication.

## Package UI and native command checkpoint (2026-10-16)

Unsigned CI [38760476043](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38760476043)
passed on f526bf5. The following source changes are a subsequent checkpoint,
not a published plugin or proof that the core is already Dota-free.

The independent React package now reads the actual domain catalog, saved sound
bindings/assets/volume and real history projection through the same worker IPC.
The real item inspector, binding row and presentation categories have moved to
plugin source; temporary legacy reexports remain until the final core cutover.
The iframe has no Tauri API or audio player. Native file import uses an explicit
system picker, a bounded protected copy and opaque metadata; the worker validates
that managed copy and atomically saves its binding. Preview uses host admission
and actual frontend receipts, never an iframe player or success-on-emit.

API2 manager actions include manual prepare/enable/disable/recovery. Opening UI
is separate from activation; restoring registry never starts a live package.
Recovery uses exact native generation fencing and existing audio/Unknown gates.
These paths still cannot activate while the new host is unattached; legacy startup
must be removed first. Existing Dota package 0.1.0 is not upgraded or relabelled as
compatible. Shared OBS transport now owns the existing fresh-observation/one-write/
fresh-observation rule and a bounded credential-free authoritative snapshot; the
old game-specific adapter maps the same result without duplicating its algorithm.

Checks: 20 targeted frontend tests, both frontend typechecks, independent UI build,
3 worker UI/file-preservation tests, 8 actual child IPC tests, 7 protocol tests,
13 host audio/import tests, 7 manager tests (one signed local-package test ignored),
5 generic OBS tests plus 2 existing reconciliation compatibility tests, cargo check
and diff checks. Socket tests were rerun with localhost bind permission after the
sandbox's EPERM; no real OBS or user data was used. New React keys are distinct
for controls/iframe, preserving pending/result/error state during polling.

Still required: full overlay/backend/OBS/lifecycle integration, removal of all
remaining core game code/dependencies/assets, new signed API2 package/catalog,
full-source Windows validation and the authorized stable publication sequence.

## Overlay ownership and GSI setup checkpoint (2026-10-16)

Unsigned Windows CI [38806279754](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38806279754)
passed on 25fd214. Subsequent source moves the actual renderer, widgets, styles,
medals/minimap assets and hero presentation catalog into the Dota UI package. Its
independent build produces the real self-contained overlay, not the replay page.
The old compiled core renderer and core startup are still temporary dependencies;
**physical extraction is not complete and this source must not be released yet**.

The worker now owns the relocated overlay DTO and a bounded HTTP/SSE listener on
127.0.0.1:3666 when its signed grant includes overlay.publish. Renderer bytes must
match the exact pinned manifest and payload hash. HTTP/SSE threads read only a
bounded published projection/config cache; they never touch SQLite or raw GSI.
SSE excludes timestamps from diffing and uses a config content key for renderer
cache invalidation (this is not a persisted match revision or write precondition).
Known routes and managed images retain their existing URLs. The quiz POST route
currently refuses with overlay_backend_unavailable; backend/account enrichment,
chat, visibility controls and quiz forwarding still need integration before release.

Settings include real Steam discovery, native directory selection and explicit
GSI cfg installation. The iframe cannot submit a write path; only a verified
native selection reaches host.directory. Existing filename/endpoint are retained,
parent links cannot redirect installation outside the selected game, and neither
selection nor installation prepares history, creates a session or activates GSI.

Repeated Prepare revalidates the retained backup, leaves a damaged copy untouched,
and publishes the actual error/post-state. The worker's strict history reader now
uses the same real query/projection as the compatible legacy adapter, but reports
query failure instead of a fake empty history. No SQL/game decision rule changed.

Core keeps child-command serialization until sound admission/emit (never waiting
for a frontend ACK under a history lock). Worker batches discard old-context sound
intents after a session transition, preserve order of current intents and count
these drops. Product diagnostics retain safe detected/planned counters and the
last source operation; a protected, current-package/generation-scoped audio.receipt
query shows the actual durable ACK. Emit, queued/playing and Unknown are not
completion. No raw GSI/account/provider data is logged by this path.

Targeted local checks: independent UI/real overlay build; 18 renderer widget tests
plus alpha-background check; GSI/config/setup and repeated-backup tests; scope/order
regressions; 4 strict/legacy history projection tests; 8 real-process IPC tests;
13 native audio/import/receipt tests; frontend bridge/library tests, both TS checks,
cargo check and diff checks. The Windows supervised demo/bot fixture now also checks
the installed-layout manifest/hash loader and the real overlay HTTP route, using
fixture HTML only. It is not native OBS rendering or audible game acceptance.

Remaining release work is production OBS/backend/stream lifecycle/manual history
and overlay controls, draft reminder/hotkey ownership, quota/recovery validation,
removal of all core game dependencies/bootstrap/UI/assets and final signed package/
catalog + updater validation. Unknown after frontend loss remains fail-closed;
never clear it or infer old playback cessation from a PID/timeout alone. Native
restart audio-fence proof must be reviewed as part of the final activation path.

## Stream lifecycle and real user edits checkpoint (2026-10-16)

Unsigned Windows run 38813824275 passed for da5d09c (NSIS, existing packaged
smoke, supervised GSI/overlay worker fixture); this still builds the transitional
core with BuiltIn present, not the final separated release.

The installed-worker scheduler now obtains correlated GetStreamStatus truth from
the credential-owning core outside process/history locks. Only the boolean and a
bounded-age observation cross IPC. Scene automation being disabled does not disable
stream observation; unavailable, malformed, future or >2s-old observations are
Unknown, never a synthetic stop. Worker idle ticks use the existing domain lifecycle
and transactional facade every 2s and the real ended-session watchdog every 60s.
A confirmed OBS stream start can bind one real streamed session while cold; absent
OBS/demo without game evidence still cannot manufacture a session. Durable lifecycle
receipts, binding, session/outbox/revision changes share the same transaction.

Manual MMR, match delta/mode corrections, stale-session acknowledgement/end and
stale interrupted-match recovery now execute through the same Adapter and original
Facade/store operations. Typed bounded requests carry operation UUID, actual SQL
revision and session precondition. Receipt and entire write-set commit together;
stale/context/Unknown/quota failures roll back. A duplicate returns its checksummed
receipt even after reopen/new fenced epoch, without re-enqueueing or taking a new
identity. Recovery refreshes context from durable ownership, not an old receipt.
The independent React history editor waits for the exact native receipt and does
not optimistically report success or automatically replay stale/uncertain requests.
A worker cannot acquire activation/ownership through history UI command arguments.

Core scopes sound playback to the worker's last committed opaque effect context.
On a context change it confirms cancellation of pending/active plugin audio before
reopening admission; old ACKs are fenced. This path does not wait under history or
Manager locks and does not touch Twitch/TTS. Stream closure changes the opaque
context too. This scheduler remains unattached until BuiltIn has been removed.

Targeted checks: 4 lifecycle/store tests including real write-set parity and idle
watchdog, 3 manual edit full write-set/rollback/reopen tests, 6 worker tests, 8 real
IPC tests on macOS; 7 independent Dota UI tests and both TypeScript projects;
correlated typed OBS transport test, context audio cancellation test, cargo check.
The Windows fixture additionally covers real worker IPC stream graduation and
manual receipt replay (synthetic OBS input; not native OBS/audio/game acceptance).
Production OBS scene automation, authenticated backend/outbox transport, remaining
plugin UI/overlay controls and final core extraction/signing are still outstanding.
