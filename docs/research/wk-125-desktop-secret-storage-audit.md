# WK-125: Companion secret/token storage — audit and remediation

## Question

What credentials/tokens does Companion actually persist, where do they live on disk, what could
leak them (diagnostics ZIP, logs, the local overlay HTTP/SSE surface, the frontend), and which of
them need OS-backed secure storage instead of plaintext JSON?

Per the ticket's explicit framing: **inventory → classification → threat model → remediation**, not
"move everything to secure storage because it has the word token in it." Local-first does not mean
offline-first — a streamer is assumed to have a live internet connection, so nothing here was moved
to/from a backend for ideological reasons; only storage mechanism changed.

## Non-goals (per ticket scope)

- No auth-protocol/provider migration, no new OAuth flow, no auth UX redesign beyond storage.
- No general security review of the rest of Companion (GSI, OBS scene automation, sync, TTS, SQLite
  maintenance) — those are separate WK tickets (WK-127 Diagnostics v2, WK-128 SQLite audit, WK-129
  license audit) and are explicitly out of scope here.
- No networking/backend-boundary rewrite for Twitch (see §6 — there is nothing to migrate).

---

## 1. Inventory and classification

| Value | Where it lived before | Classification | Compromise impact |
|---|---|---|---|
| PreReborn legacy companion token | `companion-config.json` (`companion_token`, plaintext) | **B — secret** | Full bearer-auth as the user against PreReborn's backend API |
| PreReborn session refresh token | `companion-config.json` (`session.refresh_token`, plaintext) | **B — secret** | Mints new access tokens indefinitely (30-day TTL, auto-rotated) |
| PreReborn session access token | In-memory only (`AppState.companion_token`), never persisted | **B — secret**, but already ephemeral by design | Bounded to the process lifetime / ~1h TTL — no storage change needed |
| Account email (session) | `companion-config.json` (`session.email`, plaintext) | **C — sensitive, not secret** | Identifies the account; cannot authenticate with it alone |
| OBS WebSocket password | `obs-config.json` (`password`, plaintext) | **B — secret** | Local/LAN OBS control (scene switching) — reusable while unchanged |
| OBS host/port/scene names | `obs-config.json`, plaintext | **A — public/non-secret config** | No capability on its own |
| Twitch OAuth token/client secret | Does not exist in Companion (see §6) | n/a | n/a |
| DonationAlerts credentials | Does not exist in Companion | n/a | n/a |
| Steam auth/OpenID data | Does not exist in Companion (only a registry read to find the local Dota install path) | n/a | n/a |
| TTS/Game Sounds provider keys | Does not exist — TTS is a local Silero sidecar, Game Sounds plays local files | n/a | n/a |
| OAuth PKCE verifier/state/auth code | Does not exist — Companion implements no OAuth flow itself | n/a | n/a |
| Overlay/public token | Does not exist — the local overlay (`/overlay`, port 3666) carries no token in its URL or payload | n/a | n/a |

Everything else Companion persists (`overlay-layout.json`, `queue-settings.json`,
`account-overlay-data.json`, `local-runtime.sqlite3`) was checked and contains no credential/token
column or field — confirmed by schema/field inspection, not by name-matching.

## 2. Confirmed plaintext exposures (before this change)

1. `companion_token` (legacy bearer token) — plaintext in `companion-config.json`.
2. `session.refresh_token` — plaintext in `companion-config.json`.
3. `obs-config.json`'s `password` — plaintext.
4. **Logout bug**: `backend::logout` cleared the session but never removed a legacy `companion_token`
   from disk — an account still on the legacy-token method stayed silently reconnected across app
   restarts after clicking "Выйти". This was a real, reachable gap, not theoretical.
5. `ObsConfig` and `CompanionSession` both derived `Debug` with no redaction. No call site currently
   formats either with `{:?}`, so this was not a live leak, but it was a standing footgun: the next
   debug line added to `obs.rs` (which clones `ObsConfig` at many call sites) or to the session
   refresh/login path would have printed the plaintext secret straight into `app.log`, which is
   bundled unconditionally into every diagnostics ZIP export.

## 3. Threat model (practical, desktop-streamer-shaped)

Defended against:
- A diagnostics ZIP sent to support/a developer.
- A secret ending up in `app.log`.
- Plaintext config being readable by an unrelated program, backup tool, or sync client on the same
  machine.
