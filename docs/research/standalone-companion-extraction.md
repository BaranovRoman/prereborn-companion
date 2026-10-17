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

## Protected backend and durable outbox checkpoint (2026-10-16)

Unsigned Windows run 38815911326 passed for b3bad92. The following backend work
is a separate candidate; it still does not attach the new scheduler at startup.

Signed API2 manifests can grant bounded, exact relative companion resource routes,
methods, query keys and response sizes. The existing CoreRead framing admits one
correlated request only during host.poll of the verified process generation; UI,
Hello and a stale process cannot acquire this callback. Core retains the bearer
credential, fixes the backend origin, disables redirects and rejects oversized or
credential-shaped JSON responses. No SQL, user-supplied URL or token enters IPC.

The original outbox selection, eligibility, cutover and delivery SQL now lives in
the existing canonical Dota storage crate; legacy callers use that same code.
Activation initializes the real existing cutover before fresh GSI admission.
Account refresh uses the original mode/rating bootstrap rules and does not overwrite
local/session/device corrections or allocate receipts for unchanged polls.
Outbox admission persists uncertainty before HTTP; settlement, original row changes
and checksummed receipts share the one history transaction. Recovery retains the
original event UUID and payload. Completed bookkeeping means the SQL transaction
committed; a delivery=unknown receipt and pending row do NOT assert HTTP success.
Only the existing sync/events endpoint permits retry of that exact event: its
withIdempotency implementation commits the event result and business writes in one
server transaction. This is not an exactly-once transport guarantee and does not
permit automatic replay of OBS/audio or arbitrary HTTP effects.

The independent history UI reads persisted pending/rejected/Unknown delivery counts
and never hides an uncertain delivery as sent. Expired sound intents are durably
Cancelled before any emit instead of crashing the whole worker; Unknown still blocks
admission and is never promoted to completed.

Targeted macOS checks: 7 lifecycle/account/outbox rollback, duplicate, corruption and
reopen tests; 20 original sync tests; 10 protocol tests; manifest policy test; 8 real
process IPC tests; 6 native audio host tests; 2 actual local HTTP transport tests;
8 independent Dota UI tests, TypeScript and 4 package-tool tests; core cargo check.
The added Windows supervised worker fixture exercises real reverse IPC, original
outbox identity across reopen and Unknown->confirmed response using synthetic backend
and stream responses. It has not yet run in Windows CI at this checkpoint. It is not
native Dota/OBS/audio smoke. Server Postgres tests were inspected, not executed here.
Remaining work includes OBS policy/effects, backend corrections/overlay controls,
draft reminder/hotkeys, host/WebView crash fencing, safe retention and physical core
extraction before signing/publishing a complete standalone release.

## Worker OBS execution checkpoint (2026-10-16)

The installed worker now computes scene intents from its actual broadcast/session
state and fresh public OBS observations. Original precedence, optional missing
Post Stream fallback and retry delay are canonical domain functions reused by the
legacy adapter, not copied algorithms. Manual scene changes and reconnect/config
updates are compared with authoritative state; no per-snapshot keys are generated
when the desired scene already matches. An unresolved operation retains its exact
identity rather than becoming another switch. Credentials remain in the core.

Host execution binds semantic mapping, config revision, process generation, epoch
and the last committed opaque context. It commits the existing transport ledger
admission before OBS IO and returns a typed correlated receipt on the next poll.
IO runs without history/ledger mutexes; the process command lock serializes stop
and other commands. An initial failed observation means Cancelled before a write;
an uncertain write means Unknown. Unknown retry only observes fresh program-scene
truth, never resends a command. Config/context disagreement remains fail-closed.
The UI explicitly surfaces uncertain OBS state even while the worker is active.

Targeted checks: 2 worker scene-policy tests; 37 existing OBS tests; 4 actual local
WebSocket transport tests; 7 host audio/scene durable-identity tests; 10 protocol
and 8 real-process macOS IPC tests; 9 independent UI tests/TypeScript; core check.
Windows supervised fixture was extended with correlated scene receipt handling
and Unknown identity retention; its next CI run is pending. This is not native
OBS/game/audio smoke. Startup attachment still waits for the physical BuiltIn cut.

