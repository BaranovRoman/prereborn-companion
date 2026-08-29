# WK-122: Runtime Regression + Dota UX Convergence

Status: IN PROGRESS (living document, updated as the slice lands)
Branch: `feat/wk-122-runtime-ux-convergence`
Baseline: `prereborn-v0.5.44` (companion app version `0.4.0`)

## 0. Scope

One corrective/product slice for `apps/companion`: (1) a P0 forensic audit and fix for a real
production report of a lost match, (2) a final design-system rule separating global (old-Dota)
navigation from workspace (modern-Dota) UI, and (3) closing several WK-121 follow-ups (Companion
Token UX, Heroes search/favorites/detail, Items catalog, Оформление editor/renderer parity, Chat
layout).

## 1. P0 — missing match forensic audit

### 1.1 Report

- Companion 0.5.43, a real match played.
- OBS scene automation worked correctly throughout (states visibly changed: Между матчами → Драфт →
  Игра → ...).
- The match never appeared in Companion's history.
- Explicitly not to be assumed related to the legacy `prereborn.ru` Browser Source URL — overlay is
  a downstream consumer, not the thing that creates/finalizes matches.

### 1.2 Pipeline traced

`GSI → local_runtime::handle_gsi → LocalSession lookup → detector::handle_snapshot → LocalMatch
create/transition/finalize → SQLite → sync_outbox → (separately) history/summary read`.

Read in full: `local_runtime/mod.rs`, `local_runtime/lifecycle.rs`, `local_runtime/detector.rs`,
`local_runtime/store.rs`, `obs.rs` (full OBS-websocket layer), `state.rs`.

Key finding, confirmed by `local_runtime::mod.rs`'s own doc comment (WK-113): **LocalSession
creation is exclusively OBS-driven**. `handle_gsi` early-returns on every GSI tick when
`store::find_open_session` finds nothing open — this is an intentional contract (a bare GSI tick
must never lazily create a session, or session creation would bypass the durable
`session_started` sync-outbox enqueue). This means: if no LocalSession is open for the whole
match, **nothing is silently wrong at the detector/store layer** — there is nothing to attach the
match to at all, and every GSI tick is correctly, silently ignored. The real question WK-122 had to
answer was: why would no LocalSession be open for a real, live-streamed match?

### 1.3 Root cause

`obs.rs` has **two structurally independent OBS-websocket connections**:

1. **Scene automation** (`schedule_switch`/`switch_scene`) — a brand-new, short-lived connection
   opened fresh for every single scene switch, driven by GSI (`handle_gsi` in obs.rs, not to be
   confused with `local_runtime::handle_gsi`). This is what the user observed "working correctly".
2. **The stream-state watcher** (`start_stream_state_watcher` → `run_stream_state_watcher_once`) —
   a single **persistent** connection, opened once and kept open for the app's lifetime, subscribed
   to OBS's `Outputs` event category so it can react to `StreamStateChanged`. This is the **only**
   source of "is OBS streaming" truth for `local_runtime::lifecycle::on_obs_streaming_known`, which
   is the only thing that ever opens/continues/ends a LocalSession.

Before this fix, the watcher's persistent socket was opened with **no read timeout**
(`open(config, None, Some(EVENT_SUBSCRIPTION_OUTPUTS))`). Its event loop blocked on
`socket.read()` indefinitely, waiting for either a message or the OS reporting the connection
closed. A **half-open TCP connection** — one that will never again produce a byte in either
direction, but also never delivers a clean FIN/RST to the socket — leaves that blocking read stuck
**forever**. Realistic real-world triggers on a long-running desktop app: the machine sleeping and
waking (very common between/around Dota matches), a network interface change (Wi-Fi
reconnect, VPN toggle), or OBS itself crashing/being force-killed without a clean WebSocket close.

Once that happens:
- `on_obs_streaming_known` is never called again — `obs_streaming` is frozen at whatever it was
  last, and the local session lifecycle (`local_runtime::lifecycle::reconcile`) never re-runs.
