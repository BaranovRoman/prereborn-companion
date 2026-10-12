# Dota replay UI and ownership contracts — iteration 5

## Question

How can we inspect an external replay worker and prepare exclusive live ownership without executing any live effects or changing the working built-in Dota integration?

## Current state

Iteration 4 extracted canonical pure algorithms into `dota-domain`, retaining built-in re-export adapters, and provided a replay-only process. The signed installed `dota2` remains disabled and enable/start/restore are blocked. The normal application still owns live GSI, OBS, sound playback, SQLite/outbox, backend sync and overlay. No application settings, updater, data paths or algorithms changed here.

## Findings

### Diagnostic host

`--dota-replay-lab` is accepted only with Rust debug assertions. It uses the existing Plugin Lab's early setup return: diagnostic launch does **not** bootstrap live services. Normal application launch is unchanged. `PREREBORN_DOTA_BIN` and `PREREBORN_DOTA_UI` explicitly select local development artifacts. Start validates worker identity/version through the existing runtime. No child auto-start is performed by the page.

The independent UI is served by the existing bounded `plugin-ui` asset handler in `sandbox="allow-scripts"`, with opaque origin, no network and no iframe Tauri bootstrap key. A separate parent page owns Tauri invocations. Its source/version/UTF-8-size checked bridge accepts only replay snapshots; native commands independently allow `dota.replay` and `dota.reset` and validate the whitelist schema. Parent Start/Stop/Reset, iframe results/errors and a bounded-poll snapshot view expose events/state/process errors. Repeated Start while running fails instead of creating another child. Restart means Stop then Start; reset clears worker history. Release rejects the LabConfig/commands even with CLI flags; the Dota lab entry is also excluded from the default production frontend build. No signed catalog, user-facing plugin activation or second GSI listener was added.

### Replay parity

`plugins/dota/tests/fixtures/replay.json` contains synthetic anonymous frames: empty snapshot, draft, gameplay/hero selection, item charge-use sound, hero replacement, partial fields, post-game and session-ended summary. Actual child-process IPC Event, State and Reply are compared against direct calls to the canonical pure functions used by built-in adapters. The oracle does not call `Replay::apply`. Two fresh worker runs compare reconnect baselines. Duplicate/out-of-order sequence and backwards timestamps must return explicit errors; reset followed by a lower-charge snapshot must not synthesize a use event.

All tested outputs agree. This does not cover full live match detection, sound playback/asset cooldowns, OBS scheduling or persisted history. Reconnect represents a fresh replay process; future live restart must restore/reconcile state before effects. No real stream captures or game smoke were used.

### Exclusive ownership model (not connected to live runtime)

`ownership.rs` models `Active(Lease { owner, epoch }) → Draining(old,target) → Active(new)` and confirmed-crash `Vacant → Active(new)`. Initial conceptual owner is built-in, epoch 1. Entering Draining blocks all new effect admissions, including the old owner. Only trusted core proof that ingestion is paused, in-flight effects drained and old process fenced/reaped permits `confirm_fenced`; a plugin stop message alone is insufficient. Timeout/crash without fencing leaves ownership blocked. Every activation/recovery/rollback increments epoch with checked overflow. Stale requests and stale fence acknowledgements fail. There is no abort that reuses an old epoch. Rollback is a new fenced handover to BuiltIn. The application does not instantiate or use this model yet.

### Effect envelopes (not dispatched)

`effects.rs` defines bounded version-1 Request/Ack payloads for semantic OBS state, catalog sound ID, notification, match transition, history read, core-managed backend sync and overlay state. Request carries lease, correlation ID, stable idempotency key and deadline. Core-granted capabilities are checked separately from identity. Identifiers are ASCII/128 bytes, notification 512 bytes, history limit 100; new admission deadlines are at most 30 seconds ahead. Unknown operations/fields reject arbitrary SQL, HTTP and secret payloads. These types are proposed payloads inside IPC v1; they are not newly authorized commands. Legacy iteration-4 candidates remain explicitly labelled in `contracts.rs`.

A bounded 256-entry in-memory ledger model returns `duplicate: true` for repeated operation keys, including across ownership epochs, and rejects the same key with different payload. A duplicate never authorizes execution again, even if its status is Accepted. Saturation fails closed; entries are not silently evicted. Statuses are Accepted, Completed, Rejected, Unknown. Timeout/uncertain outcome becomes Unknown and retries query the existing result; they do not re-execute. Terminal acknowledgements cannot revert. Stale leases cannot admit or acknowledge. Correlation identifies this response; the stable operation key identifies the effect across retries/reconnect. A future core must assign/authenticate owner leases itself, persist epochs and the ledger atomically with SQLite/outbox transitions, and reconcile Unknown entries before recovery. This in-memory model alone does not provide durable exactly-once behavior.

### Validation limits

Only targeted ownership/effect tests, actual worker IPC/parity, Lab command/production guards and asset containment, source/version/bounds frontend tests, and TypeScript were run. Only the independent Dota UI development bundle was rebuilt. No full suites, production builds, Tauri bundles, native WebView, Windows/live Dota/OBS/Twitch/TTS smoke, Silero/old overlay rebuild or cache cleanup. Native iframe rendering remains unverified; automated bridge tests do not prove WKWebView behavior. Actual trusted fence enforcement, durable ledger, persistence payloads and effects are deliberately deferred.

## Options

1. Wire live execution now: unsafe without durable fencing/idempotency and native/game validation.
2. Connect isolated debug replay and prove pure parity; prepare unconnected ownership/effect models. Chosen.
3. Add another listener or duplicate game rules: risks duplicate processing and drift. Rejected.

## Recommendation

Keep external Dota replay-only and user activation blocked. Treat the new effects/ownership types as an executable contract draft, not a production handover API. No effect request is handled by the worker or core.

## Follow-up

Next expand anonymous parity traces to reconnect gaps, abilities/courier movement and real post-game timing. On an explicitly approved verification stage, run native sandbox UI smoke. Specify full match transaction/history/overlay payloads and durable operation-key retention/reconciliation, then implement read-only core adapters before any live switch. Existing match detector/store/watchdog, GSI fan-out, OBS scheduler, playback/deduplication, backend serialization/auth and game UI/overlay remain migration dependencies. Windows and real streaming regression smoke are required before activating an external live owner, with a tested fenced rollback to built-in.

## Sources

Repository: `src-tauri/src/plugin_lab.rs`, `core/plugin_runtime.rs`, `core/plugin_manager.rs`, vendored iframe bootstrap guard; `plugins/dota-domain`, `plugins/dota/tests/ipc.rs`, plugin and host UI bridge tests. Known files were read directly. No external sources were needed.