## Backend correction parity checkpoint (2026-10-16)

Unsigned Windows run 38845337974 passed for cfb2ef7, including real supervised
worker reverse requests/outbox recovery, native transport tests, NSIS and packaged
smoke. OBS commit 71757f1 and the following corrections change require the next run.

Worker corrections polling uses the existing signed resource bridge and original
sync/corrections contract. The same facade server_correction SQL applies the
bounded batch. Cursor advancement preserves the existing latest+1ms semantics;
corrections, cursor, actual revisions and a checksummed idempotent batch receipt
commit in one transaction. No optimistic response, swallowed SQL error or failed
batch may advance the cursor. The next frame reads actual storage context and the
independent UI refresh counter prompts a fresh history query even without GSI.
No-op/empty polls allocate no ledger key. Invalid or over-limit replies are not
partially applied. Existing server-originated detected-vs-corrected rating behavior
is preserved, including device-rating semantics.

Targeted tests: 8 lifecycle/account/outbox/correction tests, including exact full
legacy write-set parity without UUID normalization, duplicate replay without revision
changes, quota rollback and invalid timestamps; 8 real-process macOS IPC tests and
core cargo check. Windows callback fixture now also handles the actual separate
corrections request. No user database or backend data was used.

## Plugin-owned draft reminder checkpoint (2026-10-16)

The existing draft-entry/latch rule is canonical in dota-domain and the temporary
BuiltIn wrapper delegates to it. The worker emits the existing Russian reminder
only on a fresh draft transition with authoritative non-streaming OBS truth;
unknown/disconnected OBS does not become false, and scene automation being off
does not disable observation. No fake session is created for a reminder.

A bounded generic voice-notification variant uses the same host transport ledger,
real playback token, queued/playing/terminal ACKs and plugin-only fence as file
audio. Core contains no draft detection or Dota message text. Voice synthesis is
separate from the Twitch queue, uses the selected Silero voice, and retains the
existing companion-system-voice-reminders-v1 preference (including its default).
The common output-device/overall-volume transport applies to these notifications.
Cancellation owns the token during synthesis too: a late result cannot create an
Audio element after a fence/unmount. Expired/disabled or failed-before-player
requests are cancelled, never claimed completed. Emit/crash remain Unknown.

Targeted macOS checks: original 13 draft reminder tests, canonical tracker test,
6 worker tests, 8 real-process IPC tests, 8 host audio/scene/speech tests, 7 real
transport-store tests, 19 frontend transport/legacy sound/core shell tests, TypeScript
and cargo check. The existing Windows supervised demo/bot fixture additionally
checks one reminder intent on a real worker GSI transition with synthetic OBS input
and no duplicate on a repeated draft frame; its next CI run is pending. No audible
native reminder, Dota match or real OBS smoke is claimed. The scheduler remains
unattached while the physical BuiltIn extraction is still incomplete.

## Host/WebView crash fencing and stock-updater containment checkpoint (2026-10-16)

Unsigned Windows run 38846450573 passed for 8673447: OBS policy/receipts, backend
corrections, supervised worker, NSIS and the transitional packaged smoke. Reminder
commit 63acbb9 and this host-generation change require the next Windows run.

The existing native Windows supervisor now supports containing Companion itself
before WebView creation, without a new supervisor process or saved-PID proof.
Its non-inherited job handle is retained through kernel process teardown. Existing
crash fixture additionally verifies a normal descendant (without its own worker
job) terminates on owner crash. Host generation is journalled before assignment;
startup must fence the exact previous non-retired job before granting a new host.

The unpublished generic transport namespace now journals the host generation and
binds new audio receipts to it. A proven old-host exit retains audio Unknown, its
payload/key/token and uncertainty, with an explicit audioFenced cessation fact;
it does not claim completed playback. Unknown with no host journal remains blocked.
OBS Unknown is deliberately NOT reconciled by process death. Old audio ACKs are
rejected, and pre-ready/draining/retired hosts cannot admit operations. Raw Unknown
counts remain observable separately from blocking Unknown. There is no key deletion.
This changes only the new, unattached transport schema; legacy user history and
its migration/backup contract are unchanged. Unexpected older transport schemas
fail closed rather than being silently reset.

