# Windows Dota installation and manual live activation

## Question
What prevents installation and real External Dota execution from the Plugins tab after 0.5.91?

## Current state
0.5.91 was released and the user confirms Windows upgrade. Work stays on
`codex/plugin-runtime-prototype`; no new app release, catalog or package is published.

## Findings
- The actual catalog URL is
  `https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/catalog-v1/catalog.json`.
  Both public download and authenticated repository API returned 404. Embedded signed seed
  contains only macOS/aarch64 Hello; Windows filtering therefore returns no rows.
- 0.5.91 explicitly rejects installed Dota enable/start. Publishing a ZIP alone cannot enable it.
- Existing plugin signer public key matches the shipped trust root. The plugin key is distinct
  from updater signing and remains local/ignored. No key is sent to CI or repository.
- Existing Windows workflow now has an artifact-only standalone worker/UI job. It never signs,
  publishes, builds Companion or uses updater secrets. First run 38495534299 failed at the
  outdated IPC test initializer, before any artifact publication. The test now covers current
  match analysis and live handshake, and bounds process exit waiting instead of hanging on
  an obsolete expectation that --live is unsupported.
- Manual main-window actions use existing LiveDota, PluginManager pin, transaction adapter and
  consumer. Preparation drains admission, obtains actual game-only audio acknowledgement and
  fresh OBS state, then explicitly creates/verifies the existing additive migration backup.
  Activation separately verifies signed installed live grants, schema/backup, quota/Unknown,
  epoch/session and actual fences before starting the existing supervised worker.
- No startup, registry restore or updater activation is added. Recovery uses the existing
  generation-job supervisor outside history locks, requires zero Unknown and issues a new
  BuiltIn epoch. It never restores an old history backup. Package mutations are serialized
  with transitions; live update is staged, removal/generic stop cannot bypass the coordinator.
- Failed fallback retains the existing process actor/termination witness in Draining. Retired
  consumers cannot pop frames for a later epoch. Initial OBS reconciliation uses the existing
  sanitized cached GSI instead of an invented game state.

## Options
Publishing a replay package or removing signature/ownership checks would not meet the goal.
Use the existing real Windows worker plus a Companion candidate with these manual controls.

## Recommendation
Prepare the signed Windows ZIP/catalog locally from successful CI artifacts. Verify native
installation against the shipped trust root. Obtain publication approval for the exact
official repository/assets, and app distribution approval separately. Then perform the
existing app's actual Windows smoke, not a substitute replay harness.

## Follow-up
User agreed to run native smoke. Task remains incomplete until signed catalog download,
in-app installation, real GSI/audio/OBS, crash/recovery and BuiltIn fallback pass on Windows.
Unknown, missing backup, quota exhaustion or unconfirmed fences must remain blocked.
See `docs/operations/dota-windows-native-smoke.md`. CI/package outcomes are recorded below
when available. Stable 0.5.91, updater key, identifier, user DB and .gitignore remain untouched.

## Sources
`core/plugin_manager.rs`, `core/dota_live{.rs,/ipc.rs}`, `local_runtime/transaction_schema.rs`,
`local_runtime/transaction_authorization.rs`, `game_sounds/audio_fence.rs`, `obs.rs`,
`plugins/manager/trusted.pub`, `plugins/catalog/catalog.json`, `plugins/tools/package.py`,
`.github/workflows/windows-release.yml`; actual GitHub catalog/repository 404 responses.

## Prepared artifacts and verified results

- Application runtime/build source: `7b89fdd47f70aaa91579f367c8477fb3494ce69c`.
  Unsigned Companion 0.5.92 run **38500100461 SUCCESS**: 5 native supervisor assertions
  (3 subprocess fixtures intentionally ignored), Credential Manager, TS/frontend/Rust,
  NSIS metadata/inventory (no Dota worker), exact bundle marker check, packaged GSI/overlay
  and single-instance smoke. No updater signing or publication.
- Static-CRT Dota worker run **38500097148 SUCCESS**. Actual initial executable imported
  VCRUNTIME140.dll; final executable imports only api-ms-win-core-synch-l1-2-0.dll,
  bcryptprimitives.dll, KERNEL32.dll and ntdll.dll. Build flag is documented by
  [Rust Reference](https://doc.rust-lang.org/reference/linkage.html#static-and-dynamic-c-runtimes).
- Exact signed candidate run **38502058571 SUCCESS** on `16da5f8` (only packaging UTF-8 fix
  since application build source). It reconstructed the exact local ZIP from the original
  CI payload + public signed metadata, checked archive identity, then used the existing
  Windows Store/verifier with the shipped TRUSTED_KEY. Catalog/manifest/ZIP signatures,
  file hashes, disabled install, archive/executable tampering rejection and uninstall/reopen
  passed. No install during this check launches a process; separate real Windows process IPC
  tests passed 5/5. First exact signed attempt failed on Python cp1252 JSON reading; fixed
  explicit UTF-8, not signature/hash bypass.
- Local targeted checks: 5 worker process IPC, 3 ownership gate, 2 manual recovery, 1 manager
  transition/race and 1 real worker/facade write-set round-trip test; 6 PluginsPage plus 44
  game-audio/Twitch isolation tests; 3 package serialization/reconstruction tests. Affected
  Rust core/verifier cargo checks, TypeScript and git diff --check passed.

Staged signed assets (ignored local directory, no private key):
`plugins/packages/dota-windows-live-candidate/` contains
`dota2-0.1.0-windows-x86_64.zip`, `.release.json`, `catalog.json`, `catalog.minisig`.
ZIP size **615,602 bytes**, SHA256:
`24bc377546aa5b0a51e4d911c95ab474eef8d0a17769576d8c8c14423e1b384a`.
Executable SHA256:
`f514641923a0bd92900d304b6e11d26fbfe862cb5d13a8e510d4b7258863626d`.
Reviewed catalog contains only the real Windows Dota release; no fake Windows Hello entry.

Actions artifacts: `verified-dota-windows-candidate` in run 38502058571 and
`prereborn-companion-windows` in run 38500100461. These are staging artifacts, expire,
require GitHub access and are not official store endpoints or public app updates.

Next permission: create/configure the public repository at the already embedded official
URL; publish exact verified ZIP/release metadata under `dota2-v0.1.0` and catalog/signature
under `catalog-v1`. No updater endpoint/key rotation. Companion native-smoke distribution
is the unsigned 0.5.92 staging installer; a new signed/public Companion release needs
separate approval. Stable latest remains 0.5.91. Live UI controls are in the existing host
Plugins page; the bundled replay UI is not presented as a working live iframe.

Acceptance remains OPEN: the user must perform real WebView game audio fencing alongside
Twitch TTS, OBS reconnect/config/manual/lost-response reconciliation, real Dota GSI/match
writes, crash/restart/orphan handling and fresh-epoch BuiltIn fallback. Unknown cannot be
cleared by this UI; if proof is missing, report the exact blocker and keep Draining.
