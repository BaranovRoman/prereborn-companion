# WK-120: Local Overlay Runtime + Canonical BroadcastState

## Question

Companion already receives Dota's GSI stream and already runs on the same machine as OBS. Today's
overlay (the actual pixels an OBS Browser Source renders) is still served by `apps/web`
(prereborn.ru), meaning every visual-state transition round-trips through the public internet even
though nothing about it is cross-device. Separately, WK-119's audit found the scene-resolution logic
duplicated: Rust's `obs::BroadcastScene::from_gsi`/`resolve_desired_scene` (drives OBS scene
switching) and `apps/web`'s `getBroadcastScene`/`getActiveScene` (drives the web overlay) are two
independently-maintained implementations of the same decision.

This ticket answers: what should the ONE canonical decision look like, where should it live, and
what does a same-machine local overlay transport need to look like to be production-safe.

**Scope correction, carried over from WK-119 and binding here too**: this is not an offline-first
project. The reason a local overlay server is worth building is topology, not resilience — GSI
already lands in Companion, OBS runs on the same PC, so `Companion → apps/api → OBS Browser Source`
is a same-machine round trip through the public internet for no reason tied to any of the
legitimate reasons a backend hop is justified (no secret, no multi-device requirement, no
admin/shared-state need). See §7 for what stays server-side and why.

## Non-goals (explicit, per ticket)

- Not migrating any existing user's production OBS Browser Source URL automatically. See §6.
- Not extracting `apps/web`'s production-parity renderer (`OverlayCanvas`/`AnchoredWidget`) into a
  form Companion can serve, this ticket. See §5 for why and what ships instead.
- Not building the Unified "Оформление" editor shell. That depends on both of the above and is a
  separate future ticket (§9).
- Not touching `apps/web`'s TypeScript resolver (`getBroadcastScene`/`getActiveScene`) — the
  duplication described above is resolved only on the Rust/Companion side this ticket actually
  owns; see §2 for why unifying the TypeScript side too is out of scope here.

---

# 1. Architecture before this ticket

```
Dota GSI → Companion (Rust)
              ├─ obs::BroadcastScene::from_gsi + resolve_desired_scene → OBS scene switch (local, already)
              └─ backend::try_send_pending → apps/api → Postgres/session state
                                                   ↓
                                          apps/web overlay (getBroadcastScene/getActiveScene)
                                                   ↓
                                          OBS Browser Source (polls apps/web every 1.5s)
```

Two independent scene resolvers, one Rust and one TypeScript, computing the same GSI→scene mapping
from the same field paths, with no shared source and no shared test fixtures (confirmed by direct
code reading in `docs/research/wk-119-companion-primary-app-boundary-audit.md` §1.2). The actual
visual overlay a viewer sees is rendered entirely inside `apps/web`, fetched over the public
internet even though the machine running Companion and the machine running OBS are, for the
overwhelming majority of PreReborn's users, the same machine.

# 2. Canonical BroadcastState

## 2.1 What moved, what didn't

`apps/companion/src-tauri/src/broadcast_state.rs` (new) now owns:

- `BroadcastState` (enum: `BetweenMatches`, `Draft`, `Gameplay`, `PostStream`) — moved here
  verbatim from `obs::BroadcastScene`.
- `BroadcastState::from_gsi(payload)` — the pure GSI→scene mapping, moved here verbatim.
- `resolve(gsi_derived, session_ended, manual_summary_override) -> BroadcastState` — the one
  precedence rule (session end or a manual "Итоги стрима" pin both win over whatever GSI would
  otherwise show), extracted from what used to be entangled inside `obs.rs`'s
  `resolve_desired_scene`.

`obs.rs` keeps: `pub type BroadcastScene = broadcast_state::BroadcastState;` (a plain alias — every
existing call site, in `commands.rs`, `state.rs`, `backend/mod.rs`, and this file's own 25-test
suite, keeps compiling and passing unchanged, confirmed by running that exact suite before and
after this change), `obs_scene_name` (OBS-specific, stays here), and a now-two-line
`resolve_desired_scene` that calls the canonical `resolve` and then applies exactly one remaining
OBS-specific adaptation: if the mapped Post Stream OBS scene doesn't exist in the user's canvas
(`post_stream_unavailable`, WK-115), the OBS *switch target* falls back to BetweenMatches — the
canonical state itself still reports PostStream; only what OBS is told to switch to differs. This
distinction matters: "the stream is canonically showing PostStream" and "the physical OBS scene
mapped to PostStream happens not to exist" are different facts, and conflating them would leak an
OBS-specific concern into what the overlay renderer is told.

