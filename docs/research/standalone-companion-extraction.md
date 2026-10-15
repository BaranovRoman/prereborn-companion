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
