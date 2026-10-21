# Official plugin packages — iteration 3

Companion's installed plugins use the existing IPC v1 `PluginHost`; the manager adds signed
files and lifecycle orchestration. Dota is still built in. Iteration 4 permits a signed
`dota2` replay package to be installed disabled, but blocks enable/start/restore. Other
Dota-like IDs remain reserved. See [Dota replay prototype](dota/README.md).
Plugin Lab remains a separate debug entry point.

## Package and trust

ZIP contains `manifest.json`, `manifest.minisig`, `bin/<executable>` and `ui/*`. Manifest schema 1:

```json
{
  "schema": 1, "id": "hello", "name": "Hello World", "description": "Official test plugin",
  "version": "0.1.0", "platform": "macos", "arch": "aarch64",
  "minApi": 1, "maxApi": 1, "executable": "bin/companion-hello-plugin",
  "ui": "ui/index.html", "permissions": ["ui"],
  "files": { "bin/companion-hello-plugin": "<sha256>", "ui/index.html": "<sha256>" }
}
```

Only `ui` is currently a recognized permission. It authorizes the sandboxed UI and the
bounded Hello greeting bridge, not arbitrary core commands. A native executable has the
user's OS rights; `env_clear` and IPC isolation are **not** an OS sandbox.

The signed catalog lists complete manifests, HTTPS URLs, ZIP SHA-256 and detached ZIP
signatures. ZIP and manifest use prehashed Ed25519 Minisign signatures. The host has one
embedded public key in `manager/trusted.pub`, independent of the application's updater key.
Signatures here are decoded Minisign text, **not** the base64 wrapper emitted by Tauri CLI.
`tools/package.py` converts that wrapper and isolates signing from updater environment vars.
The signed manifest and every declared file are checked again before process launch; extra
files, symlinks and a handshake ID/version mismatch prevent execution.

Installer bounds: 32 MiB archive/file, 64 MiB total expansion, 512 payload files,
128 KiB metadata, 4 KiB signatures, 10 path segments, 240 path bytes. ZIP directories,
symlinks/special modes, traversal, drive/ADS/device paths, ambiguous casing and undeclared
entries are rejected. No payload runs during installation. UI files are limited to HTML,
JS and CSS, 1 MiB each; each served file is checked against the signed manifest.

## Lifecycle, recovery and data

New files live only under the existing app data directory's **new** `plugins/` subdirectory.
Existing user settings, SQLite, credentials, Dota paths and app identifier stay unchanged.

- `versions/<id>/<version>`: immutable signed package contents.
- `staging/`: disposable extraction directories, removed on restart after interruption.
- `data/<id>`: reserved user data; uninstall leaves it intact. Hello currently has no durable
  user data and receives no new filesystem/core access via the UI bridge.
- `registry.json`, `registry.next`, `registry.backup`: versioned JSON registry with recovery
  from an interrupted rename. Writes sync the file before activation.

Extraction goes to staging, then a same-volume rename activates the complete directory.
Registry changes are persisted separately with a recoverable replacement. A running plugin
keeps its executable and UI version; an update becomes `pending`, and activation happens
only after stop, before next start, or on application restart. Active and previous versions
are retained, plus at most one pending version. Old unreferenced versions are pruned.
A damaged pending version is rejected at activation, the old active version remains usable,
and the registry keeps the error. Rollback requires a stopped plugin and verifies the
previous version before swapping pointers. Automatic downgrade via catalog install is blocked.

Enabled plugins restart from the verified registry. Disabled plugins remain stopped.
A crash is reported by the existing runtime supervisor and is not automatically restarted
in a loop. Stop, disable, delete and application exit reap children. One manager lock
serializes file/lifecycle mutations; it is separate from AppState/Twitch/TTS locks.
HTTPS runs outside it. Cancellation returns promptly even during a stalled read; the bounded
network worker discards its response and finishes on its next read or the 60-second timeout.

## Prepare Hello without building Companion

Commands below run from repository root (bash). Use already built artifacts when possible.
They do not publish or build Tauri bundles, Dota overlay or Silero.

```bash
# Only when Hello executable/UI need rebuilding:
cargo build --manifest-path plugins/Cargo.toml -p companion-hello-plugin
pnpm --filter @prereborn/companion exec vite build --config ../../plugins/hello/ui/vite.config.ts

python3 plugins/tools/package.py package \
  --binary plugins/target/debug/companion-hello-plugin \
  --ui plugins/hello/ui/dist --version 0.1.0 --platform macos --arch aarch64 \
  --output plugins/packages --key plugins/.signing/official.key \
  --url https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/hello-v0.1.0

python3 plugins/tools/package.py catalog \
  --release plugins/packages/hello-0.1.0-macos-aarch64.release.json \
  --output plugins/catalog/catalog.json --key plugins/.signing/official.key
```

For Windows pass the separately built `.exe`, `--platform windows --arch x86_64`.
For release packaging use independently built release Hello artifacts; the current local
package uses the existing debug artifact to avoid compilation. The manifest version must
match Hello's Cargo version/handshake. To test a genuine update, bump Hello's own version,
rebuild **only Hello**, package it, then sign a catalog including the new release. Package
integrity/update/rollback tests also use tiny signed fixtures without rebuilding binaries.

