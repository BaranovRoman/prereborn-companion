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
