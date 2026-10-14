# Dota Prepare: native preflight before backup

## Question

Windows 0.5.92 user confirms manual checkbox selected, several Prepare clicks, no
local-runtime.pre-external.sqlite3 beside logs, BuiltIn, epoch absent and no External
activation. Identify actual native rejection without inferring it from backup absence.

## Current state

The user has not provided a command error or click-time logs. Current release does not
persist a per-Prepare stage/attempt trace. UI fix a2b43d4 is local to the feature branch,
not a published version. No user database was opened, migrated or changed in this audit.

## Findings

Actual source sequence before backup:

| Stage | Checks / possible failures | Existing visibility |
| --- | --- | --- |
| Tauri entry | main window, Windows, explicit confirmation; dota_runtime_window_denied, external_runtime_requires_windows_native_fences, manual_dota_confirmation_required | Promise rejection at top of Plugins; no dedicated attempt log |
| Manager admission | plugin_manager_stopping, transfer_in_progress, plugin_manager_lock_poisoned | Promise rejection; begin() errors do not pass through finish() |
| Data path | app_data_unavailable | Manager transfer error and top-of-page alert |
| Session lookup | audio_session() must return a session; otherwise builtin_session_required | Manager transfer error/top alert; runtime.error unchanged |
| Installed package grant | verified installed dota2/live/compatible executable and all four explicit capabilities; missing installation/service, invalid scope, signature/hash/platform/API or replay-only rejection | Manager transfer error/top alert; runtime.error unchanged |
| Transition/admission lock | transition_poisoned, admission_poisoned, stop_external_before_preparation | Manager transfer error/top alert |
| Drain | mode becomes Draining, waits up to 5s for in-flight operations; drain_timeout | Rejection; early drain failures do not enter the closure assigning runtime.error |
| Game audio fence | valid frontend ACK required; frontend_audio_fence_timeout, game_audio_stop_unconfirmed, frontend_audio_unavailable, audio_state_poisoned | Rejection, Manager transfer error and runtime.error; remains Draining |
| OBS fence | disabled OBS passes; enabled OBS needs a fresh authoritative response and unchanged config; obs_state_poisoned, obs_fence_unconfirmed, obs_configuration_changed | Same failure visibility; remains Draining |
| Schema inspection | existing history connection and query; local_runtime_lock_poisoned, local_runtime_unavailable, storage_unavailable | Rejection, Manager transfer error and runtime.error |
| Migration before VACUUM | coordinator/file lock, integrity and exact legacy schema, existing reserved schema validation, backup collision; coordinator_requires_file, coordinator_lock_failed, second_coordinator_denied, schema_incompatible, backup_already_exists and storage errors | Same failure visibility |
| Backup creation | VACUUM main INTO consistent copy; permissions/disk/SQLite error maps to storage_unavailable | Can fail without a backup; no success implied |

If pc_tx_meta is already present, Prepare skips migration and then validates the existing
backup in activation_preflight. A missing backup can therefore also be a post-migration
preflight failure; backup absence does not establish which code path ran.

The critical diagnostic loss is LocalRuntimeState::audio_session(): try_lock().ok(), missing
connection, and both session/match queries via .ok().flatten() all become None. Its call in
Prepare then maps every such case to builtin_session_required. A configured/working game
sound does not prove that SQLite has an open session. Sound admission allows session=None.

BuiltIn/epoch absent does not distinguish no invoke from early preflight failure. In the
same uninterrupted process, post-drain failure leaves Draining, so BuiltIn would favor
pre-drain rejection; this inference requires confirmation that there was no restart or
manual recovery. Epoch absent is normal for unmigrated BuiltIn. Do not label any candidate
as the confirmed Windows failure without the command response/attempt evidence.

Errors from the manual_action closure are returned through live_transition/finish and
stored in Manager transfer.error; the UI displays them at the top of Plugins. An error in
Manager begin is only returned to the UI. Existing rolling logs contain lifecycle events
but not a complete Prepare audit. Even log silence cannot prove that native was not called.

## Options

1. First inspect the existing top-of-page error and click-time app.log/app.log.1 plus whether
   Companion restarted. This performs no write or repeated Prepare. Lifecycle logs can
   corroborate session availability but cannot conclusively prove each native invocation.
2. If those observations do not establish the cause, add a bounded native preparation trace
   to the existing safety status and rolling log. Proposed below; not implemented or released
   by this audit. UI-only feedback cannot disambiguate swallowed session lookup failures.

## Recommendation

Minimal native diagnostic change, preserving every safety check:

- Use a Result<Option<session>> lookup only for manual Prepare, with distinct stable codes
  for history_busy, local_runtime_lock_poisoned, local_runtime_unavailable, match_lookup_failed,
  session_lookup_failed and builtin_session_required. Keep the current optional accessor for
  other existing callers; do not change session creation or game algorithms.
- Record accepted native entry, Manager admission, session lookup, package verification,
  drain, audio fence, OBS fence, schema inspection, backup/migration, preflight and completion.
- Expose last preparation attempt in existing dota_runtime_safety_status: attempt ID,
  started/finished timestamp, stage, pending/succeeded/failed, stable error code, confirmed
  post-state only on successful completion. Retain failure independently of polling.
- Mirror stage/error to existing app.log with no account/session UUID, raw GSI, SQL, secrets
  or arbitrary paths. Distinguish process-local "no attempt recorded" from historical absence;
  do not infer that an older process never invoked Prepare.
- A rejected concurrent click must not replace the active attempt. Retain Manager atomic
  admission, transition lock and SQLite coordinator lock. Do not turn timeouts into success
  or retry migrations automatically. Do not add a runtime/protocol/harness.
- Test explicit session absence vs mutex busy/SQL error, early package failure, fence failure,
  repeated clicks, failure surviving polling, ACK/post-state success and no writes on status
  reads. Use mocks/temporary SQLite and existing fence tests; native Windows remains manual.

## Follow-up

The user subsequently confirmed no top-of-page error and no Companion restart. A completed
post-drain failure would leave Draining in this uninterrupted process; the observed BuiltIn
therefore does not fit that failure path. However it still does not distinguish a disabled
button/no invoke, a pending IPC/native operation before drain, or a missing rejection display.
The custom IPC bootstrap has no command-specific filter for dota_runtime_action; it only
excludes subframes, and preserves the existing fetch/postMessage transport. No new static
evidence establishes which branch occurred on Windows. Native-entry/stage/result tracing
is necessary if existing observational data cannot resolve it; do not repeat migration as
a diagnostic probe or present builtin_session_required as the measured root cause.

Wait for existing Windows top-of-page error and restart history. If insufficient, implement
the above native diagnostic patch in the feature branch, then targeted validation. Publishing
a new Companion version still requires separate user authorization. No auto-migration,
backup deletion, fallback bypass, activation or package/release publication in this audit.

## Sources

User's Windows smoke observations; repository source:
core/dota_live.rs, core/plugin_manager.rs, local_runtime/mod.rs, local_runtime/store.rs,
local_runtime/transaction_schema.rs, game_sounds/audio_fence.rs, obs.rs,
pages/PluginsPage.tsx, plugins/api.ts, storage/mod.rs and local_runtime/lifecycle.rs.
