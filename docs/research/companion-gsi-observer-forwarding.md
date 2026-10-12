# GSI observer forwarding — iteration 9

## Question

How can the only live GSI listener feed an external Dota analyzer without waiting for IPC, exposing account data, or enabling another live/effect owner?

## Current state

Branch `codex/plugin-runtime-prototype`, baseline `098c091`. Built-in Dota remains the only live owner. Installed Dota stays disabled and normal activation stays blocked. Detector/store/watchdog, GSI config/port, OBS/Twitch/TTS/backend/SQLite/overlay, paths/settings/identifier/updater and durable ownership are unchanged. No production migration or effect dispatcher is connected.

## Findings

### Ingest boundary and projection

The existing `server::process_gsi_body` invokes its original `dota::handle_gsi` first, then the optional observer hook. There is no second listener or change to `127.0.0.1:3665`. Without observer state the hook returns immediately. With explicit debug activation it reads only two context flags with `try_lock`, projects a whitelist and tries the mailbox lock. It never waits for the external process or IPC.

Only the existing typed ReplayGsi fields cross the boundary: player activity/team/KDA, map game state/match ID/custom-game name/winner, hero ID, item/ability name/cooldown/charges, and courier item signals. Auth/account IDs/names/provider metadata and undeclared fields are omitted before DTO deserialization. Courier keys are replaced with local ordinal aliases (the pure detector consumes their item names, not courier identities). Slot keys are bounded numeric slot/ability identifiers. Strings are <=128 bytes, maps <=32 slots, couriers <=8; the **serialized typed** snapshot must fit MAX_FRAME minus 1024 bytes reserved for context/envelope. Oversize/invalid projections are dropped and invalidate analysis history. The original JSON is never queued or persisted by this feature.

Core assigns a monotonic sequence, monotonic milliseconds since observer creation, and a diagnostic observer-session generation, plus session-ended/manual-summary flags. This generation is an analysis discontinuity marker, not a durable ownership epoch or live lease.

Projection review found a pre-existing replay DTO mismatch: real GSI/parser uses `customgamename`, while Map serialized `custom_game_name`. The DTO now serializes the real key and accepts the old spelling as an input alias. Tests check both spellings and raw/projected parser equivalence. The game parser/algorithms themselves are unchanged. Old binaries must be rebuilt for the added optional observer context field; an incompatible/rejecting worker fails closed instead of falling back to effects.

### Queue, reset and lifecycle

One dedicated worker owns one existing Plugin Runtime, with no host-state/TTS mutex held across IPC. The mailbox has capacity eight. Overflow discards the queued backlog, counts losses, increments generation and retains the newest frame. Lock contention or invalid projection also counts a dropped frame and increments generation. Older-generation queued/in-flight results are discarded. Before accepting a new-generation frame the worker sends `dota.reset` and resets its independent pure reference state. A >5-second ingest gap marks reconnect the same way; this is a diagnostic heuristic, not a change to legacy reconnect handling. Duplicate/backward sequences/timestamps are rejected and invalidate history.

Repeated Start is rejected while requested/running; one worker serializes all launches. Stop clears backlog, invalidates in-flight results and stops only the observer. Crash, failed launch, reply/write timeout or malformed IPC clears the queue and leaves Failed until an explicit Start. Restart resets replay state; no automatic relaunch loop runs. Tray Quit requests bounded observer shutdown. Native exit/Windows process cleanup remains unverified.

The existing Runtime previously timed reply reads but wrote synchronously into ChildStdin. A child that stopped reading could block before the reply timer started. Writes now use a one-slot writer channel and a two-second acknowledgement deadline; failure kills/reaps the child and releases the pipe writer. Reply waits retain their existing two-second deadline. These are separate deadlines, not a claimed two-second total lifecycle bound. All IPC waiting remains off the GSI producer. Existing Hello/Dota lifecycle/read-grant tests pass after this transport change; no new grants are added.

### Analysis, parity and diagnostic surface

The external process receives only reset/replay lifecycle commands and projected snapshots. It resolves broadcast state, hero identity, in-match/post-game and item/ability sound intents with the canonical dota-domain algorithms. It does not run the legacy match detector, watchdog, history writes or effect execution.

