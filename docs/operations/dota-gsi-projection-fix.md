# Dota GSI projection correction after 0.5.94 smoke

## Scope and source

Implementation: `b8282fa` on `codex/plugin-runtime-prototype`.
No release, signing, package/catalog update, production migration, user DB access or main merge.
The user's pre-existing `.gitignore` changes are excluded.

The confirmed source defect was a shared slot/ability prefix check applied to every
inventory. Valid stash and courier item keys could reject a whole snapshot before cold
bootstrap. Whether this was the user's specific Windows failure still requires native
smoke; no raw snapshot from that failure was available.

## Correction

The existing projection is extracted into a local source module, still re-exported at
the same call site and used by both production admission and observer. It accepts:

- Hero inventory/backpack: `slot0..8`; stash: `stash0..5`.
- Dedicated `teleport0` and `neutral0` slots.
- Courier inventory: `item0..5`, retaining `slot0..5` replay compatibility.
- Abilities: the existing bounded `ability0..31` envelope.

Families are context-specific. Unknown prefixes, noncanonical numeric suffixes, negative,
overflowing and out-of-range indices fail closed. Empty object slots and `name=empty`
are accepted; nonobject slot signals are rejected. Existing collection, string and IPC
size bounds and metadata stripping remain. No shared game algorithm or IPC DTO changed.

## Diagnostic behavior

Native safety status includes `projectionRejected` and `lastProjectionError`. These hold
only a saturating counter and a static error code, never arbitrary keys, values, IDs or
snapshots. They survive successful fallback and repeated polling within the current app
process; they are not persisted across app restart. No per-frame logging was added.

The installed Dota card displays the last rejection independently of current runtime
error, including after successful BuiltIn fallback. An action success result is shown
only while its runtime and epoch still match current native state. Diagnostic history
does not change safety admission, Unknown/Draining behavior or activation gates.

## Local checks

- `cargo test --locked --manifest-path apps/companion/src-tauri/Cargo.toml --test dota_projection`:
  3 passed. Covers realistic full/empty inventories, metadata exclusion, strict rejection,
  existing bootstrap evidence, Blast Off detection, and stash/courier relocation parity.
- `cargo test --locked --manifest-path apps/companion/src-tauri/Cargo.toml --lib core::dota_live::`:
  33 passed, 1 pre-existing explicit eight-hour budget test ignored.
- `cargo test --locked --manifest-path apps/companion/src-tauri/Cargo.toml --lib core::dota_observer::`:
  17 passed, including the shared projection tests and real-process observer checks.
- Final targeted reruns: cold realistic-inventory IPC chain and fallback diagnostic
  persistence each passed after the last projection validation change.
- `pnpm --filter @prereborn/companion exec vitest run src/pages/PluginsPage.test.tsx src/plugins/api.test.ts`:
  22 passed, including successful-fallback polling and obsolete Enable result removal.
- `pnpm --filter @prereborn/companion exec tsc --noEmit`: passed.
- Staged and working-tree `git diff --check`: passed.

The cold-chain test uses a temporary real schema and the existing signed-fixture manager,
production queue, lifecycle, durable binding and actual Dota worker. A snapshot with
`matchid=0`, empty stash/courier slots and Techies creates one session, returns one Blast
Off sound intent over real IPC on cooldown transition, and returns to BuiltIn. Repeated
frames preserve identity and do not repeat the sound. The dispatch callback records
intents; it does not play native audio or execute OBS/overlay effects.

## Windows validation and remaining acceptance

Unsigned workflow validation uses the existing 0.5.94 metadata override solely for CI;
it does not replace the published release. The native standalone projection test compiles
the exact production source, avoiding the already documented Windows Tauri combined
lib-test loader limitation. Production runtime source and worker/package contracts remain
unchanged apart from the projection and diagnostic status described above.

Windows CI: [38681153946](https://github.com/BaranovRoman/prereborn-companion/actions/runs/38681153946),
**success**, exact source `b8282faea6e87c1f9d1ac613f3695cdf5304faf1`.
Unsigned `build-windows` completed in 5m22s; release and Dota candidate jobs were skipped.

- Exact production projection target: 3 passed.
- UI/invoke: 22 passed.
- Windows supervisor: 5 passed, 3 explicitly ignored probes (not claimed tested).
- Real Windows Credential Manager smoke: passed.
- Unsigned NSIS build and metadata/inventory verifier: passed, BuiltIn remains embedded.
- Packaged GSI/overlay smoke: passed (HTTP/SSE, Draft/Gameplay, second-instance isolation).
- Checksums and unsigned Actions artifact upload: passed. No updater manifest was published.

The worker/IPC cold-chain tests above ran on macOS with temporary SQLite. They are not
reported as Windows cold-chain tests: the native standalone target covers projection,
while combined Tauri lib-tests retain their existing Windows loader limitation.

Real user acceptance remains: explicit cold activation, visible awaiting-session state,
real bot-match GSI, confirmed session binding, Techies Blast Off through WebView audio,
and safe BuiltIn fallback. Existing Dota 0.1.0 is not updated by this fix. Do not describe
unit/IPC/runner results as proof of native game/audio/OBS smoke on the user's PC.
