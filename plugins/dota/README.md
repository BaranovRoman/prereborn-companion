# Dota 2 replay plugin — iteration 4

This is an independent Rust process and signed package prototype. Built-in Dota remains the sole live runtime. Installing `dota2` defaults to disabled; Companion rejects enable, start and restore even if the registry is manually enabled. No catalog publication or live handover is included.

## Implemented

`companion-dota-domain` is the single source for existing broadcast-state rules, sound-event detector/catalog, GSI parser and match types. Built-in module paths are compatible re-export adapters. The executable uses those same rules on synthetic in-memory replay; it does not copy or alter gameplay algorithms.

IPC v1 / core API v1: send Hello, receive Ready (`dota2`, `0.1.0`, API 1), then State (`mode: replay_only`, `sideEffects: false`, empty live capabilities).

- `dota.replay`: typed `sequence`, `observedAtMs`, whitelisted `snapshot` and optional `context`. Successful analysis emits `dota.replay_analysis`, State and correlated Reply. Duplicate/out-of-order sequence, backwards time, oversized fields/collections and unknown fields are rejected without advancing memory.
- `dota.reset`: reset replay memory; Reply confirms no effects.
- Stop: Stopped and process exit. Unknown/live commands return correlated errors. Incompatible handshake and `--live` fail. No automatic restart or live consumer is added.

Example command args (wrapped in the existing protocol's Command frame):

```json
{"sequence":1,"observedAtMs":100,"snapshot":{"player":{"activity":"playing"},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":42},"hero":{"id":105},"items":{"slot0":{"name":"item_tango","charges":3}}}}
```

Only authorized replay fields are supported. Do not forward raw GSI with auth/provider/player-account fields. The full frame remains bounded by IPC's 64 KiB limit; only a verified `dota2` worker's `dota.replay` command may exceed the generic 512-byte command argument limit. Sequence/time are supplied by the replay producer, not by a second GSI listener.

## Prepared contracts, not live implementations

`LiveCoreRequest` describes candidate semantic OBS, sound, notification, history/transition, sync and overlay operations. No core handler dispatches them. OBS transport, sound playback/assets, SQLite/outbox/detector, backend/auth, actual game UI and overlay server remain built in. Future APIs need complete transactional payloads, exclusive ownership and durable idempotency before activation.

`ui/` builds independently, including `overlay/index.html`. The main page posts versioned `dota-replay-request` and expects parent-sourced `dota-replay-result`. No replay UI host is connected in Companion yet; the page explicitly reports this after timeout. The overlay is a preview renderer, not a replacement for the existing OBS URL. Native WKWebView/Windows iframe smoke is outstanding.

## Independent local preparation

From repository root (bash), build only this plugin and its development UI:

```bash
cargo build --manifest-path plugins/Cargo.toml -p companion-dota-plugin --offline
pnpm --filter @prereborn/companion exec tsc --noEmit -p ../../plugins/dota/ui/tsconfig.json
pnpm --filter @prereborn/companion exec vite build --mode development --minify false --config ../../plugins/dota/ui/vite.config.ts
python3 plugins/tools/package.py package \
  --binary plugins/target/debug/companion-dota-plugin \
  --ui plugins/dota/ui/dist --version 0.1.0 --platform macos --arch aarch64 \
  --output plugins/packages --key plugins/.signing/official.key \
  --manifest-template plugins/dota/manifest.json \
  --url https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/dota2-replay-v0.1.0
python3 plugins/tools/package.py catalog \
  --release plugins/packages/dota2-0.1.0-macos-aarch64.release.json \
  --output plugins/packages/dota-replay-catalog.json --key plugins/.signing/official.key
```

These commands do not publish. The manifest template is unsigned metadata; packaging inventories and signs all executable/UI files and archive. Local debug package/catalog are ignored. The regular embedded catalog is unchanged. Windows needs its own separately built `.exe`/UI package (`windows`, `x86_64`); no Windows artifact was built here. Release artifacts and native smoke belong to the pre-release stage, not these economical development checks.

## Focused verification

```bash
cargo test --manifest-path plugins/Cargo.toml -p companion-dota-domain --offline
cargo test --manifest-path plugins/Cargo.toml -p companion-dota-plugin --test ipc --offline
cargo test --manifest-path plugins/Cargo.toml -p companion-plugin-manager --offline
# Requires the plugin executable above; uses the existing host runtime and synthetic input:
cargo test --manifest-path apps/companion/src-tauri/Cargo.toml --lib core::plugin --offline
# Requires the locally prepared official signed package, otherwise intentionally ignored:
cargo test --manifest-path plugins/Cargo.toml -p companion-plugin-manager \
  official_dota_package_integrity_and_overlay_assets --offline -- --ignored
pnpm --filter @prereborn/companion exec vitest run src/plugins/dota-ui.test.ts src/plugins/ipc.test.ts src/plugin-lab/bridge.test.ts
```

Package tests install in temporary directories, verify signatures/contents, disabled persistence and preview overlay assets. Process tests use cleared environment and synthetic snapshots; they do not use live endpoints, user SQLite or accounts. Native executables have OS user rights: no OS sandbox is implied by these safeguards. See `docs/research/companion-dota-plugin-extraction.md` for remaining boundaries, rollback design and the next safe step.
