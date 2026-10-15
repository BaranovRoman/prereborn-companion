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
