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

Global header (`AppShell.tsx`/`App.css`'s `.app-header*` rules) already received a metal-plate/
red-rivet treatment in WK-115 — kept as the baseline, not rebuilt from scratch. Inner workspace tabs
(Оформление's Между матчами/Драфт/Игра/Итоги) already read as centered, uppercase, underline-active
modern-Dota tabs. Remaining control-primitive work: Radio (below) closed the last native-browser
control gap found; Select/Input/Button/Slider were already de-natived in WK-121's `ui/` primitives
and re-verified via screenshot during this slice.

## 3. Companion Token → real desktop auth (§7)

**Decision: email/password login, reusing the web cabinet's existing session system verbatim — no
new auth scheme, no new backend auth surface.**

The backend already has everything needed for a proper session: `/stream/auth/login` (email +
password → 1h JWT access token + 30-day rotating refresh token, `stream-user-service.ts`),
`/refresh`, `/logout`. Companion becomes a second client of that exact system, the same way a web
SPA would store a refresh token — not a parallel or novel mechanism.

- **Backend** (`authenticate-companion-token.ts`): a new `authenticateCompanionSession` middleware
  tries JWT verification first, falls through unchanged to the existing hash-lookup for anything
  that isn't a valid JWT (the legacy token's shape never parses as one). `routes/stream/companion.ts`
  now uses this instead of the old middleware directly — zero controller changes, and every
  existing token-authenticated install keeps working verbatim, permanently, with no forced
  migration.
- **Rust** (`backend/mod.rs`, `storage/mod.rs`): `login`/`logout`/`account_status`. A single
  persistent background thread (`start_session_refresher`, ~30min cadence, comfortably inside the
  1h access-token TTL) keeps `AppState.companion_token` populated from the stored refresh token —
  every one of the ~10 existing outgoing-request call sites in this file keeps reading that same
  field completely unchanged, oblivious to whether it holds a legacy static secret or a rotating
  session access token. The session (email + refresh token) is stored alongside the legacy token in
  the same `companion-config.json`, without either one disturbing the other.
- **Frontend**: `AccountForm.tsx` replaces `CompanionTokenForm.tsx` everywhere (Settings → Аккаунт,
  and compact/embedded in Home's first-run checklist) — email/password fields when disconnected, a
  connected view (email + "Выйти") when logged in via session, a plain "Подключено" + upgrade
  prompt for a still-working legacy-token install. The raw token/refresh-token/password is never
  fetched, stored in component state longer than the request, or rendered anywhere.
- **Diagnostics**: `DeviceCredentialPanel.tsx` shows only `active`/`missing`, reusing
  `get_account_status` — never the secret.

**Testing pitfall found and fixed**: an early version tried to test the new session-storage
functions via `tauri::test::mock_app()`, following the pattern `local_runtime`'s tests use.
Unlike that DB-based pattern, `mock_app()`'s `app_data_dir()` resolves to a **real, unsandboxed
path on the host filesystem** — every test ended up racing every other parallel test on the same
real file, with failures that looked like logic bugs but were actually cross-test file
contention. Fixed by splitting storage functions into a path-parameterized `_at(path)` core (no
`AppHandle` involved at all) that tests drive directly against a `tempfile` directory — fully
hermetic, and the actual regression coverage that matters (the session/legacy-token merge never
clobbers either) is still exercised against the real function bodies, not a re-implemented fixture.

## 4. Remaining sections

Heroes search/composition ✅, Hero detail composition ✅, Items catalog ✅ (below), Sounds →
Герои removed ✅ — Оформление editor/renderer parity, Chat, Home, Settings, performance, tests,
visual QA remain — tracked in Weeek WK-122 (task id 123) and filled in here as each lands.

## 6. Items catalog + Sounds → Герои removal (§12-14)

The Rust catalog (`game_sounds/catalog.rs::item_catalog`) turned out to be a small, fixed list —
**22 items** (17 supported, 5 unsupported), not the hundreds a generic Dota shop implies. This
changed the practical approach: rather than a generic/scalable category-import pipeline, each
item's real shop category was researched and hand-mapped once
(`apps/companion/src/services/itemCategories.ts`).

- Fetched OpenDota's public `constants/items` endpoint (cost + `qual`/rarity tier) to confirm price
  tier for every item before assigning a category — that endpoint does **not** expose the actual
  shop-tab label itself (only a rarity/border-color tag), so the specific category within a group
  (e.g. Поддержка vs Магия) is a documented, per-entry judgement call from stable, long-unchanged
  Dota 2 shop knowledge for these specific items, not a blind guess. Ambiguous cases (Blood Grenade
  — a Techies innate, not purchasable at all; Hand of Midas/Blink Dagger/Yasha/Kaya — don't cleanly
  fit Armor/Weapon/Magic/Support) are called out in code comments rather than forced into a
  confident-looking wrong bucket.
- `ItemsCatalog.tsx` replaces the flat `ItemsGrid.tsx` + per-click `ItemSoundModal.tsx`: a
  master/detail layout, catalog grouped by category on the left, a **persistent** right-side
  inspector (not a modal) that reuses the existing `SoundBindingRow` verbatim. Unsupported items
  stay browsable (clickable, not `disabled`) — the inspector states plainly that automatic detection
  isn't supported for that item, never hides it or fakes a working binding.
- `ItemSoundModal.tsx`/`SoundModal.tsx` deleted (fully replaced, zero remaining references).
- Sounds → "Герои" tab removed entirely (no redirect card) — hero-ability sound assignment now
  lives exclusively on `HeroDetailPage.tsx`.
- "Библиотека" (§15, uploaded-file reuse/preview/delete) intentionally not built this slice — the
  tab list is already an array (`TABS` in `SoundsPage.tsx`) specifically so adding it later is a
  one-line change, not a restructure, per the task's "navigation architecture подготовить
  правильно, но не раздувать" instruction.

**Process note**: the first attempt at this delegated it to a background subagent with a thorough
brief; the subagent's session hit an account-level API rate limit before completing and the work
was picked up and finished directly instead — no partial/broken state was left behind to clean up.

## 5. Heroes — keyboard search, favorites placement (§8, §9)

- Removed the permanent `SearchInput`. A window `keydown` listener (mounted only while the Heroes
  screen is on screen) drives the same RU/EN/alias-aware `searchHeroes` Sounds → Heroes already
  used — ported UX from `apps/web`'s favorite-heroes keyboard picker
  (`queue-widgets-panel.tsx`'s `heroQuery`/3s-idle-clear/Backspace pattern), with Escape added for
  immediate clear (not present in the web original, added here since the task's own acceptance
  criteria call for it).
- A transient indicator (a red banner echoing the typed query, uppercased) appears only while
  `query` is non-empty — no permanent chrome.
- Favorites moved into `SectionHeader`'s existing `actions` slot (top-right, alongside the title),
  rendered as small (40×40px) icon-only portraits — no separate labeled full-width strip.
- Radio primitive (`ui/Radio.tsx`) added, visually identical to Checkbox (shared CSS rule block in
  `ui.css`) per the task's explicit instruction that the look must match even though a checkmark on
  a radio is not the conventional treatment. Replaces the last native `<input type="radio">` in the
  app (`ChatTtsSettings`'s TTS engine choice).