## 2.2 What was deliberately left out of the canonical value

Two things that existed in one of the two original resolvers, on purpose left out of `resolve`:

- **`post_stream_unavailable`** (Rust-only) — an OBS canvas fact, not a broadcast-state fact; stays
  in `obs.rs` as described above.
- **Companion-offline draft-protection fallback** (`apps/web`-only) — `getActiveScene`'s
  `!companionIsOnline && draftProtectionMode !== "off"` branch defensively shows Draft when the web
  overlay can't confirm Companion is alive (an anti-snipe safety net for viewers, since a silent
  Companion could mean anything is happening). This has no analogue in Rust because Rust computing
  this value *is* Companion — if Companion is down, nothing in this process runs at all, so there's
  no "is Companion online" question to ask from inside it. This is a real, load-bearing asymmetry
  between the two overlays, not an oversight — see §7 for why the legacy web overlay keeping this
  fallback matters.

## 2.3 Why the TypeScript resolver wasn't unified too

Doing so would mean piping Companion's canonical decision to `apps/api`/`apps/web` (a new sync
event type, a new endpoint, a new consumer in the public overlay) — real scope into two other apps,
which both this ticket's own instruction ("не делай monorepo-wide рефактор без необходимости") and
WK-119's "why backend required" discipline argue against doing speculatively. The duplication is
resolved on the side that actually gets a new consumer this ticket (Rust, via `overlay_server.rs`,
§4); `apps/web`'s resolver is unchanged and continues to serve the legacy overlay path (§7).

## 2.4 Test coverage (§ acceptance criteria)

`broadcast_state.rs`'s 10 unit tests cover every state the ticket asked for directly: idle/no active
match, draft, gameplay, a finished match alone (post-game ≠ PostStream), session end → PostStream
regardless of GSI, manual override → PostStream independent of session_ended, resume live (clearing
the override lets GSI back through), reconnect (lost GSI signal alone is not an end-of-stream
signal), and — explicitly, as its own pinned test — that `resolve` has no OBS-automation-enabled
parameter at all, so a user who disables auto scene-switching (a cosmetic OBS-side preference) never
affects what the canonical state or the renderer reports. `obs.rs`'s pre-existing 25-test suite
(unchanged, still green) covers the OBS-specific downstream adaptation on top.

---

# 3. Local Overlay Runtime — transport

New module `apps/companion/src-tauri/src/overlay_server.rs`, started from `lib.rs`'s `setup()`
alongside the other background services (GSI server, OBS init, local-runtime sync worker).

## 3.1 Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/overlay/health` | GET | `{"status":"ok"}` — liveness probe |
| `/overlay/state` | GET | current `OverlayStateSnapshot` (`{scene, updatedAt}`) — one-shot fetch, used for the initial page load before the SSE connection opens |
| `/overlay/events` | GET | Server-Sent Events stream — initial snapshot immediately on connect, then a new event only when the resolved scene actually changes |
| `/overlay` | GET | the dev-preview HTML page (§5) |

## 3.2 Port

`127.0.0.1:3666` — chosen as the next number after the GSI server's `127.0.0.1:3665`
(`state::GSI_PORT`), following the same "one stable port per local service" pattern already
established. `OVERLAY_PORT` is a plain constant; no config UI exists yet to change it (not needed —
nothing conflicts with it today, and adding a settings knob before there's a real reason to change
the port would be speculative).

## 3.3 Transport mechanism and the bug it surfaced