Important startup wiring precondition: self-containment MUST NOT be attached
without the matching updater retirement hook. Stock tauri-plugin-updater 2.10.1
calls ShellExecuteW then exits; naive kill-on-close would also kill an inherited
NSIS installer. The native retirement path first closes admission and requires
the caller to stop producers/destroy WebViews, then waits on owned handles for
all old descendants, persists retirement and allows only subsequent child creation
to break away. The stock updater, endpoint, key and installer arguments remain
unchanged. If retirement proof fails, installer launch must be stopped, not allowed
under an unproved old job. The existing Windows fixture tests detached installer-
like child survival only after old descendants exit. It is not an actual upgrade.

Local checks: 9 real SQLite transport tests including atomic rollback of cessation
facts, reopen, unjournalled Unknown, OBS isolation and stale ACK; 8 native host audio
checks and core cargo check. Windows-only OS changes await CI. Neither the new host
initialization nor its updater hook is attached to normal startup yet; wire both
before enabling the generic worker scheduler during final BuiltIn removal. Actual
WebView containment and native updater behavior still require packaged Windows
validation after that wiring. Do not publish this intermediate branch.

## Native updater before-exit wiring (2026-10-16)

Inspection of the actual installed tauri-plugin-updater 2.10.1 source showed its
JS plugin builder does not expose an exit callback override. Native
check_companion_update therefore uses the existing UpdaterExt builder/config/key/
endpoint/default comparator, adds its supported before-exit callback and puts the
actual Update resource into the same main-WebView resource table. Frontend creates
the stock Update object from that RID and still calls its unchanged
 downloadAndInstall/signature verifier/NSIS implementation. No alternate installer,
channel, endpoint, public key or version comparison was introduced.

When a supervised host is attached, only AFTER successful signature verification
the callback closes host admission, shuts down the manager/Silero/hotkeys, destroys
WebViews, proves old child exit, persists retirement and permits the installer's new
process to detach. Failure logs a static error and exits before ShellExecute. An
exit-in-progress guard prevents destroying the last WebView from ending Tauri's
event loop before installer spawn. With no supervised host (current transitional
startup), the callback retains stock cleanup behavior. Root host setup remains
unattached until the BuiltIn cut; it must be wired before first WebView creation.

Targeted checks: actual stock JS Update resource construction from native metadata,
null/error handling, 3 existing updater signature/install/progress state tests,
core shell tests, TypeScript and core cargo check. This does not claim an actual
Windows upgrade or WebView descendant fence; those require final packaged validation.

## Generic OBS settings extraction checkpoint (2026-10-16)

Scene aliases/defaults are now optional signed obsBindings metadata, constrained to
explicit obs.scene grants and public non-credential legacy fields. Omission keeps
old canonical manifest serialization/signatures unchanged; packaging preserves the
new field. A generic OBS transport config can preserve opaque saved extensions,
project only the verified package's declared scenes, enforce revision-based mapping
edits and redact credentials/unrelated extensions from core UI responses. Invalid
mapping state is an error, not a fallback to healthy defaults. Actual Dota labels
will come from its installed manifest rather than core defaults.

Targeted checks: manifest capability/secret-alias denial and old roundtrip; exact
legacy JSON retention, public redaction, stale edit and malformed-state rejection;
4 packaging serialization/integrity tests. This generic config is not yet wired in
place of the legacy OBS struct; do that with physical core removal, avoiding a
second scene automator. Remaining plugin settings/overlay controls must use this
same generic capability, not the legacy Dota Tauri commands.

## Independent OBS settings UI checkpoint (2026-10-16)

The verified worker pin now carries signed obsBindings. Public observations and
scene admissions use the generic config projection/revision, not a core-coded
list of game semantics. A temporary private source-shape adapter keeps the current
legacy OBS holder compatible; private credential serialization never crosses IPC.
The legacy struct retains opaque extension fields on save so plugin mappings are
not lost while that holder is removed. Unused hardcoded plugin projection methods
were removed. This does not attach a second scene automator.

