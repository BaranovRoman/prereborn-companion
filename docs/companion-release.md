# Desktop Companion release, install, update, and rollback

Companion is distributed as a Windows NSIS installer built by
[`windows-release.yml`](../.github/workflows/windows-release.yml) (see that
file for how a `prereborn-v*` tag turns into a GitHub Release). This doc
covers what happens on the user's machine, not the CI build itself.

## Supported flow

There is no in-app auto-updater yet (tracked separately, WK-70). The
supported flow is: **download the installer from the GitHub Release, verify
its checksum, run it.** Running a newer installer over an existing install
is a normal Tauri/NSIS upgrade-in-place — no separate uninstall step.

## Verifying a download before installing

Every release includes a `<installer>.exe.sha256` file next to the `.exe`
(added in WK-58). Verify before running:

```powershell
./scripts/companion-verify-installer.ps1 -InstallerPath 'C:\Downloads\dota-companion_0.5.0_x64-setup.exe'
```

Or manually: `Get-FileHash <installer>.exe -Algorithm SHA256` and compare
against the `.sha256` file's contents. A mismatch means the download is
corrupted or was tampered with — do not run it; re-download instead.

## Why settings survive an update

Non-secret settings (OBS host/port/scene names, logs, overlay/queue
settings) live under the OS app-data directory (`app_data_dir()`, see
[`storage/mod.rs`](../apps/companion/src-tauri/src/storage/mod.rs)). The
companion token, session refresh token, and OBS WebSocket password instead
live in the OS credential store (Windows Credential Manager) — see
[WK-125's audit](research/wk-125-desktop-secret-storage-audit.md) for why.
Both locations are separate from the NSIS install directory and from each
other: re-running the installer replaces the installed binary/assets only —
it never touches app-data or the OS credential store — so updates (and
reinstalls) preserve the login, OBS settings, and logs without any extra
migration step.

## Incompatibility handling

Companion sends its own version on every GSI update. The backend rejects
payloads from companions older than `MIN_SUPPORTED_COMPANION_VERSION` (see
[`apps/api/src/utils/companion-version.ts`](../apps/api/src/utils/companion-version.ts))
with HTTP 426, and the companion surfaces that as a plain "outdated, please
update" message in the existing backend-status panel — no separate UI was
needed. Bump the minimum only when an older companion would genuinely
misbehave against the current backend contract, not on every release.

## Rollback

GitHub Releases keeps every past `prereborn-v*` tag with its installer
attached. To roll back, download and run an older release's installer the
same way as an update — it reinstalls over the current version and app-data
is preserved exactly as described above. There is no separate "rollback"
button; the installer *is* the rollback mechanism.

## Out of scope here

Code signing (WK-60), in-app automatic updates (WK-70), Steam distribution,
silent enterprise deployment.
