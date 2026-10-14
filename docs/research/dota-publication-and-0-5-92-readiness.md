# Official Dota publication and Companion 0.5.92 readiness

## Question

Publish the verified official Windows Dota 0.1.0 package/catalog and prepare the next
stable Companion update without publishing Companion, merging main, or touching user data.

## Current state

On 2026-10-14 the authenticated repository lookup and public catalog URL returned 404.
Created public `BaranovRoman/prereborn-companion-plugins`; there was no remote catalog
to merge and no existing remote entries were replaced. The local embedded macOS Hello
seed remains unchanged; it was not a previously published remote catalog.

Published assets were downloaded from successful Windows CI run `38502058571`, compared
byte-for-byte with local signed staging, uploaded as drafts, downloaded and compared again,
then published package-first/catalog-second. No private signing key was uploaded or committed.
The official plugin trust root is unchanged; no developer verification bypass was used.

## Findings

All four public downloads returned HTTP 200 without authentication and exactly matched
the Windows CI-verified bytes:

| Asset | Bytes | SHA256 |
| --- | ---: | --- |
| Dota ZIP | 615602 | `24bc377546aa5b0a51e4d911c95ab474eef8d0a17769576d8c8c14423e1b384a` |
| Release metadata | 1831 | `32f39252ceb31be48716a67144560265ffa159f922380e64aa8dc4eaa9cdb95a` |
| Catalog | 2006 | `ec6adf3e9110926b84bbbb91eb85f9f7740e6d83cbaa6708f842cd524aeb9377` |
| Catalog signature | 297 | `1d45a54586a96e6edd77d3fe6e6eeb4ba7445764ccb06c6ef2dbbaafd1d3c83f` |

Catalog contains the exact signed release metadata, Windows/x86_64 and IPC API 1.
Existing Windows verifier checked catalog/manifest/archive signatures against the embedded
official key, all payload hashes, disabled installation, executable revalidation,
archive/executable tamper rejection, uninstall/reopen. Installation did not launch a process.
Public byte equality establishes that those checks apply to the published artifacts;
no new native in-app installation was claimed during publication.

Existing PluginManager refresh downloads the published catalog/signature from its unchanged
official URLs. Installation downloads the release URL and calls the same Store installation
path. No manual copying is needed. Published 0.5.91 already understands the live manifest and
permissions, so it can install disabled; it intentionally cannot activate External Dota.
Manual activation UI/preflight requires the prepared 0.5.92 candidate.

Windows CI evidence:

- `38500100461`: unsigned Companion 0.5.92 NSIS, bundle/version/inventory verification,
  packaged GSI/overlay checks, supervisor assertions, frontend/Rust checks: success.
- `38500097148`: independent static-CRT Windows x64 worker and five real process IPC tests:
  success. No VCRUNTIME/MSVCP dependency in the verified worker.
- `38502058571`: exact official signed package and catalog validation on Windows: success.

Core candidate source is `7b89fdd47f70aaa91579f367c8477fb3494ce69c`. Subsequent `16da5f8`
changes only package-tool UTF-8 serialization, and `0842ae1` only documentation; Companion
runtime, frontend and release workflow are unchanged relative to the unsigned tested source.
The core bundle still includes BuiltIn Dota/domain, sounds and original overlay for default
operation/fallback. The independently downloadable Dota executable/package is excluded
from the checked core installer. This is not complete physical extraction of BuiltIn Dota.

Stable release and public updater manifest remain **0.5.91**, verified after plugin publication.
The manifest has `windows-x86_64`. Proposed **0.5.92 > 0.5.91 > 0.5.89** by SemVer.
Identifier remains `com.romanbaranov.dota-companion`; the existing updater endpoint/key,
data paths and default BuiltIn runtime are unchanged. No automatic migration or External
startup on ordinary startup/restart/update. No user SQLite was opened or changed here.

## Options

- Publish the exact CI-verified package/catalog now: authorized and completed; fixes the
  existing catalog 404 without a Companion update.
- Publish Companion 0.5.92 immediately: not authorized and native live acceptance is open.
  Do not create its stable tag or invoke signing/release as part of plugin publication.

## Recommendation

Use Plugins → Refresh → Dota 2 → Install on Windows 0.5.91 first: expect signed installation
disabled and no worker. Use the approved unsigned 0.5.92 Actions candidate for the existing
native checklist before deciding on the stable update. No additional architecture phase is
needed to begin that test. CI does not prove real WebView audio, real game GSI or OBS behavior.

## Follow-up

Remaining native acceptance: real GSI/history/session transitions, game-only audio fence
alongside Twitch/TTS, OBS reconnect/config/manual/ambiguous-response reconciliation,
worker/core crash/orphan handling, durable Unknown and External → BuiltIn with a fresh epoch.
Run `docs/operations/dota-windows-native-smoke.md`; keep fail-closed gates if proof is missing.

After acceptance and separate explicit Companion release approval:

1. Recheck remote stable version and freeze the exact approved candidate source. If any
   runtime code changes from `7b89fdd`, repeat relevant unsigned Windows checks.
2. Create/push `prereborn-v0.5.92` on that verified source without merging main. The existing
   Windows workflow stamps package.json, Tauri config and Cargo version from this tag.
3. Let the existing stable pipeline use the existing updater signer. Its prepublication gates
   verify NSIS metadata/inventory, packaged smoke, SHA256, shipped-key updater signature,
   monotonic stable version, latest.json identity and complete release assets. On failure,
   stop; do not publish an incomplete release or substitute unverified artifacts.
4. Only successful tag workflow publishes Companion Release/latest.json. Then verify public
   manifest 0.5.92, installer URL/hash/signature and standard updater availability. Native
   upgrade/settings/Twitch/TTS/OBS/Dota verification remains user acceptance.

No Companion signing, release tag, latest.json publication, merge, automatic migration,
user DB modification or user .gitignore modification was performed during this publication.

## Sources

- [Official Dota release](https://github.com/BaranovRoman/prereborn-companion-plugins/releases/tag/dota2-v0.1.0)
- [Official catalog](https://github.com/BaranovRoman/prereborn-companion-plugins/releases/tag/catalog-v1)
- [Public catalog endpoint](https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/catalog-v1/catalog.json)
- [Signed Windows package verification](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38502058571)
- [Unsigned Companion candidate](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38500100461)
- [Independent Windows worker](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38500097148)
- [Existing stable release](https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.91)
- Repository source: `core/plugin_manager.rs`, `plugins/manager/src/lib.rs`,
  `tauri.conf.json`, `.github/workflows/windows-release.yml`, existing native checklist.

## Stable 0.5.92 publication — 2026-10-14

The user confirmed successful signed Dota 0.1.0 installation through Plugin Manager on
Windows Companion 0.5.91, with the plugin remaining disabled. They then explicitly authorized
the full stable Companion 0.5.92 release, deferring real GSI/audio/OBS/crash acceptance until
after their Windows update. This supersedes the earlier requirement to await native acceptance
before publication, but does not establish that those native checks have passed.

Published stable tag `prereborn-v0.5.92` points to
`864e7a29ccdd1758b4ebcab4640dc159f3d927d4` on the feature branch, without merging main.
Runtime/frontend/release workflow were compared against successful unsigned Windows source
`7b89fdd` and were identical; later commits affected only plugin package tooling and docs.
User `.gitignore` changes were excluded and preserved.

[Stable release workflow 38508030525](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38508030525)
completed successfully. Required prepublication steps passed: actual Windows Credential
Manager, signed NSIS build, version/identifier/endpoint and installer inventory, exact NSIS
payload verification (only the existing Tauri UNK → NSS patch), packaged GSI/canonical overlay
HTML/state/SSE and synthetic Draft/Gameplay smoke, second-instance rejection, SHA256,
standard Silero synthesis/package, updater manifest generation, cryptographic updater
signature verification with the shipped key, and complete release-asset gate. Only then was
the Release/latest.json published; the normal production deploy notification also succeeded.
The independent Dota executable/package is absent from the core installer; BuiltIn remains
embedded and default.

[Published Companion 0.5.92](https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.92)
is public, non-draft and non-prerelease. Public `/releases/latest/download/latest.json`
now returns version `0.5.92`, platform `windows-x86_64`, and installer URL:

`https://github.com/BaranovRoman/prereborn-companion/releases/download/prereborn-v0.5.92/PreReborn.Companion_0.5.92_x64-setup.exe`

The public installer and sidecars each returned HTTP 200. Downloaded installer size:
**25,445,972 bytes**; SHA256:
`39da2f8a6a0e1330964975b767830031ea691b05e4c7c20c2de8039a1bea767d`.
The existing read-only `verify_updater_release` verifier checked these downloaded bytes
against the unchanged configured updater key, public manifest/sidecar signature identity,
SHA256 and exact URL/version. It also used the actual updater RemoteRelease SemVer types
to confirm an update is offered over both `0.5.91` and `0.5.89`.

No updater key, identifier, data path, automatic migration or startup activation changes
were made during release. External remains disabled until the explicit manual action.
No user SQLite was touched, no main merge was performed, and no native GSI/audio/OBS/
crash-recovery/real upgrade/settings acceptance is claimed by these checks.

First Windows action: update through Companion's normal updater and restart; verify version
0.5.92, existing settings/history and BuiltIn behavior. Before testing External, end the real
stream, use OBS with valid mappings and start a normal BuiltIn session. Plugins → Dota →
manual confirmation → Prepare backup and migration; wait for BuiltIn and Unknown=0, then
Enable External Dota. For safe return use Disable External → BuiltIn and verify a newer epoch
and worker termination. Draining/Unknown is a blocker, not successful fallback; preserve the
error/data and follow the existing native checklist. Never restore an old backup after new writes.