The package's own OBS panel uses signed obs.settings/obs.save commands. Core checks
UI/OBS capabilities, executable generation, declared semantics and a real config
revision immediately before persistence; it never accepts a host/password/path
from the iframe. It revalidates endpoint/credential identity after a probe and does
not report an old connection as current. Saved mappings remain available with OBS
closed; saving does not assert a scene was switched. A stale/native error is shown
in place, without optimistic success or automatic retry. No game listener/session
or history preparation is required merely to edit settings.

Local checks: 11 independent package UI tests (offline mappings, deferred native
ACK, stale revision included), TypeScript, real generic config/secret-redaction/
legacy JSON/CAS test and core cargo check. The active stable/plugin package is
unchanged. Actual native UI invocation awaits final startup attachment and signed
API2 packaging; old Dota 0.1.0 lacks these commands and must not be reused as the
new package. Before startup cut, also persist/reconcile OBS target identity for
Unknown after process exit; the current name-only transport action is insufficient
for safe recovery if the OBS endpoint changes.

## OBS exit recovery and Windows UI ordering checkpoint (2026-10-16)

Scene admissions now persist the exact public transport identity, mapping revision
and context with the desired scene. After verified native process exit, recovery
may only query the same OBS endpoint and confirm its authoritative current program
scene; it cannot issue a setter. A changed endpoint, missing target metadata or
unavailable/unconfirmed observation keeps the operation Unknown and the process
Draining. A reconciled receipt preserves its uncertainty provenance and explicitly
records reconciliation: it confirms current state, not exactly-once delivery.
Receipt mutations also verify immutable payload identity, including frontend ACKs.

Targeted local checks: 9 ledger and 9 host tests, generic config test and cargo
check. The native recovery call sites still await final plugin-only startup
attachment; these checks do not claim a real OBS crash/recovery smoke.

Unsigned Windows run 38850900168 failed before packaging in the iframe API2
handshake test (the Windows supervisor step passed). The test dispatched readiness
immediately after iframe render, before guaranteed passive listener installation.
It now waits for the actual host acknowledgement using repeatable readiness
announcements, as allowed by the existing probe handshake; no production bridge
permission or timeout was relaxed. All 36 tests from that exact CI frontend step
pass locally. A subsequent Windows run must confirm this ordering fix.

## Bounded transport retention and native enumeration checkpoint (2026-10-16)

The 10,000-key transport quota is unchanged. Worker effects now use canonical
generation:epoch:source:sequence keys (audio, speech, scene), incremented for actual
intents rather than GSI frames. Durable per-source high-water marks are committed
with each admission in the existing coordinator transaction. A bounded sweep can
remove only validated Completed/Cancelled receipts older than the last 256 source
operations, or from a strictly earlier fenced epoch. Missing keys at/below a
watermark are rejected as retired/out-of-order, never readmitted or reported as
successful; old epochs cannot pass admission even if a UUID were reused. Recent
duplicates still return their exact saved receipt, with payload conflicts denied.
Unknown/queued/playing and unordered legacy/preview keys are never deleted.
Watermarks and compaction counts are checksummed process-journal data; corrupted
payload identity or a failed admission rolls back the entire sweep and watermark.

Actual SQLite synthetic eight-hour effect workload: 8 matches, 32 audio cues per
minute, 8 draft notifications and 40 scene changes/reapplications. 15,408 admitted
operations, 15,104 compacted terminal receipts, 304 retained receipts, peak receipt
payload 208,527 bytes, zero Unknown/pending, one process identity. This complements
the separate real match-facade telemetry workload; it is not native audio/OBS or
a complete combined end-to-end stream smoke. Local checks: ledger tests (including
reopen, rollback, old-epoch rejection, corrupted compaction candidates), 9 host
tests, 6 worker tests and core cargo check passed.

Unsigned run 38871395622 stopped in the real Windows host-retirement fixture:
host_children_exit_unproven before installer-like child launch. Job capture was
immediately failing on a child/list change during enumeration. Host retirement now
discards incomplete witnesses and recaptures within its existing deadline. It
still requires signalled owned handles plus stable native job accounting, never
a PID, timeout or incomplete snapshot as proof. Persistent failure remains closed.
The existing native retirement fixture now repeats four independently named jobs;
the Windows result must be checked before claiming this race is resolved.

## Installed overlay preview containment checkpoint (2026-10-16)

