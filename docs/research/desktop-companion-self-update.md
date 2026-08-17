# Desktop Companion self-update — discovery (WK-70)

## Mechanism

Tauri 2 ships an official first-party updater: [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/)
(Rust crate + `@tauri-apps/plugin-updater` JS bindings), paired with
`tauri-plugin-process` for restarting the app after an update installs.
This is the standard, maintained mechanism for the Tauri version already in
use here (`tauri = "2"`, see `Cargo.toml`) — no custom update platform is
needed or being built.

## How it works

1. `tauri.conf.json` gets a `plugins.updater` block: one or more manifest
   **endpoints** and a **public key** (ed25519). The client periodically (or
   on-demand) fetches the endpoint and compares the manifest's `version`
   against the running app.
2. The manifest (`latest.json`) is plain JSON: `version`, `notes`,
   `pub_date`, and a `platforms` map keyed by target triple
   (`windows-x86_64` for this app) with a `url` (the installer) and a
   `signature` (produced by signing the installer with the **private** half
   of the ed25519 keypair).
3. On update, the plugin downloads the installer from `url`, verifies the
   signature against the embedded `pubkey`, and only then runs it — a
   corrupted or unsigned download is never applied. On Windows/NSIS this
   means silently re-running the installer, which (per WK-59) already
   preserves user data because settings live in the OS app-data dir, not
   the install dir.

## Important distinction from WK-60

This ed25519 keypair is **not** the Windows Authenticode certificate WK-60
is about. It's generated locally and for free via
`pnpm --filter @prereborn/companion exec tauri signer generate` — there is
no vendor, no purchase, no owner sign-off needed to create it. It only
signs the updater *manifest*, so users still see the normal
unsigned-publisher SmartScreen warning on the installer itself until WK-60
lands separately. **This means WK-70 has no external blocker requiring a
purchase decision** — the only external dependency is a one-time manual
step (see "What's left" below), which is safe to hand to a human without
blocking the code from landing.

## Source of release metadata and artifacts

Already exists: `.github/workflows/windows-release.yml` publishes a
versioned NSIS installer to a GitHub Release per `prereborn-v*` tag (see
WK-58/WK-59 for the build/checksum/rollback story). The updater endpoint
this ticket adds is `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`
— GitHub's stable "latest release" alias — generated as a new CI artifact
in the same job, from the same build, so metadata can never drift from the
actual attached installer.

## Versioning

Reuses the existing single source of truth: the tag-derived version already
patched into `package.json` / `tauri.conf.json` / `Cargo.toml` by the
release workflow (WK-58). `latest.json`'s `version` field is generated from
the same `steps.version.outputs.version` in the same CI run, so it's
impossible for the manifest and the installer it points to to disagree.

## Signature requirements

- ed25519 keypair via `tauri signer generate`.
- Private key (+ optional password) stored as CI-only secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`),
  consumed only by the tag-triggered `release-windows` job — never checked
  into the repo, never exposed to the plain branch-push `build-windows` job.
- Public key committed in `tauri.conf.json` (`plugins.updater.pubkey`) —
  safe to publish by design, that's the point of asymmetric signing.
- `tauri build` only produces signed updater artifacts
  (`.sig` files) when `bundle.createUpdaterArtifacts` is active *and* the
  signing key is present; this repo enables it via a `--config` override
  only in the release job, gated on the secret existing, so the existing
  unsigned plain-build job and any release cut before the secret is added
  keep working exactly as before.

## UX

Implemented as a small dismissible banner (`components/UpdateBanner.tsx`)
surfaced from `HomePage`, covering the states the ticket calls out:
checking → available (shows version + notes) → downloading (progress) →
ready-to-restart → error → up-to-date (silent, no banner). Manual "Check
for updates" is available; there's no forced/silent auto-install — the
user always confirms before download and before restart.

## Rollback / failure behavior

- Signature or download failure: the plugin never applies the update: the
  installed version keeps running untouched, and the banner shows a plain
  error (reusing the same error-surfacing pattern as WK-59's backend
  version gate).
- Post-install regret: same rollback path as WK-59 — download and run an
  older `prereborn-v*` release's installer from GitHub Releases; user data
  survives because it was never touched by the installer either direction.

## What's not in scope here (per ticket)

A bespoke update platform, Steam distribution, silent/enterprise
deployment, and the Authenticode purchase decision (WK-60).

## What's left (external, one-time, not a purchase)

Someone with push access to this repo needs to, once:

1. Run `pnpm --filter @prereborn/companion exec tauri signer generate -w ~/.tauri/prereborn-companion.key`
   locally (keep the private key file **outside** the repo).
2. Add its contents as the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions
   secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if a password was set).
3. Replace the `REPLACE_WITH_GENERATED_PUBLIC_KEY` placeholder in
   `apps/companion/src-tauri/tauri.conf.json` with the printed public key.

Until step 3 is done the updater endpoint/pubkey are inert placeholders;
the app's "check for updates" simply reports no update available. This
implementation was deliberately kept working end-to-end without needing
this repo's actual production key so it doesn't block on a human being
available — see the PR for exact verification steps once the key exists.
