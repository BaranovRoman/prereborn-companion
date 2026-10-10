# Dota plugin extraction — iteration 4

## Question

How can Dota become independently packaged without interrupting the built-in integration or introducing a second owner of live effects?

## Current state

The built-in Dota runtime still starts through its existing one-time bootstrap. GSI fan-out, sound playback, OBS automation, match persistence/sync and overlay serving remain there. Plugin Runtime uses stdio IPC v1, signed Plugin Manager packages and core API v1. This iteration adds an independently built `dota2` **replay-only** worker; it does not switch live ownership.

## Findings

The following existing implementations now have one canonical source in `plugins/dota-domain`. Their old module paths re-export the shared implementations: broadcast-state calculation/resolution, positive sound-event detection with pending confirmations, sound/hero catalog, GSI parsing and local match models. The implementation files and generated catalog were moved unchanged. OBS scene-name lookup requires a core trait adapter because an external crate's type cannot have a host inherent implementation.

| Boundary | Implemented outside host | Still built in / future core capability |
|---|---|---|
| GSI and events | Typed, bounded, sanitized replay frames; original GSI parser, broadcast state and sound detector | Listener `127.0.0.1:3665`, ingestion/fan-out, draft reminders and live event ownership |
| Sounds and notifications | Catalog and detected sound IDs; no playback | Existing settings, assets under app-data `sounds`, playback/cooldowns/deduplication and notifications |
| OBS | Game-derived broadcast state and summary precedence | WebSocket/auth/config, scene mapping, scheduling, reconnect and post-stream fallback; future semantic scene requests |
| SQLite/history/outbox | Existing match types shared | Detector/store/watchdog, transactions, outbox and schema at existing `local-runtime.sqlite3`; future typed history/transition operations |
| Backend/auth | No account access or requests | Core authorization and existing `/stream/companion/sync/events`, `/account-settings`, `/sync/corrections` contracts; future constrained sync operations |
| Overlay/game UI | Independent development bundle and preview overlay assets | Actual game pages and renderer, server/events/layout and existing `http://127.0.0.1:3666/overlay` |
| Twitch/TTS | None | Core services and speech queue unchanged |

`contracts::LiveCoreRequest` records semantic operation candidates for these boundaries. These are **draft types**, not registered handlers or a complete live API. Transaction payloads, ownership epochs, idempotency keys, acknowledgements, recovery and migration sequencing must be specified before dispatch is allowed. No arbitrary SQL, backend URL or account secrets appear in that contract.

The external executable really handles handshake, commands, events, state, stop and structured command errors through the existing protocol. `dota.replay` analyzes in-memory snapshots in increasing sequence/time order. Hero changes reset detector history as in the built-in handler. `dota.reset` resets replay memory. No listener, network client, SQLite connection, filesystem writer or effect executor is present. This is a partial replay schema, not the complete live GSI payload; the core must explicitly project authorized fields before future forwarding.

The manager accepts exactly the reserved `dota2` package identity, defaults it to disabled, and rejects enable/start/restore **before** constructing a host, including an enabled registry edited externally. Other Dota-like IDs remain reserved. Built-in bootstrap is untouched. The local signed package/catalog is separate from the embedded Hello catalog and was not published. Installation only extracts/verifies files; it does not start Dota.

The independently built UI defines a parent-message replay bridge but has no diagnostic host route yet. Its timeout explicitly reports the missing host. The preview overlay is not the live OBS overlay. No claim of new WKWebView integration or real Dota gameplay is made.

Confirmed checks on macOS arm64: 78 original pure domain tests, 4 replay tests, 2 actual child-process IPC tests, 8 host plugin tests, 8 manager tests plus an explicitly requested signed-package integration, selected frontend bridge tests, TypeScript, independent development UI bundle and host Rust check. OBS mapping/post-stream checks are also targeted. Tests use temporary stores and synthetic GSI; they do not start live GSI/OBS or touch account data. Full suites, production build, Tauri bundles, old overlay and Silero builds were intentionally omitted. Windows and actual native WebView/live streaming smoke remain unverified.

## Options

1. Move all Dota services now: large persistence/network/UI blast radius and unsafe without Windows/live validation.
2. Share pure implementations and prepare a replay-only process/package: proves compilation, protocol and packaging while retaining one live owner. Chosen.
3. Copy algorithms into a new process: creates drift and duplicate maintenance. Rejected.

## Recommendation

Keep Dota activation blocked. Use the shared domain code from both runtimes and add only explicit capabilities as each subsystem can be validated. Native plugins retain OS user rights; signed packages and `env_clear` are not an OS sandbox. This worker does not receive account secrets through IPC, but no OS-level filesystem isolation is claimed.

## Follow-up

First add a debug-only replay host/UI route using isolated fixtures, compare built-in pure outputs with external outputs on anonymized replay traces, including reconnect/missing fields/hero changes/post-game. Keep all live effects blocked. Then define typed transaction and effect envelopes, session ownership epochs and idempotent acknowledgement/recovery before migrating the match detector or executing OBS/sound requests. SQLite and backend services should remain core adapters initially. A future exclusive switch must stop/reap the former consumer before creating the replacement; keep one GSI endpoint, pause/drain ingestion, establish a fresh owner epoch, and recover persisted work without repeating effects. Rollback must reverse ownership and reject stale requests, not run both consumers simultaneously.

Before any live switch: Windows GSI config/listener, OBS URL/scenes/reconnect, sound assets/audio, history/outbox/backend auth, Twitch/TTS during plugin crash/restart, overlay and install/update/rollback smoke. Do not add automatic Dota activation, new user data paths/schema, secret forwarding or change the application updater in this iteration.

## Sources

Repository source: `apps/companion/src-tauri/src/{dota,game_sounds,local_runtime,obs.rs,overlay.rs,state.rs,core/plugin_runtime.rs,core/plugin_manager.rs}`, `plugins/{protocol,manager,dota-domain,dota}` and focused tests. Source and real callers were read; Graphify tools were unavailable. No external factual sources were needed.