The installed package UI could not embed the already relocated renderer: its
existing CSP unconditionally used frame-src 'none'. Optional signed uiFrameOrigins
now grants at most two canonical http://127.0.0.1:<port> origins, only to API2 live
UI packages with overlay.publish. Remote hosts, paths, credentials, zero/noncanonical
ports and CSP injection are denied. Missing metadata preserves old signed manifest
serialization and the old deny-all frame policy. It does not grant connect-src,
Tauri, inline/eval scripts, forms or arbitrary navigation.

The production installed-asset handler is extracted from the replay lab into the
existing core transport. It obtains frame policy from a freshly signature-verified
active manifest and rechecks the SHA256 of the actual bounded bytes it serves,
after reading them (not merely a path checked before a second read). Debug lab
behavior remains temporary until physical core removal. Packaging retains signed
origin metadata. Tests: manifest denial/backward signature shape, protocol CSP,
actual asset containment, four package serialization/integrity tests and core
cargo check passed locally. The editor/settings backend port itself remains work;
this does not claim a native renderer preview or signed package publication.

## Physical core removal checkpoint (2026-10-16)

The feature working tree now compiles without the BuiltIn Dota bootstrap or
dependencies on dota-domain, dota-plugin and dota-storage. Game listeners,
match/history operations, game sound pipeline, overlay renderer, game pages,
lab entry points and game images are removed from the core source/bundle. The
installed package owns the relocated implementations. This checkpoint replaces
the earlier temporary reexports; it is not yet a finished replacement release.

Startup initializes only generic account/chat/TTS/OBS/plugin transports. Windows
root supervision is installed before creating the first WebView. Managed plugin
audio requires native verification that the actual current WebView browser is
inside that exact host generation's job. No game database is opened, no GSI or
overlay port is bound, and installed live plugins do not auto-start. Identifier,
data paths, updater endpoint/key and old user files are preserved. The old icon
is replaced by a neutral vector-derived Companion monogram.

Core OBS retains its real connection watcher/heartbeat/reconnect behavior and
redacts passwords and opaque game mappings from public state. Game mappings
remain opaque persisted extensions for the installed package. The existing Skip
TTS hotkey/queue and settings retain their implementation; overlay hotkey behavior
must still be delivered by the plugin, not left behind in core. Diagnostics now
capture bounded opt-in TTS and public core status only, never GSI/history.

Selected local checks passed: Rust core check; 22 storage, 18 hotkey, six backend,
two real loopback OBS watcher, two installed asset/CSP tests and stale iframe
version denial; core TypeScript and package TypeScript/UI tests. The TTS test
helper was corrected to inspect the latest React render rather than a stale
session object; selected hotkey and isolation regressions pass. These do not
prove native WebView/audio/game acceptance.

Windows run 38872561156 passed native supervision, including repeated actual host
retirement/crash fixtures, but hit the 15-minute step timeout during the real
eight-hour transport workload. That workload now has its own mandatory 60-minute
step after packaged-core smoke, with progress output and unchanged durability.
The new core cut and actual WebView containment still require Windows CI.

Release remains blocked on completing package overlay/settings controls, removing
backend/OBS IO delays from the sound poll path, validating prepared 0.5.94 data,
and signed package install/update verification. No release, signed catalog, user
database migration or native user-game smoke is claimed by this checkpoint.

## Non-blocking worker input checkpoint (2026-10-16)

The production host.poll reverse callback no longer waits for backend HTTP. Each
existing worker has one bounded pending request. Pending replies keep the exact
operation key/body in the worker; polling continues to process GSI and cannot
start another HTTP request. The final response is returned on a later poll.
Completed replies are cached for that request, conflicting in-flight requests
are denied, and an uncertain network outcome remains Unknown. Stop must prove
the pending host task finished before marking the scope stopped; a timeout
leaves Draining. No new wire envelope or backend retry policy is introduced.

OBS read-only probes likewise run outside the GSI/stdio path, at most one probe
per worker. Public scene and stream observations share the same current config
revision and original observation timestamp. Expired or changed-config results
are omitted, never turned into a stream-stop signal. Actual scene writes still
use the existing durable admission/reconciliation and block on Unknown.

