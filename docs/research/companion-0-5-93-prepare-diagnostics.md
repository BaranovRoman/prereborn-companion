# Companion 0.5.93: Dota Prepare diagnostics

## Question

Release UI fix a2b43d4 and minimal native Prepare diagnostics via the existing stable updater.
The user authorizes signing/tag/publication only after passing targeted checks and Windows CI.
Do not automatically Prepare, migrate, activate External or merge main.

## Current state

Stable is 0.5.92; the next version is 0.5.93. Runtime defaults, migration SQL, audio/OBS fences,
updater key/endpoint, identifier/data paths and installed Dota package are preserved.
Only explicit main-window manual Prepare records an attempt. New fields in existing safety
status are additive. No parallel runtime, protocol, executor or storage namespace is added.

## Findings

- UI displays disabled reason, pending/native acknowledgement/post-state result and persistent
  command error beside Dota controls. Polling retains the last native attempt/error and avoids
  overwriting confirmed post-state with an older read. Late results after unmount do not read
  post-state. Success still requires ACK and confirmed BuiltIn/epoch/quota/Unknown=0.
- Native stores one bounded last attempt in LiveDota and exposes it through safety status:
  attempt UUID, stage, pending/succeeded/failed, errorCode, start/finish timestamps. app.log
  records accepted entry and stages/results. A concurrent Prepare is rejected and logged
  without replacing the active attempt. The original Manager/transition/SQLite guards remain.
- Required stages: native_received, manager_admitted, session_checked, package_verified,
  draining, backup, completed. Additional session_lookup/package_check/audio_fence/obs_fence/
  schema_check/preflight stages identify a pending or failed check. `backup` means the stage
  was entered, not that backup/migration committed. `completed` requires the entire original
  manual action to succeed. No migration/backup implementation was changed.
- Session lookup preserves active-match then open-session fallback, but irrecoverable errors
  are history_busy, local_runtime_lock_poisoned, local_runtime_unavailable, match_lookup_failed,
  session_lookup_failed; true absence remains builtin_session_required. Legacy audio_session
  and its callers are unchanged.
- Logs contain only attempt/stage/status and bounded safe error codes. Unexpected free-form
  errors are mapped to prepare_native_error in the trace; the existing command rejection is
  preserved. No session/account IDs, raw GSI, secrets, arbitrary SQL or paths are logged.
- Trace state is process-local; app.log preserves prior attempts. On restart, UI explicitly
  says no attempt recorded *in this run*, never that Prepare was never invoked historically.

Local checks: 19 targeted Vitest tests; 4 Rust diagnostic tests; one migration idempotence/WAL
backup test and one Manager serialization test; TypeScript noEmit, cargo check and diff check.
An initial frontend test exposed a late unmounted post-state read; fixed before final passing
checks. Rust checks used in-memory/temporary SQLite only. No user DB was accessed.

## Options

Use the existing unsigned Windows validation (with targeted Prepare frontend tests added)
and existing stable tag/signing gates. Do not add an updater channel or diagnostic harness.
If final CI fails, do not create/publish the stable release.

## Recommendation

Freeze the validated feature source, run unsigned Windows 0.5.93 CI, then create the approved
stable tag only after success. Existing release checks validate installer metadata/contents,
packaged runtime, SHA256 and shipped-key updater signature before publication. Afterwards
download public latest.json/installer/signature/checksum and verify again.

## Follow-up

After updating to 0.5.93: outside a real stream, open Plugins → Dota, inspect disabled reason,
check manual confirmation and click Prepare **once**. Do not enable External yet. Send
Attempt, stage, status, exact code, Runtime/Epoch/Unknown and app.log lines containing
`Dota Prepare` for that attempt. If pending, capture stage and do not click again; if Draining
or Unknown, preserve backup/data and do not bypass fences. Native live acceptance stays open.

## Sources

Repository UI/API, core/dota_live.rs, local_runtime/mod.rs, existing migration and Manager
guards, windows-release.yml and targeted tests. User Windows reports/explicit release approval.

## Release evidence — 2026-10-14

Release source/tag: `prereborn-v0.5.93` →
`3e8f06ca9b2dd51354a8ca472bb1e972ecd6aa79`, including UI fix a2b43d4.
Unsigned [Windows CI 38561860823](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38561860823)
completed successfully on that exact commit: five supervisor assertions passed (three
deliberately ignored worker fixture entrypoints), targeted Prepare UI/invoke tests passed,
Credential Manager/NSIS metadata/inventory/packaged GSI+overlay smoke passed. Stable tag
was created only after that success; no main merge or user .gitignore change.

[Stable pipeline 38562969182](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38562969182)
completed successfully and passed its mandatory prepublication checks: signed NSIS build, version/identifier/endpoint,
inventory and exact SDK NSIS payload patch, packaged GSI/overlay and single-instance smoke,
standard Silero synthesis/packaging, checksum, updater manifest, configured-key signature
verification and complete release assets. These successful gates preceded publication.

[Companion 0.5.93 Release](https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.93)
is public, non-draft/non-prerelease. The existing public latest.json reports `0.5.93` and
windows-x86_64 with:

`https://github.com/BaranovRoman/prereborn-companion/releases/download/prereborn-v0.5.93/PreReborn.Companion_0.5.93_x64-setup.exe`

Downloaded installer: **25,424,043 bytes**. SHA256:
`fb8551dc75349d1f8b6b4a5d9cc028e320a2eabfd41305422f3d04bf392c49ec`.
Public installer, signature and checksum returned HTTP 200. The existing read-only
verify_updater_release verifier checked downloaded bytes against the unchanged configured
key, latest.json/sidecar signature identity, exact URL/version and SHA256. Actual updater
RemoteRelease version comparison passed against 0.5.92 and 0.5.89.

No automatic Prepare/migration/External activation, Dota package/catalog publication, updater
key/identifier/path changes, main merge or user DB access during release. Real native Prepare
on the user's PC and real GSI/audio/OBS/crash tests remain unverified; the new trace is intended
to establish the measured rejection/pending stage, not to claim the 0.5.92 root cause is fixed.