Chose Server-Sent Events over WebSocket: this codebase has `tungstenite` only as an OAuth-style
*client* (used to connect *to* OBS's own WebSocket server, `obs.rs`) — there is no existing
server-side WebSocket capability, and adding one would mean either a second dependency/pattern or
hand-rolling the WS handshake. `tiny_http` (already a dependency, already used for the GSI server)
supports a raw-socket takeover via `Request::upgrade`, designed by its own docs for exactly this
"persistent connection, not a normal bounded response" case (its doc comment literally cites
WebSockets as the motivating use case) — SSE only needs one more thing on top: a `Content-Type:
text/event-stream` header and a simple text framing (`data: <json>\n\n`), no handshake protocol of
its own to implement.

**A real implementation bug surfaced and fixed during this ticket, worth recording**: the first
version handled `/overlay/events` through tiny_http's normal `Response`/chunked-transfer-encoding
path (`Response::new(status, headers, my_reader, None, None)`). That path's default chunked encoder
(`chunked_transfer::Encoder`, `flush_after_write: false`, an internal 8192-byte buffer) only flushes
a chunk to the socket once the buffer fills or the underlying reader hits EOF. Since this stream's
reader never hits EOF (it's live/open-ended) and each SSE frame (~80–100 bytes) is far smaller than
8192 bytes, every frame after the first sat buffered in-process and never reached the client — an
integration test (`sse_stream_sends_an_initial_snapshot_then_pushes_a_transition`) caught this
directly (the second, transition frame reliably timed out). The fix was switching to
`Request::upgrade`, which hands this function the raw socket so it can call `.flush()` itself after
every frame — the transport now guarantees prompt delivery instead of depending on undocumented
internal buffer-size behavior of a transitive dependency. This is exactly the kind of thing the
ticket's "integration test without a backend" requirement was for; it earned its keep in this
ticket, not hypothetically.

A second, subtler bug the same integration test caught: the diff-gate initially compared the whole
`OverlayStateSnapshot` (including `updated_at`, a fresh timestamp on every check) rather than just
`scene` — meaning it fired on every poll tick regardless of whether the scene had actually changed,
defeating the entire "no traffic for an unchanged state" design goal. Fixed by comparing `scene`
alone (`overlay_server::scene_changed`, directly unit-tested).

## 3.4 Cadence

A diff-gated poll, not push-on-mutation: `/overlay/events`' handler thread checks
`broadcast_state::resolve` (via `overlay_server::current`) every 300ms and only writes a frame when
the resolved scene differs from the last one it sent. This was a deliberate simplification over
hooking a push notification into every AppState mutation site (GSI tick, session-end, manual
override toggle — at least four call sites across `obs.rs`/`commands.rs`) for this first slice: the
poll itself is a cheap, local, no-I/O comparison (same order of magnitude as GSI's own ~2/s tick
rate and the existing Companion-UI status hooks' 3s polls — not remotely "aggressive"), and it
avoids adding new coupling into the OBS/session code paths WK-116 already had one production
incident around. Revisit with a genuine event bus if the 300ms detection latency ever matters in
practice; nothing here blocks that later.

## 3.5 Reconnect/restart behavior

- **Browser Source reload**: every `/overlay/events` connection starts by sending the current
  resolved scene as its first frame (before checking for a diff against nothing) — a reconnecting
  client is never left waiting for the next GSI tick or state transition to know what to show.
- **Companion restart**: the listener re-binds on next launch; nothing about the overlay state is
  persisted (correctly — it's fully derived from live GSI/session state each time,
  see `broadcast_state::resolve`, which reads current `AppState` fresh on every call).
- **OBS restart / Browser Source removed and re-added**: same as reload — a fresh connection always
  gets a correct initial snapshot.
- **Port conflict**: `overlay_server::init` mirrors `server::start`'s (GSI) exact bind-retry-with-
  capped-backoff shape — a bind failure is logged and retried, never a panic, never taking down any
  other part of Companion. Verified directly:
  `binding_an_already_used_port_fails_gracefully_instead_of_panicking`.

---

# 4. Security

- **Loopback only** — binds `127.0.0.1:3666` explicitly (mirroring the GSI server's own precedent),
  never `0.0.0.0`. Pinned by `security::init_binds_loopback_only_never_0_0_0_0`.
- **No secrets in the payload, by construction** — `OverlayStateSnapshot` has exactly two fields
  (`scene`, `updatedAt`); `overlay_server::current` reads only `AppState.last_gsi_payload` and the
  two lifecycle booleans the resolver needs, and its return type has no room for anything else. A
  test (`served_payload_never_contains_a_token_secret_or_password_field`) asserts the serialized
  JSON never contains `token`/`secret`/`password`/`companion_token`/`bearer` — a guard against a
  future field addition accidentally leaking a credential, not just a description of the current
  shape.
- **No new attack surface for existing users** — nothing today points any production OBS Browser
  Source at this server; it is new, additive, inert-until-used surface. A machine running this
  version of Companion opens one more loopback-only TCP port; nothing reachable from the network,
  nothing that changes any existing behavior.

---

# 5. Renderer — what shipped vs. what's deferred, and why

**What shipped**: a minimal, explicitly-labeled dev-preview page (`overlay_server/preview.html`,
served at `/overlay`) — plain HTML/CSS/JS, no build step, no external resources, connects to
`/overlay/events` via `EventSource` and renders a large text label + a state-tinted background for
whichever of the four scenes is current. It exists to prove the transport end-to-end with something
a human can look at, and says so on the page itself. It is **not** styled to match production and
**must not** be pointed to by a real OBS Browser Source.

**What's deferred**: extracting `apps/web`'s actual production renderer
(`OverlayCanvas`/`AnchoredWidget`, confirmed in WK-119's audit to already be a genuinely shared,
mode-agnostic component reused identically by the live overlay and the `/stream/overlay-editor`
preview) into a form Companion can serve locally. Reasons for deferring, stated plainly rather than
glossed over:

1. It's a cross-app extraction (pulling React/TSX out of a Next.js app into something buildable and
   servable from a Tauri app's Rust process) — real new build tooling, not a config change.
2. Verifying visual parity against production honestly requires a rendering/screenshot comparison
   pipeline this environment doesn't have set up. Claiming "visual QA passed" without one would be
   dishonest, not just optimistic — so this ticket doesn't claim it. §9 lists this as explicit
   remaining work rather than silently lowering the bar.
3. The transport this ticket delivers is exactly what the real renderer will need to consume
   (`GET /overlay/state` for a one-shot fetch, `/overlay/events` for live updates) — building it
   against the dev-preview page proved that contract without also taking on the extraction's risk
   in the same change.

This is the same "ship the foundation, not the whole target model, in one slice" pattern WK-110's
own audit chose for WK-111 (local durable state) over its full multi-stage target — narrowing scope
here is consistent with how this codebase has handled exactly this kind of tradeoff before, not a
deviation from it.

---

# 6. Existing users / migration — deliberately not attempted this ticket

No code in this ticket touches any user's OBS scene configuration, Browser Source URL, or webcam/
game-capture/alerts layout. `overlay_server` is new, inert-until-pointed-at surface (§4) — shipping
it changes zero behavior for any existing production install.

The ticket's own instruction is explicit: *"Если автоматическая migration неоднозначна — не
угадывать. Сделай explicit UI/action с понятным состоянием."* Building that action responsibly
needs:

- the renderer to actually be production-parity first (§5) — migrating a real user's live Browser
  Source to point at a placeholder page would be a regression, not a migration;
- a read path into OBS's current Browser Source URL (via `GetInputSettings`/`GetInputList` on the
  existing obs-websocket connection this codebase already has a client for) to detect "this input is
  PreReborn's overlay" vs. "this is the user's own unrelated browser source" reliably, which has not
  been designed or built yet;
- a write path (`SetInputSettings`) scoped to only the one input identified as PreReborn's own,
  never touching webcam/game-capture/alerts/layout — also not built yet.

Attempting this in the same slice as an unreviewed-at-night local server would be exactly the kind
of rushed, high-blast-radius change the correction earlier in this project's instructions warned
against. It's listed as the next concrete step in §9, not silently skipped.

---

# 7. Legacy server overlay — what still needs it, and why

`apps/web`'s `/overlay/[publicToken]` stays exactly as it is, unmodified by this ticket, and remains
the only overlay any existing production Browser Source actually uses. What still depends on it:

- **Every existing production OBS Browser Source** — see §6, nothing has been migrated.
- **Any viewer/mod who loads the public overlay URL directly** (not just OBS) — the web overlay is
  inherently a multi-consumer resource; a local-only server on the streamer's PC structurally cannot
  serve that case, which is *why* WK-110 already scoped the public overlay as permanently
  server-backed, not a local-first candidate.
- **The companion-offline draft-protection fallback** (§2.2) — this is real, load-bearing safety
  behavior that a local-only overlay cannot replicate: if Companion crashes mid-draft, the local
  overlay server goes down with it (nothing left running to serve `/overlay/events` at all), while
  the web overlay — backed by whatever `apps/api` last recorded — can still fall back to a
  protective Draft cover. This is a genuine architectural tradeoff, not a gap to silently paper
  over: a fully local-only overlay is *less* resilient against exactly this one failure mode than
  today's server-hosted one. Any future decision to deprecate the legacy overlay needs to either
  accept that tradeoff explicitly or design a replacement for this specific safety behavior first.
- **`isCompanionOnline`/`getCompanionLastSeenAt`** (WK-110 §2.9) — the public overlay's own
  liveness indicator is a downstream consumer of Companion's existing `/companion/commands` poll;
  unrelated to and unaffected by this ticket either way.

No duplication was introduced by keeping this path unchanged — `apps/web`'s resolver was already
independent before this ticket (§2.3) and remains exactly as independent now. Deprecating it is a
future decision gated on the renderer extraction (§5), the migration action (§6), and an explicit
call on the safety-fallback tradeoff above — not on anything this ticket needed to resolve.

---

# 8. Tests

- `broadcast_state.rs`: 10 unit tests, one per acceptance-criterion scenario listed in the ticket
  (§2.4 above).
- `obs.rs`: pre-existing 25-test suite, unchanged, confirmed still green — the byte-for-byte
  behavior-preservation claim for the refactor is backed by this, not just code inspection.
- `overlay_server.rs`: 12 tests —
  - `state_endpoint_reflects_the_canonical_resolution_of_the_latest_gsi_tick`,
    `state_endpoint_defaults_to_between_matches_before_any_gsi_tick_ever_arrives`,
    `session_ended_wins_over_the_latest_gsi_tick_in_the_served_state` — the pure `current()`
    resolution logic;
  - `http_state_endpoint_returns_the_current_snapshot_over_a_real_socket`,
    `http_health_endpoint_responds_ok`, `http_unknown_path_returns_404` — real TCP-socket HTTP
    round trips, no mocked transport;
  - `sse_stream_sends_an_initial_snapshot_then_pushes_a_transition` — **the integration test the
    ticket asked for**: GSI/local state → canonical `BroadcastState` → local transport → a real
    client receives both the initial snapshot and a live transition, zero backend involvement
    anywhere in the test (no `reqwest`, no `AppState.backend_*` field ever read);
  - `scene_changed_ignores_everything_except_the_scene_itself` — direct pin for the diff-gate bug
    (§3.3);
  - `binding_an_already_used_port_fails_gracefully_instead_of_panicking` — port-conflict behavior;
  - `security::init_binds_loopback_only_never_0_0_0_0`,
    `security::served_payload_never_contains_a_token_secret_or_password_field`,
    `security::current_reads_only_the_two_appstate_fields_the_resolver_needs` — the security
    guarantees from §4, enforced as tests rather than only stated in prose.
- Full existing suite (325 Rust tests total, up from 303 before this ticket; 238 frontend tests,
  untouched by this ticket) verified green — see the accompanying PR's test-plan checklist.

## Visual QA — explicitly not performed

Per §5: the dev-preview renderer is not claimed to match production, so no visual comparison against
`apps/web`'s overlay was attempted or is claimed here. This is the one acceptance-criterion item from
the original ticket this document does not satisfy, stated plainly rather than silently dropped —
see §9 for the follow-up that owns it.

---

# 9. Remaining work for Unified "Оформление"

In dependency order, matching WK-119's roadmap:

1. **Renderer extraction** (§5) — pull `OverlayCanvas`/`AnchoredWidget` and the widget set out of
   `apps/web` into a form buildable/servable outside Next.js, then point `overlay_server`'s
   `/overlay` route at it instead of the dev-preview page. This is the item that unblocks real
   visual QA (a screenshot/pixel comparison between the extracted renderer and `apps/web`'s live
   overlay, on the same fixture state, at 1920×1080).
2. **OBS Browser Source migration action** (§6) — explicit, reviewed, own security pass given it
   writes to a user's real OBS configuration via `SetInputSettings`.
3. **Unified "Оформление" editor shell** — depends on both of the above (preview must render via the
   same code path as the real local overlay); also needs new position-editability for Between
   Matches/PostStream, which (per WK-119's audit) have never had any.
4. Only after the above: a real decision on deprecating the legacy web overlay, explicitly
   addressing the companion-offline safety-fallback tradeoff from §7.

---

# Sources

- `docs/research/wk-119-companion-primary-app-boundary-audit.md` — the audit this ticket continues
  from; §1 (overlay renderer/BroadcastState duplication) and §1.4 (local overlay server rationale)
  are this ticket's direct starting point.
- Code read/modified directly: `apps/companion/src-tauri/src/obs.rs`,
  `apps/companion/src-tauri/src/broadcast_state.rs` (new),
  `apps/companion/src-tauri/src/overlay_server.rs` (new), `apps/companion/src-tauri/src/lib.rs`,
  `apps/companion/src-tauri/src/state.rs`.
- `tiny_http` 0.12.0 and `chunked_transfer` 1.5.0 source (vendored crate sources read directly,
  `~/.cargo/registry/src/index.crates.io-*/`) — `Request::upgrade`'s doc comment and
  `chunked_transfer::Encoder`'s `write`/`flush` implementation, the basis for §3.3's transport
  decision and the bug it documents.
- Weeek: WK-120 (#120, this ticket), WK-119 (#119).