Targeted checks: one real pending-task host regression (non-blocking return,
duplicate/conflict, completion and stop fence), seven actual worker tests,
including identical pending request identity while polling, and core cargo check
pass. This is not native audio/OBS acceptance; Windows CI remains required.

## Package overlay control checkpoint (2026-10-16)

The package now owns overlay show/hide, manual summary/automatic scene, native
shortcut settings and the existing 3666 renderer preview. Commands require the
signed overlay.publish grant and never manufacture a session. The original
overlay-hotkey-config.json/default Ctrl+Alt+F11 is preserved; core Skip TTS is
untouched. Windows registration uses the same global-hotkey parser/backend on a
worker-owned message pump, unregisters on stop, coalesces key presses in an atomic
flag, and reports conflicts instead of stealing another shortcut. No registration
or settings write occurs just by opening the package UI. Invalid/future config
files are preserved and rejected. The UI waits for native results and no longer
keeps an active/awaiting-session header after status polling fails.

Local targeted checks: two hotkey persistence tests, eight worker tests, 13 package
UI tests and TypeScript/core cargo check pass. Windows registration/conflict/stop
has a native-only test selected by the existing package lib CI step; not locally
claimed. Full layout/queue editing and backend-fed overlay enrichment still need
porting before release.

Unsigned Windows 38881382990 passed native process supervision and frontend/UI
checks; the relocated storage suite had 154 passes and one fixture setup timing
failure: seeding 1250 matches with real durable commits took 34.5s versus an
arbitrary 30s setup assertion. Setup time is now reported without treating shared
runner fsync latency as a query regression. All real commits, row/cascade checks
and the existing reopen <2s, history query <500ms and correction <2s assertions
remain. The exact selected test passes locally (1250 matches, real commits,
0.54s total). No durability or workload count was reduced.

## Actual settings transport and installer verification (2026-10-16)

Catalog selection now offers one latest compatible version per plugin using
semver, excludes API1 live activation and future APIs, and does not offer a
version below the installed one. It never rewrites signed catalog entries.
Two targeted manager regressions cover numeric ordering, downgrade refusal,
unchanged catalog contents and legacy/future live rejection.

The installed UI's bounded backend.request/pending/reconcile commands use the
existing verified process, signed fixed resources and host ledger. UI requests
can read or PUT desired settings; POST is denied here. Admission persists the
whole bounded desired request, signed-resource identity and hashed account/
origin authority before HTTP. The actual bounded normalized response is saved
with the receipt. A duplicate returns that response without another HTTP write;
payload/package/account conflicts fail closed. There is no history/SQL access.

Unknown is never retried as a write. Reconciliation performs only an authorized
GET of the same signed path/query/account and requires exact desired JSON state.
Its receipt explicitly retains uncertain/reconciled provenance: this proves
state satisfaction, not exactly-once HTTP execution. The same read-only check
is connected after native process exit and before audio/process completion;
failure retains Draining. No history mutex is held during network IO. Confirmed
documents reach the worker through host.resource on the existing verified IPC;
iframe commands cannot call that host entry point. The worker preserves all
unedited layout/queue fields and writes only their fixed existing cache names,
without opening history or creating a session. The editor port itself remains
unfinished; no package/catalog publication is claimed.

Per-receipt validation permits at most 48 KiB for these settings (8 KiB typed
desired request + 24 KiB response + bounded identities/envelope). The 10,000-key
and 32 MiB total quotas are unchanged. Old omitted-field serialization remains
compatible; sound/scene payload limits and ordered compaction rules are unchanged.
Settings use actual manual operation keys, never per-GSI keys, and Unknown keys
are retained. Local checks: 25 audio/ledger tests passed before the added stopped
settings case; four selected settings/recovery tests then passed, two protocol
backend permission/secret tests, one real worker cache/preservation test, core
and package cargo check passed. These are temporary stores and simulated native
exit boundaries, not user DB or real game/audio acceptance.

Windows 38908782725 passed native supervisor, native overlay hotkey, Dota/storage
checks and NSIS compilation. Installer verification stopped because Windows
PowerShell split the inline Python -c source and Python tried reading a file
named implementation. The prior exact payload comparison passed; this was not
evidence of game code in the executable. Marker verification now runs inside
the existing Python payload verifier, keeping every-byte SDK-patch comparison
and game marker rejection. Four targeted verifier regressions pass locally.
Packaged native WebView smoke and the mandatory eight-hour transport step were
not reached in that Windows run and must pass on the next candidate.