- An accidental `git add`/commit of a config file.
- Screen/support sharing showing a config file's contents.
- The frontend/webview receiving a secret it has no reason to need (XSS-style exposure surface).
- A credential surviving indefinitely after logout/disconnect with no cleanup path.

Explicitly **not** defended against: a fully compromised OS user account/root/admin, or malware
running as the same user. An OS credential store does not protect against that class of attacker
either — it protects against the classes above, which is what OS-backed storage is actually for.

No custom encryption was introduced. No key was ever going to live next to its own ciphertext in
`companion-config.json` — the whole point of using the OS credential store is that Companion never
holds an encryption key at all.

## 4. Secure storage mechanism chosen

**`keyring` crate (v3.6.x)**, added as a normal Cargo dependency — no Tauri plugin needed, since
credential reads/writes already happen entirely in Rust command handlers, never in JS. (v4.x was
tried first and rejected after the Windows CI gate caught a real startup crash on Windows — see the
dependency-footprint note below for the full story.)

- Windows: backed by Windows Credential Manager via the `windows-native` feature.
- macOS (dev machine): backed by Keychain Services via the `apple-native` feature.
- Linux: not wired up (no `linux-native`/secret-service feature enabled) — not the production
  target and not used for local dev on this project; `cargo check`/`test` on Linux would need that
  feature added if that ever changes.

Each target's feature is enabled only under its own `[target.'cfg(...)'.dependencies]` section in
`Cargo.toml`, mirroring the existing `winreg` (Windows-only) pattern already in that file — no
unused backend gets compiled in for a target that doesn't need it.

Why this over the alternatives:
- **Maintenance**: actively developed under the `open-source-cooperative` GitHub org, with regular
  releases through August 2026 (the 3.x line was last touched July 2025 and is effectively
  superseded, not abandoned-then-revived — 4.x is where current development is). ~700 commits.