- No log line is produced. This is not a returned error — the watcher thread is simply parked
  inside a syscall. `run_stream_state_watcher_once`'s only error-logging path
  (`start_stream_state_watcher`'s `if let Err(error) = ...`) never fires, because the function
  never returns at all.
- Scene automation (item 1 above) is completely unaffected, because every switch opens a fresh
  TCP connection — it has no relationship to the zombied watcher socket's state. This is exactly
  why the user saw scenes changing correctly for the whole match while nothing was tracked.

This is a distinct, later bug from the WK-116 P0 fix already on record in this file's history
(`obs.rs`'s doc comment on `start_stream_state_watcher`): WK-116 fixed the watcher never
*attempting* to connect at all when `obs_config.enabled == false`. This ticket's bug is the watcher
connecting successfully, observing the correct truth once, and then silently going deaf partway
through a session for an unrelated reason (a dead/half-open connection, not a config gate).

### 1.4 Fix

`apps/companion/src-tauri/src/obs.rs`:

- The watcher's socket now uses a bounded read timeout (`WATCHER_READ_TIMEOUT = 20s`) instead of
  `None`.
- The read loop's logic was extracted into a pure, `AppHandle`-free function
  (`watch_stream_state_once`) that reports every observed streaming-truth change through a
  callback, tagged with its source (`Initial` / `Event` / `Heartbeat`). `run_stream_state_watcher_once`
  is now a thin wrapper that feeds `local_runtime::lifecycle::on_obs_streaming_known` and adds one
  bounded diagnostic log line.
- On a read timeout (no event arrived within the window), the watcher now **actively re-probes**
  `GetStreamStatus` on the very same connection:
  - A successful response both self-heals a missed `StreamStateChanged` event and proves the
    connection is genuinely still alive.
  - A failure (the request write or its response read also times out/errors) surfaces as a real
    `Err`, which the existing outer retry loop (capped exponential backoff, already present)
    reconnects from.
  - This bounds the worst-case staleness window to about one `WATCHER_READ_TIMEOUT` instead of
    leaving it unbounded.
- A new small helper, `request_on_event_socket`, replaces bare `request()` for anything issued on
  this persistent, event-subscribed connection: unlike the short-lived scene-switch connections,
  this socket can have a genuine `StreamStateChanged` event arrive interleaved with a request's own
  response, which the original `request()` (a single blind read) would have misread as the
  response itself.

### 1.5 Diagnostics

Added `obs_streaming_confirmed_at` (RFC3339 timestamp), threaded through `InnerState` →
`StatusSnapshot` and `local_runtime::lifecycle::LifecycleStatus`, updated every time
`on_obs_streaming_known` fires (event, initial fetch, or heartbeat). If a future report repeats,
this timestamp answers directly whether the watcher was actually alive during the match, without
needing to reproduce the bug. A bounded log line (`"heartbeat corrected a drifted streaming
truth..."`) fires only when a heartbeat re-probe finds the truth actually changed since last known
— never on an ordinary healthy tick — so a multi-hour stream doesn't spam `app.log`.

### 1.6 Regression coverage

`apps/companion/src-tauri/src/obs.rs`, `mod stream_state_watcher_p0_regression`: drives the real
`watch_stream_state_once` function against a fake OBS-websocket server over an actual loopback TCP
socket (not a hand-built snapshot or a mocked `AppHandle` — this bug lives in the socket-handling
layer itself, which a pure-decision unit test cannot reach).

- `a_connection_that_stops_responding_entirely_surfaces_as_an_error_within_one_read_timeout_not_never`
  — the fake server accepts, completes the handshake, answers the first `GetStreamStatus`, then
  goes fully silent (never reads, writes, or closes again). Asserts the watcher function returns an
  `Err` within ~2s (using a 150ms configured timeout for a fast test) instead of hanging — this is
  the direct regression test for the root cause: before the fix, this exact scenario would hang the
  calling thread forever.
- `heartbeat_reprobe_self_heals_a_missed_stream_state_change_with_no_event_ever_sent` — the fake
  server never sends a single `StreamStateChanged` event, only answers two `GetStreamStatus`
  requests (initial fetch = true, then the client's own heartbeat re-probe = false). Asserts the
  observed value transitions to `false` via the `Heartbeat` source specifically, proving the
  self-heal path (not a lucky event delivery) is what caught it.

Both tests run in well under a second (no real 20s waits) because the production read-timeout
constant is now a parameter, with the real 20s value only used by the actual
`start_stream_state_watcher` call site.

### 1.7 What this does not change

- Session lifecycle decisions (`lifecycle::decide`), match detection (`detector::handle_snapshot`),
  and finalization/sync (`store.rs`, `sync.rs`) were all read in full during this audit and found
  correct and already well-covered by existing tests (WK-111/112/113/116) — the bug was entirely in
  the OBS-websocket transport layer feeding them the streaming truth, not in the decision logic
  itself.
- Scene automation itself (`schedule_switch`/`switch_scene`) is untouched — it was never the
  problem.
- The legacy `prereborn.ru` Browser Source question (§20 of the original brief) is unrelated to
  this root cause and is handled separately below.

## 2. Design rule (in progress)

_To be filled in as this section of the slice lands._

## 3. Remaining sections

Auth/Companion Token, Heroes, Items catalog, Оформление editor/renderer parity, Chat, Home,
Settings, performance, tests, visual QA — tracked in Weeek WK-122 (task id 123) and filled in here
as each lands.