## Package editor, managed media and admission visibility (2026-10-16)

The real overlay layout/queue editor and its original form tests now ship in the
Dota UI bundle. The backend remains layout v5 and queue v2 (legacy v1 accepted),
whole documents preserve unedited fields, and only a confirmed native receipt
shows Saved. Unknown remains visible for explicit read-only reconciliation.
The preview waits for the existing renderer's source-bound ready message;
absence produces an error, never a fabricated ready state. Managed PNG/JPEG/
WebP imports use the existing native picker and only two existing overlay image
roles, with size, signature, canonical directory and generation checks. No
iframe source paths or Tauri access are introduced. Reference-preview opacity
currently defaults per window; migration of that old editor-only preference is
still outstanding. Native WebView image/preview checks remain unperformed.

Manual backend IO is bounded separately from the runtime command mutex, so a
settings HTTP wait cannot hold up GSI polling. Stop releases the process lock
before waiting for admitted UI IO; timeout keeps Draining. An already admitted
request may persist its actual result during Draining, without admitting another
operation. The targeted transactional regression passes.

Windows run 38913021153 stopped at a GSI status publication race: a rejected
counter could become visible before its static reason. Error publication now
precedes Release counter increments and status uses Acquire. Admission is
captured before HTTP ACK, preventing activation after ACK from admitting that
pre-activation request. Both actual loopback listener tests pass locally with
network permission; no raw snapshot logging was added.

Audio payload serialization already omits absent speech, so a hypothesized
null-speech defect was not confirmed. The actual shared playback queue could
let pending reminder synthesis delay a media clip. Existing generic transport
now has bounded media (2 pending) and speech (1 pending) lanes with one shared
native fence. A regression proves media starts while synthesis waits, both
lanes cancel under the same fence, late synthesis cannot construct a player,
and unrelated Twitch playback is not paused. Selected managed audio + actual
Twitch hook tests: 31 passed; core TypeScript passed. Package editor/preview
checks: 26 passed; package TypeScript passed. Local generic audio/ledger checks:
28 passed, one long workload deferred to the mandatory dedicated Windows step.
These do not assert real Windows GSI, Techies audio or OBS smoke success.

## Actual overlay backend refresh, quiz outbox and chat (2026-10-16)

The existing worker's single pending HTTP slot now refreshes layout/queue (60s),
favorite heroes/profile radar (90s) and enabled Between Matches quiz state (2s).
Match sync/corrections keep priority. The actual backend accepts up to three
favorite IDs. Failures retain the last confirmed enrichment and appear as a
separate overlayBackendError in package diagnostics. A late background GET
cannot overwrite settings confirmed by the editor: its real response is still
consumed, but its obsolete document is discarded. Selected worker tests pass.

Signed backend resources may additionally grant read-only /stream/integrations/
routes and a single canonical positive-u32 {id} segment. The host substitutes
only that validated ID, removes it from query, and never accepts an arbitrary
path, origin, auth/connect/callback route or method. Query names preserve the
actual backend's heroIds spelling. Three protocol tests and an actual bounded
loopback HTTP test pass; existing origin/token/response limits are unchanged.

Quiz scene transitions use the existing transaction facade/outbox and reserved
receipts on the same writer. Scene state, original outbox UUID and receipt commit
atomically, deduplicate repeated polls, and work without a fake match/session.
Only these typed overlay rows with an intact matching receipt and post-cutover
time pass the existing sync admission; legacy match/session eligibility is
unchanged. Four selected sync bookkeeping tests pass, including quota rollback,
original UUID retention, no session creation, and stale-owner refusal after
reopen. Quiz geometry forwarding is still unfinished; polling alone is not
claimed as a complete quiz port.

An explicit signed chat.read capability supplies a <=8 KiB/20-message public
projection from the existing core chat cache through host.poll. No extra Twitch
connection/poller or TTS queue exists. The observation keeps its original time
and expires after 5s; account changes revoke the cached authority, including a
request finishing after the account changed. Only message IDs/display names/
text/color/time and public connectivity leave core, never user/account IDs or
tokens. Protocol projection, core account-expiry and worker capability-expiry
regressions pass. Package App tests: 14 passed; package TypeScript passed.
None of these tests constitute real Windows native GSI/audio/OBS acceptance.