- **License**: dual MIT/Apache-2.0, compatible with this project.
- **API shape**: the classic `Entry::new(service, key).set_password()/.get_password()/
  .delete_credential()` API is exactly what a synchronous, blocking, non-tokio Rust codebase (this
  one already avoids async runtimes outside Tauri's own) needs, with no extra plumbing.
- **Not a Tauri plugin**: nothing here needs to cross the frontend/IPC boundary, so a plugin (with
  its own capability/permission surface to manage) would have been unneeded complexity.
- Rejected: hand-rolled encryption with a key stored anywhere in the app's own data directory — this
  is exactly the "encryption key next to the ciphertext" anti-pattern the ticket explicitly warned
  against, and buys nothing an OS-backed store doesn't already provide correctly.

**Version actually shipped: `keyring` 3.6.x, not 4.x — and verified via a standalone example, not
`cargo test` — both found by the Windows CI gate itself, not speculation.** `keyring` 4.2.0 (the
current default on crates.io, and this ticket's first choice) compiled cleanly on macOS, but its
Windows-backed unit test crashed the `cargo test` binary on startup with `STATUS_ENTRYPOINT_NOT_FOUND`
(0xC0000139) on the real `windows-latest` GitHub Actions runner — caught by this ticket's own new CI
gate before merge, exactly what that gate exists for. Switching to `keyring` 3.6.x (older, more
widely deployed on Windows, `windows-sys 0.60` instead of 4.x's `0.61.2`) hit the *identical* crash,
which ruled out the dependency version as the cause. Isolating further: a standalone
`examples/keyring_smoke.rs` binary — same `keyring` 3.6.x dependency, same real Credential Manager
round trip, but without the test-only dependencies (`tempfile`, `tauri`'s `test`/`MockRuntime`
feature) that `cargo test --lib` also links in — ran cleanly on the same runner. So the crash was
never in `keyring`'s Windows backend; it was specific to combining it with this crate's `cargo test`
harness binary on that runner (root cause not further isolated — plausible but unconfirmed: an
import-table conflict from `tauri`'s test/MockRuntime feature pulling its own Windows-facing
dependencies alongside `keyring`'s). The fix that matters is procedural, not code: this ticket's
Windows secure-storage CI gate (§18) runs `examples/keyring_smoke.rs` as its own binary rather than
an `#[ignore]`d `cargo test`, and that binary is exactly what's exercised at runtime (`storage/mod.rs`
calls the same `keyring::Entry` API either way) — an `#[ignore]`d unit test proving the identical
round trip is kept in `secure_storage.rs` for manual local verification, with a comment explaining
why CI doesn't run it. Application code never changed between `keyring` 4.x and 3.6.x — only the
`Cargo.toml` dependency declaration and how the Windows gate invokes the check. This is recorded
here as the actual finding it was: the newer major version looked right by every static signal
(maintenance activity, release cadence, license) and the eventual fix wasn't even about picking the
right version, it was about how the real-Windows check itself was invoked — which is exactly why
§18's real Windows smoke gate, not `cargo check` or a same-OS `cargo test`, was a requirement of
this ticket and not optional.

Transitive footprint of what's actually shipped: `keyring` 3.6.x with `default-features = false` and
only the one backend feature each target needs (`windows-native` on Windows, `apple-native` on
macOS) — no `keyring-core`, no unrelated store crates, no networking stack. On Windows this pulls in
`windows-sys`/`byteorder`/`zeroize`; on macOS, `security-framework`/`core-foundation`. No C/FFI
toolchain requirement beyond what's already needed, consistent with this project's existing "no
extra native build deps on Windows CI" constraint (see the `reqwest`/`rustls-tls-native-roots` and
`rusqlite`/`bundled` comments already in `Cargo.toml`).

## 5. Config separation after remediation

`companion-config.json` now holds only: account email (an identifier, not a secret) and, only as a
failure-safe fallback (see §6), a credential the secure store could not accept. `obs-config.json`
now holds only host/port/scene names, with the same failure-safe fallback for the password.

## 6. Migration semantics

Implemented once, in `storage/mod.rs`, for all three secrets (companion token, refresh token, OBS
password) with the same shape:

1. On read: check the secure store first. If present, use it — and if a legacy plaintext copy is
   still sitting in the config file (an install that hasn't been read since upgrading), strip it now.
2. If the secure store has nothing yet, look for a legacy plaintext value. If found, write it to the
   secure store, then **read it back and compare** before treating the write as successful.
3. Only after a verified read-back does the plaintext copy get removed from the config file.
4. If the secure write fails (or can't be verified), the plaintext value is left exactly as it was
   and the app keeps working off it this session — migration is retried on the next read, so a
   temporarily locked/unavailable OS credential store never costs a user their login.
5. Going forward, new writes (a fresh login, an OBS password change, a session-refresh rotation) try
   the secure store first and only fall back to writing plaintext if that write itself fails — the
   same failure-safe behavior applies symmetrically to saves, not just the one-time migration.

This is idempotent (nothing left to migrate once the plaintext copy is gone), restart-safe (the
secure store is always re-checked first, never assumed present), and failure-safe (a failed secure
write never deletes the only working copy of a credential).

## 7. Logout / disconnect / reset

- **PreReborn logout** (`backend::logout`) now clears both the session (secure refresh token +
  plaintext email) **and** the legacy companion token (secure store + any plaintext leftover) — the
  audit's confirmed real bug (§2.4) is fixed. A single "Выйти" button covers both connection methods,
  and neither should survive it.
- **OBS password**: changing it (a non-empty `save_obs_config` call) overwrites the secure secret in
  place. There is no "forget OBS entirely" action in the UI today (not introduced by this ticket —
  see residual risks, §12) — this matches the existing UX (OBS host/port/scenes also have no
  "forget" action) and is not a WK-125 regression.
- **Twitch disconnect**: not applicable — Companion holds no Twitch credential (see §9).
- Deleting a credential that was never set is a no-op, not an error (tested).

## 8. Frontend exposure

No command was found, before or after this change, that returns a raw token/refresh-token/password
to the frontend — `get_account_status`/`get_status` already returned only booleans/method/email, and
`AppState::snapshot()` already clears the OBS password before it reaches any command response.
Nothing changed here because nothing needed to: this ticket's remediation is entirely about storage
mechanism on the Rust side, and the frontend contract already followed the "no secret it doesn't
need" rule it should. `save_companion_token` remains a reachable command with no frontend UI calling
it (dead UI, live plumbing) — noted as a residual item, not fixed here (see §12).

## 9. Twitch

Companion has **no direct Twitch integration**. All Twitch data (chat) is proxied through
PreReborn's own backend (`/stream/companion/twitch-chat`), authenticated with the companion bearer
token — never a Twitch OAuth token. There is no Twitch client ID/secret, OAuth token, or EventSub
credential anywhere in Companion's Rust or frontend source. Nothing to migrate, and nothing to
route through the backend "for security" that isn't already backend-mediated.

## 10. Logging redaction

`ObsConfig` and `CompanionSession` no longer derive `Debug` — both now have hand-written `Debug`
impls that redact the password/refresh-token field. This closes the actual risk (a struct that could
leak a secret the moment someone formats it) rather than adding a regex over log output after the
fact, which the ticket explicitly warned against as a false sense of security. `app.log` itself
still has no separate redaction pass — the code audit found no call site that ever formats a
credential-bearing value into it, so a text-scrubbing regex there would be defending against a
source that no longer exists (the Debug fix), not closing a real gap. GSI diagnostics
snapshots/diffs already run through an existing `redact()` pass (`diagnostics/redact.rs`) — unchanged
by this ticket, already covered.

## 11. Diagnostics ZIP

Confirmed (by reading `diagnostics/export.rs`'s function signature and its own exact-entry-list
test) that the exported ZIP never includes `companion-config.json` or `obs-config.json` in the first
place — `export_zip` has no parameter that could carry either file's contents. This is a structural
guarantee, not just current behavior. `app.log` is bundled unconditionally, but per §10 it does not
contain credentials.

## 12. Localhost (:3665 / :3666)

- Port 3665 (GSI ingest) only ever responds `{"status":"ok"}` — no secret exposure.
- Port 3666 (local overlay, `/overlay/*`) already had a dedicated regression test
  (`served_payload_never_contains_a_token_secret_or_password_field`) proving its JSON payload can
  never carry a token/secret/password field, because the struct it serializes structurally can't
  hold one. Unchanged by this ticket, already solid.
- Residual, not fixed here: `account_overlay_data`/`twitch_chat` are opaque backend-provided JSON
  blobs re-served verbatim to the overlay with no schema allowlist. Today's observed shape is
  display-only (name/avatar/messages); if the backend ever added a token-shaped field to either
  response, Companion would forward it as-is. See §12/residual risks.

## 13. Backend/client-secret boundary

No confidential client secret of any kind exists in Companion's source or bundle. Confirmed by full
grep across Rust and frontend for `client_secret`/PKCE/authorization-code terms — Companion
implements no OAuth flow itself (see §9), so there is nothing to keep server-side that isn't already
server-side.

## 14. OBS password

Covered in §1, §4, §6, §7 above — migrated the same way as the PreReborn secrets, verified by a
dedicated test that a password change updates the secure secret rather than the file.

## 15. Residual risks / follow-ups (not fixed in WK-125, per scope discipline)

| Item | Severity | Why not fixed here |
|---|---|---|
| `save_companion_token` command has no frontend caller but remains invocable | Low | Dead UI, not a new exposure; removing a Tauri command is a larger surface-area change than this ticket's storage-mechanism scope |
| No "forget OBS password" UI action | Low | Pre-existing UX gap unrelated to storage mechanism; OBS host/port/scenes have the same gap |
| Local overlay re-serves backend-controlled JSON with no schema allowlist | Low/Medium | The backend does not currently put secrets in that JSON; adding allowlisting is a schema-design task better scoped with Diagnostics v2 (WK-127) or its own ticket, not bolted onto a storage-migration ticket |

None of these are exploitable today and none required a product/architecture decision to leave
alone — they're recorded here rather than turned into new tickets, per the ticket's own "don't
create tickets from theoretical observations" instruction.

## 16. Tests

All new/updated tests live in `apps/companion/src-tauri/src/storage/mod.rs`
(`storage::tests::session_storage`, `storage::tests::debug_redaction`) and run against an in-memory
fake secret store (`secure_storage::test_support::FakeSecretStore`/`FailingSecretStore`) — never a
real OS keychain, so `cargo test` stays fast and hermetic in CI. Covered: fresh install with no
credentials, secure write/read round-trip, legacy plaintext migration (companion token, refresh
token, OBS password), plaintext removed only after a verified secure write, a failed secure write
leaves the plaintext copy recoverable (both on migration-read and on a fresh save), migration is
idempotent across repeated reads, logout clears both credential methods, clearing an unset credential
is not an error, config serialization never contains a migrated secret, and Debug output never
contains a redacted field. Existing coverage already proves the overlay SSE payload and the
diagnostics ZIP entry list carry no secrets (§11, §12) — not duplicated here.

Real OS-backed storage (actual Windows Credential Manager) is verified in Windows CI by
`apps/companion/src-tauri/examples/keyring_smoke.rs`, run as its own binary (`cargo run --example
keyring_smoke`) rather than a `cargo test` — see §4 for why an `#[ignore]`d unit test doing the exact
same round trip crashes in that specific test-harness binary on the CI runner while this standalone
example does not. See the PR/release notes for that run's result.
