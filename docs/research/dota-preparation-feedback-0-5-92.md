# Dota preparation feedback in Windows 0.5.92

## Question

The user reports successful upgrade, preserved settings/history, BuiltIn Dota and a configured
ability sound, plus Dota 0.1.0 installed disabled. Repeated preparation clicks show only an
active button, with no visible result. Determine the call path and fix feedback without
changing native safety, automatically migrating, deleting backups or publishing a release.

## Current state

Source traced: `pages/PluginsPage.tsx` → `plugins/api.ts` → registered
`core::dota_live::dota_runtime_action` → `PluginManager::live_transition` →
`manual_action("prepare")` → `LocalRuntimeState::migrate_transactions` →
`transaction_schema::migrate`, then adapter/preflight/fences and BuiltIn post-state.
`Button` forwards onClick/disabled to a native button with type=button. Main-frame IPC is
allowed; the command requires main window, Windows and confirmed=true. No silent native
catch or missing registration was found. An enabled button invokes the exact action/confirmed
arguments. Disabled buttons do not invoke; initial confirmation is required.

## Findings

Confirmed feedback defects:

- Successful action returns void; page run() clears busy with no success/result message.
- No operation-specific loading indicator. Manager stage `activation` was misleadingly
  rendered as a download with download cancellation.
- Native rejection is caught by page run() and rendered at the top of the page, rather than
  beside the Dota button. There was no persistent Dota action result.
- `dota_runtime_safety_status.storageError` is returned but not rendered.
- Dota local error state is used for polling failures and cleared by a successful poll;
  action failure must be stored separately. Existing global command errors were not erased
  by that Dota poll; no claim that this poll erased the original global error.

These defects explain missing feedback but do NOT establish whether a particular click on
the user's Windows installation invoked native code or whether migration committed there.
No access to that user SQLite or Windows logs was available. A button's active CSS appearance
does not establish an invoke. UI/API tests exercise the actual API wrapper with mocked invoke;
they do not stand in for native WebView smoke.

Native prepare first verifies session and signed package grants; stops admission/drains;
requires game audio ACK and authoritative OBS fence; then explicitly migrates if pc_tx_meta
is absent, validates backup/schema, attaches the adapter, fences prior processes if needed,
recovers BuiltIn epoch only when permitted and reopens audio. Any error is returned.

Concurrency is already protected by Manager atomic admission, LiveDota transition mutex,
history mutex and exclusive SQLite coordinator file lock. Migration validates an already
migrated schema. An existing backup with an unmigrated schema yields backup_already_exists;
it is never overwritten or removed. Crash/partial preparation must not be blindly retried.
No native migration, SQL, lock order, runtime or safety gates were changed by this fix.

## Options

- Keep void native ACK and use the existing read-only safety status immediately afterwards:
  minimal compatible fix, selected. Native ACK means prepare finished all its checks; success
  also requires confirmed BuiltIn, non-null epoch, readable quota, no runtime/storage error
  and Unknown=0. A failed post-state read reports an unconfirmed result, not success.
- Add a new protocol, preparation executor or bypass: unnecessary and rejected.

## Recommendation

Implemented explicit local pending/result/action-error feedback, a synchronous repeated-click
guard, disabled controls while pending, persistent errors independent of polling, displayed
storage errors and native activation progress without download cancellation. Missing manual
confirmation is explained. Errors/unconfirmed state also block External activation. Success
appears only after native ACK and validated read-only post-state; no command runs on mount,
poll, restart or without an explicit click. The prepared result is historical feedback, not
authority to override later native state/fencing.

Targeted checks passed: 17 Vitest tests in PluginsPage/api, TypeScript noEmit, git diff --check;
existing Rust tests explicit_migration_verified_wal_backup_idempotence_and_legacy_rows and
live_transition_serializes_installs_and_preserves_the_actual_coordinator (one each). Rust
tests use temporary SQLite, not user history. No production bundle, native WebView or Windows
game/audio/OBS test was run. No release/tag/package publication or main merge.

## Follow-up

For the existing Windows 0.5.92, do not repeat Prepare for diagnosis. Send:

1. Whether the manual confirmation checkbox was checked and whether the button was enabled.
2. The full Dota card plus top-of-page errors: Runtime, Epoch, remaining quota and Unknown,
   including whether quota is absent. A readable quota indicates safety tables are available;
   it does not alone prove successful backup/preflight or the time of a particular click.
3. Diagnostics → Open logs folder (`Открыть папку логов`). In the parent app-data directory,
   inspect Properties of `local-runtime.pre-external.sqlite3`: present/absent, size and
   creation/modification times only. Keep the file intact. An existing backup can predate
   failure/rollback of the migration; absence is not proof that invoke never occurred.
4. Relevant `logs/app.log` lines around the click time, with secrets/personal GSI removed.
   This command has no dedicated per-click audit logging in 0.5.92, so absence of log lines
   does not prove absence of invoke. Do not send raw SQLite/history/account credentials.

If those observations remain inconclusive, inspect a separate consistent DB copy read-only
for pc_tx_meta/schema/ownership, never migrate or delete backup to "test" whether it ran.
Leave External disabled on errors, Unknown or Draining; preserve evidence for the next fix.

## Sources

Repository sources above, `components/ui/Button.tsx`, `src-tauri/src/lib.rs`,
`local_runtime/transaction_schema.rs`, `core/plugin_manager.rs`, `storage/mod.rs`.
User Windows smoke report; no inferred native success beyond the scenarios they confirmed.