The signing key was generated locally in ignored `plugins/.signing/official.key` (directory
0700, files 0600). It is neither committed nor the updater key. Back it up securely before
publication; without it the embedded trust anchor cannot authorize new packages. For a
production key, choose secure storage/encryption first, replace the embedded public key and
re-sign the catalog before the first public release. `PLUGIN_KEY_PASSWORD` supplies an
encrypted key password without placing it on the command line. Fixture signatures use a
**different** test key/public key and are rejected by production trust.

## Test the in-app store

No repository or releases have been created/published. Embedded catalog contains the prepared
macOS arm64 Hello release. Its planned GitHub URL will return an error until a separate
publication is approved. This is not a working live GitHub download demonstration.

1. Start the updated feature-branch app in normal developer mode (`pnpm --filter
   @prereborn/companion tauri dev`), **without** `--plugin-lab`. This may compile the native dev
   executable; it was deliberately not launched for this iteration's economical checks.
2. Open **Плагины**. Production install uses the catalog's HTTPS URL, never a browser.
3. For the unpublished prototype, enter the absolute path to
   `plugins/packages/hello-0.1.0-macos-aarch64.zip` in the debug-only local package field.
   Select **Установить локальный подписанный пакет**. The package must exactly match the
   signed catalog; local installation cannot bypass any checks and is rejected in release.
4. Select **Открыть**, greet from the iframe, stop/restart, disable/re-enable. Delete and
   confirm any `plugins/data/hello` file remains. Restart app and check enabled/disabled state.
5. Install a newer signed release while Hello runs: old UI/process must stay alive and a
   pending notice appear. Stop to activate it; stop again and use **Откатить** to restore.
6. Refresh catalog offline: an error is displayed while installed plugins remain usable.
   In the new app, repeat Plugin Lab's iframe smoke with its documented debug arguments.

Current UI keeps `sandbox="allow-scripts"` with an opaque origin, no same-origin permission,
no network/connect, nested frames, forms or base URLs. The Windows custom-scheme equivalent
`http://plugin-ui.localhost` is allowed explicitly alongside `plugin-ui:`; no arbitrary HTTP
source is allowed. Main-frame Tauri bootstrap is preserved from Tauri 2.11.5, with an early
subframe guard because WebView2 injects initialization scripts into subframes. On a Tauri
upgrade compare the vendored IPC scripts with upstream before accepting the upgrade.

## Publication preparation (manual; not executed)

Use the **separate planned** repository `BaranovRoman/prereborn-companion-plugins`:

- Tag `hello-v<version>`: per-platform ZIPs from the independent package tool.
- Tag `catalog-v1`: `catalog.json` and `catalog.minisig` at the fixed endpoint embedded in host.
- Every plugin release needs a Russian user-facing entry for its version in
  `changelog/plugins/<id>.md` ([format](../changelog/README.md)); the GitHub Release text comes
  from `node scripts/changelog.mjs notes plugin <id> X.Y.Z`. CI requires the entry for the
  version in each `manifest.windows-live.json`, and prereborn.ru/changelog shows it once that
  version is in the published catalog.
- Form/sign catalog locally from one or more `--release` inputs, verify packages/tests before
  upload. Upload matching catalog and signature as one reviewed publication operation.
- Do not put `latest.json`, application installers or updater keys in this repository.
- Replacing a catalog while clients fetch can temporarily cause a signature mismatch; the
  client retains its previous verified catalog and never installs mismatched data.

No installer self-update, arbitrary repositories, third-party keys, marketplace backend,
permission prompts, OS sandbox or live Dota activation is included.

## Targeted validation

```bash
cargo test --manifest-path plugins/Cargo.toml -p companion-plugin-manager --offline
cargo test --manifest-path apps/companion/src-tauri/Cargo.toml --lib core::plugin --offline
# Environment-dependent integration is explicitly ignored in the normal suite:
# prepare the real signed Hello ZIP above, then run it independently.
cargo test --manifest-path apps/companion/src-tauri/Cargo.toml --lib \
  core::plugin_manager::tests::signed_hello_lifecycle_restores_without_touching_core \
  --offline -- --ignored
pnpm --filter @prereborn/companion exec vitest run \
  src/pages/PluginsPage.test.tsx src/plugins/ipc.test.ts \
  src/plugin-lab/bridge.test.ts src/components/AppShell.test.tsx
pnpm --filter @prereborn/companion exec tsc --noEmit
```

Tests cover signatures/catalog trust, archive damage/traversal/symlink/limits, API mismatch,
cancel/rollback/recovery/tampering, actual signed Hello lifecycle and existing runtime failures,
UI actions and source-filtered bridge, native IPC main-frame and blocked subframe behavior.
The official-package integration is deliberately opt-in so CI does not require the local
private signing key or an unpublished binary artifact. It was explicitly executed locally.
Fixture lifecycle tests target macOS arm64; other platforms skip those fixtures and need their
own native packages/smoke. No full suite/build or bundles run. Actual new WKWebView UI/store,
live HTTPS publication/download, Windows installer/WebView2/native child behavior, forced
power-loss, real Twitch/TTS during install and long streaming/Dota/OBS regressions remain UAT.