## Quiz geometry through the existing writer (2026-10-16)

The relocated HTTP server now accepts only bounded, typed geometry for the
published active round and its actual option IDs. Other Origins, stale rounds,
unknown fields and invalid coordinates are denied. Four pending requests at
most reach the existing serialized worker; HTTP threads never touch SQLite.
HTTP 202 reports only a recorded durable outbox identity, not backend delivery.
The unchanged backend quiz/geometry PUT is dispatched via the existing CoreRead
HTTP slot, and delivery requires its actual ok/applied response. A stale-round
applied:false response is a handled result, never a successful geometry claim.

The geometry document, outbox UUID and receipt share one transaction. Identical
submissions retain their existing identity. Geometry Unknown is frozen, including
crash after admission; it is not eligible for automatic HTTP retry and prevents
new coordinates for that same uncertain round. A fresh authoritative quiz/state
read may reject expired old-round records: backend SQL requires that exact owned
round to remain active, so a late old request cannot affect a new round. This
is rejected expiry, not success or exactly-once HTTP proof. No keys/Unknown are
deleted. Existing sync/events UUID retry semantics remain unchanged.

Five selected real-SQL sync bookkeeping tests pass, including frozen Unknown,
no newer overwrite, round-expiry reconciliation, duplicate identities, receipt
corruption and rollback. One existing-server loopback HTTP test passes for
Origin/round rejection and recorded-vs-delivered distinction. Package cargo
check passes. Actual quiz interaction in OBS/Extension is still native UAT,
not something these tests claim to have performed.

## Package hero statistics (2026-10-17)

The package UI ports the pure hero-detail panels. Local numbers come from the
existing `store::hero_local_stats` through `history.hero` (hero id 1..=2048);
an SQL failure is reported as `history_read_failed`, never as zero matches.
OpenDota hero-stats/insights are signed read-only resources the worker answers
as explicitly uncached (`handled:false, applied:false`); the native host
accepts that answer only for GET, while PUT/POST still require `applied:true`.
Favorites rewrite the full queue document via the durable native PUT and show
the new state only after the actual receipt. Package backend calls are
serialized through one bounded queue (8 pending) so they never race the native
single-request UI guard. Selected UI tests (22), the native ACK boundary test,
the history read/error test and 12 worker tests pass; not native Windows UAT.

## Presence, remote test scene, account cache, editor opacity (2026-10-17)

Two 0.5.90 backend integrations were missing after the core cut and now live
in the package worker on the same single CoreRead slot (no second poller):

- `gsi-state` (PUT `/stream/companion/gsi-state`): the public overlay's scene
  resolver and debug panel plus companion presence. The body is built from the
  strict projection only — `player{activity,team_name,kills,deaths,assists}`,
  `map{game_state,matchid,win_team}`, `hero{id}` — never raw GSI, items,
  abilities or custom game paths. At most once per second and only after a new
  admitted frame; failures back off 2^n s (max 30) like 0.5.90. The label
  `dota2@<package version>` is sent as companionVersion: the backend floor
  (0.4.0) compares app versions, and a bare package number would be a false 426.
- `commands` (GET `/stream/companion/commands`, every 15 s, requires
  `obs.scene`): the website's remote test scene. Only betweenMatches/draft/
  gameplay are accepted; a repeated command id is ignored. As in 0.5.90 the
  requested scene lasts until the next real GSI frame; ended/summary
  precedence still wins. This poll also keeps presence without a running game.

The confirmed account-settings document is again written to
`account-overlay-data.json` (only by the background read, never host.resource).
The editor reference opacity is package state in `overlay-editor.json`
(0.1–1.0, default 0.65) via `overlay.reference[.save]`; the sandboxed frame has
no storage. The 0.5.90 value in the main WebView localStorage is not migrated:
the core must not know package keys. It is a cosmetic editor-only setting.
Worker tests: 56 passed; package UI: 49 passed (8 files); tsc passed.
