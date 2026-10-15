# Companion 0.5.94 stable release

## Source and authorization

User approved the stable release, existing updater signing, tag and Release/latest.json,
without main merge or plugin package publication/update. Release source is exactly
`48c3198fa15baacab156f48e7f3be89cf0fd0f39` (Cold Switch), the source of successful
[unsigned Windows validation 38611552935](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38611552935).
Feature HEAD `0893d3e` only added validation documentation. Stable tag `prereborn-v0.5.94`
points to the validated code commit, not an untested implementation.

Published stable before release: 0.5.93. The approved next version is 0.5.94.
Identifier remains `com.romanbaranov.dota-companion`; existing data paths, updater public key
and canonical endpoint are unchanged. No user SQLite was accessed. `.gitignore` was excluded.

## Published Dota 0.1.0 compatibility

Fresh public catalog, catalog signature and Windows ZIP were downloaded. The existing
Plugin Manager cryptographic functions verified official catalog/archive/manifest signatures
with the shipped trust root. Every declared file hash matched; executable PE machine is AMD64.

- Package SHA256: `24bc377546aa5b0a51e4d911c95ab474eef8d0a17769576d8c8c14423e1b384a`.
- Executable SHA256: `f514641923a0bd92900d304b6e11d26fbfe862cb5d13a8e510d4b7258863626d`.
- Manifest target: Windows x86_64, live Dota, IPC/core API range 1..1.
- All `plugins/` source, protocol, domain, lockfiles and worker source are unchanged from
  `16da5f8`, source of [successful exact signed Windows package validation 38502058571](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38502058571).
- The existing full installer verifier correctly refuses a Windows install on macOS with
  `incompatible_platform`; that check was not bypassed. Cross-platform signature/hash checks
  above are read-only and are not described as a new native Windows installation test.

Cold bootstrap changes core authorization/lifecycle only: worker starts supervised and idle;
session-bound IPC is withheld until fresh real GSI causes atomic session/receipt/ownership
binding. The first request uses the existing nonempty session scope and existing IPC v1.
No new worker command or wire format is required. Dota 0.1.0 does not need an update.
No catalog or package was changed. This is binary/contract compatibility evidence, not
completion of real Windows GSI/audio/OBS acceptance.

## Release pipeline and public verification

[Stable workflow 38662347236](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38662347236)
uses the existing tag-triggered Windows release job and existing signing secrets. Its gates
include NSIS metadata/inventory, packaged GSI/overlay smoke, checksums, configured-key updater
signature/version/URL verification and full asset verification before publishing.

Published stable (not draft/prerelease) at `2026-10-15T01:10:52Z`:
[PreReborn Companion 0.5.94](https://github.com/BaranovRoman/prereborn-companion/releases/tag/prereborn-v0.5.94).
Every pre-publication gate passed, including configured-key updater signature and complete
asset verification. Publication, the existing production notification and post-cache completed.
Final workflow status: **completed / success**, source `48c3198fa15baacab156f48e7f3be89cf0fd0f39`.

Post-publication checks:

- Canonical [latest.json](https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/latest.json)
  returned 0.5.94 and was byte-identical to this tag's uploaded manifest.
- Installer downloaded from the actual manifest URL (25,466,139 bytes). SHA256:
  `dbfb40ea5f1623f7d1f52c5706aadd86d6ea0bc1ecd2425ac19d3063024f9c95`.
  GitHub asset digest and published checksum agree.
- Downloaded `.sig` equals the manifest signature; the existing `verify_updater_release`
  executable independently verified the public installer with the unchanged configured
  updater key, checksum, exact URL/version/sidecar and actual updater semver parsing.
  0.5.94 is offered over both 0.5.93 and 0.5.89; no manual NSIS installation is required.
- All eight public assets are reachable. Both large Silero ZIP URLs returned HTTP 200 via
  HEAD only; their GitHub asset digests match downloaded checksum sidecars. They were not
  downloaded/rebuilt on macOS. Their bytes were checked by the release pipeline.
- The release pipeline verified app identifier/endpoint/version, exact NSIS payload and
  inventory (no separate Dota worker/package/private signing key), Credential Manager and
  synthetic packaged GSI/overlay/single-instance smoke. Real gameplay acceptance is separate.

## First Cold Switch on Windows

1. Update from 0.5.93 through Companion's standard updater; verify displayed 0.5.94. Check
   existing settings/history. BuiltIn remains default; do not expect automatic migration or
   automatic External startup.
2. Close Dota and OBS. Plugins → installed official Dota 0.1.0 → explicit confirmation →
   Prepare once. Expect native `completed / succeeded`, valid backup and available quota.
3. Enable External explicitly. Expect a newer epoch and “ожидание игровой сессии”. Before
   playing, disable once: expect confirmed worker stop and BuiltIn with another newer epoch.
4. Enable again, launch Dota and a real match. Real session creation removes the waiting
   status. Demo/idle sounds without a real session intentionally do not execute; BuiltIn is
   not a parallel sound executor while External owns the game pipeline.
5. Check real GSI, configured sounds, OBS transitions/reconnect and history, then disable
   External outside the match. Expect confirmed fallback and unaffected Twitch/TTS.

If Prepare fails, share attempt/stage/status/code. If Unknown/Draining or a fence error occurs,
stop that acceptance step and share runtime/epoch/quota and relevant app.log lines. Do not
clear ledger, delete backups or restore an older SQLite after new writes. Do not share raw
GSI/account IDs/tokens/passwords. Extended crash/recovery checks remain in the existing
[native checklist](dota-windows-native-smoke.md).

Real upgrade preservation, live GSI, WebView sound/cancellation, OBS and fallback/crash recovery
remain pending the user's Windows test. CI synthetic/component smoke does not prove them.