An independent reference invokes the same existing built-in pure broadcast/parser/sound functions directly, with their original hero-boundary reset. Every semantic ReplayResult field is compared with the real process response. Results never call OBS/audio/SQLite/backend/overlay. Matched bounded results are exposed in status; mismatching or arbitrary plugin payloads are withheld. Status exposes phase, received/sent/processed/lost, last processed sequence, resets, parity mismatch count/whitelisted mismatching field names, last analysis and fixed sanitized IPC error codes. Plugin error text/stderr/raw snapshots are not logged by the observer.

Debug activation (requires a freshly built independent plugin binary):

```bash
PREREBORN_DOTA_BIN="$PWD/plugins/target/debug/companion-dota-plugin" \
  pnpm --filter @prereborn/companion tauri dev -- --dota-gsi-observer
```

This uses normal built-in bootstrap, unlike the isolated `--dota-replay-lab`. Do not combine the two modes; isolated Lab takes precedence and does not start live ingest. Default/production startup creates no observer/process. No persistent setting or installed-plugin activation is changed.

Diagnostics are exposed through the existing main-window debug IPC and the `dota-observer-status` event; counters-only lines also appear on debug stderr. No new application UI page was added. In developer tools:

```javascript
await window.__TAURI_INTERNALS__.invoke('dota_observer_status');
await window.__TAURI_INTERNALS__.invoke('dota_observer_control', { start: false });
// Wait until status.phase === 'stopped', then explicitly restart:
await window.__TAURI_INTERNALS__.invoke('dota_observer_control', { start: true });
```

There is no iframe bridge or raw Tauri access granted to plugin UI. Status/control refuse when Observer is absent.

### Focused verification

- 10 observer tests passed: production/default gate, privacy/bounds/raw-parser projection equivalence, actual-process semantic parity (idle/draft/gameplay/hero/sounds/partial/post-game without player/context precedence/reset/restart), ability/courier signals, deterministic overflow/try-lock policy, actual-worker reset after a dropped frame, duplicate rejection/reset, repeat Start, failed launch/retry, crash/hang isolation, and intentionally incorrect parity/privacy response.
- 6 Runtime tests passed: existing Hello/Dota lifecycle, version/protocol/error/read-grant/core-state isolation plus a filled stdin pipe that times out and reaps a nonreading child.
- 5 targeted dota-domain replay tests passed, including sequence/time rejection, missing fields/privacy/bounds and the custom-game key/alias regression.
- Synthetic producer calls completed within the tests' one-second ceiling while another process hung/crashed. This verifies the nonwaiting observer boundary; it is not a measurement of full live HTTP/GSI pipeline latency. Overflow is tested deterministically at the mailbox; loss-to-reset semantic recovery is separately checked across the real worker/process boundary.
- Independent Dota debug executable built offline with existing dependencies; host library cargo check passed (four existing durable/facade dead-code warnings). No frontend changes or TypeScript/Vitest checks.
- No full suites, Tauri app/DMG/NSIS/production bundles, old overlay/Silero rebuild, cargo clean, dependency installation, native WebView, Windows or real game/listener smoke tests. Only synthetic snapshots and temporary fixture processes were exercised.

## Options

1. Await IPC inside the live handler: a hanging child can delay game/stream processing; rejected.
2. Second GSI listener/external live owner: conflicts with existing endpoint and ownership; rejected.
3. Optional bounded observer branch, explicit debug activation, isolated worker/reset after gaps: chosen.

## Recommendation

Keep this as observation only. Validate real GSI shapes/slot names, cadence/reconnect heuristics and native exit behavior before treating the diagnostics as production evidence. Do not enable installed Dota, ownership switching, SQL/effect dispatch or migrations based on these tests. No exactly-once claim is made for HTTP/OBS.

## Follow-up

Next safe slice: shadow the real pure match-detector decisions in the external process using typed read-only initial context and the existing algorithms; compare decisions and recovery/reconnect/post-game behavior without writing user history or invoking effects. Broadcast/sound-intent computation and GSI parsing already work externally; actual sounds/OBS transport, match persistence/outbox/backend sync and overlay execution still require explicit capability/lease fencing, full decision parity, indexed ledger admission/quotas, transaction integration and Windows/native smoke gates before any live handover.

## Sources

Actual repository source: `server/mod.rs`, `dota/mod.rs`, `core/{dota_observer,plugin_runtime}.rs`, `plugins/dota-domain/{contracts,replay,broadcast_state,events,gsi}.rs`, Dota worker and targeted tests. No external technical assumptions or dependencies were introduced.
