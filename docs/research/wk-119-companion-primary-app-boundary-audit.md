# WK-119: Companion as the primary streamer app — ownership audit and roadmap

## Question

What should Companion (desktop), `apps/web` (prereborn.ru), and `apps/api` (backend) each own next,
so that a streamer's normal workflow — register, connect integrations, configure how the stream
looks, run the stream, correct a match afterward — never requires visiting the website?

`docs/research/wk-110-local-first-audit.md` (WK-110) already answered this for session/match/MMR
state and OBS scene automation, and that work shipped as WK-111 through WK-118. This document
covers what WK-110 explicitly excluded: the public overlay/visual editor, auth/registration,
Steam/Twitch/DonationAlerts integrations, corrections UI placement, sync visibility, and the
mobile-web boundary.

**Explicit scope correction, made mid-audit and binding for everything below**: local-first is not
offline-first, and "network is involved" is not a reason to route something through `apps/api`.
Companion is a streamer's workstation with an assumed-live internet connection (they're streaming
to Twitch). The question for every function is not "can this work offline" but **where is it
rational for this to run, and who owns its state** — Companion, the backend, or the external
service directly. A backend hop is justified only when it protects a secret, is a trust boundary,
serves multi-device/shared state, is an admin/entitlement operation, or a provider's API leaves no
safe direct-from-desktop path. This document adds a "why backend required" column everywhere a
backend dependency is discussed, per that correction.

## Non-goals

- Not re-litigating WK-110's session/match/MMR/OBS-lifecycle findings — referenced, not repeated.
- Not implementing the Twitch migration this document's own findings make plausible — the
  correction that reframed this audit explicitly blocks that pending the security analysis below,
  which this document delivers but does not act on.
- Not implementing the local overlay server, unified editor shell, or desktop OAuth/deep-link auth
  — scoped into the roadmap (§8) as separate future tickets, per the same "don't build a big-bang
  rewrite" precedent WK-110 set.

---

# 1. Overlay renderer and BroadcastState

## 1.1 What exists today

`apps/web`'s `/overlay/[publicToken]` route is not one opaque page — it already has a genuinely
shared, mode-agnostic rendering primitive: `OverlayCanvas`
(`apps/web/src/components/pages/overlay/overlay-canvas.tsx:73-188`), which the live overlay and the
`/stream/overlay-editor` preview both mount identically (`mode="live"` vs `mode="preview"`), same
`computeSceneDimensions`, same `AnchoredWidget` (`anchored-widget.tsx`) turning `xVw/yVh/anchor` into
real pixels. This is the load-bearing reuse WK-110-style architecture would want — it already
exists, just not extracted outside `apps/web`. `OverlayPage` itself (`overlay/index.tsx`) is the
stateful orchestrator around it (polling, scene branching), not a pure function.

**BroadcastState resolution is duplicated, confirmed** — this is the concrete instance of the
concern in the original brief's §3: `getBroadcastScene`/`getActiveScene`
(`apps/web/src/components/pages/overlay/lib/get-broadcast-scene.ts`,
`get-active-scene.ts`) and Rust's `BroadcastScene::from_gsi`
(`apps/companion/src-tauri/src/obs.rs:112-126`) implement the same three-branch GSI→scene mapping
independently, in two languages, with no shared source or shared test fixtures. They also diverge:
the web resolver layers in session-ended/manual-override/draft-protection precedence that Rust's
`from_gsi` doesn't have (Rust handles `PostStream` via a separate path, `handle_session_state`).

Companion has **zero** overlay preview/editor UI today — confirmed by exhaustive grep, no
"Оформление" concept exists anywhere in `apps/companion/src`.

## 1.2 Why this is a backend-independent problem, not a local-first one

The duplication above isn't a "should this run offline" question — it's a maintenance-cost problem
(two hand-written implementations of one decision) that exists regardless of connectivity. Fixing
it means picking ONE resolver to be canonical and having the other consume it, not adding a sync
layer. Two real options:

- Keep Rust canonical (it already drives the real OBS scene switch, which is genuinely local/no
  network involved), and have the web/editor TypeScript resolver be tested against Rust's behavior
  via a shared fixture file (a JSON table of GSI-shape → expected scene) both suites load — cheap,
  low-risk, catches drift without a rewrite.
- If/when a local overlay server exists (§2), the browser-rendered overlay itself could receive the
  ALREADY-RESOLVED scene from Companion instead of resolving it a second time client-side — at that
  point the duplication disappears structurally, not just by convention.

## 1.3 Editor inventory (four visual scenes, current config surface)

| Scene | Editor exists? | Coordinate system | Config entity/API | Notes |
|---|---|---|---|---|
| Draft | Yes — mode switch (`off`/`cover`) + text/position, `overlay-editor/index.tsx:661-720` | Virtual 1920×N, anchors | `OverlayLayout.draftProtection` via `GET/PUT /account/me/overlay-layout` | `photorealism` is a reserved, unimplemented identifier (`types.ts:177`) — no renderer. Cinematic Draft / Fake Picker were **deliberately deleted** in WK-69 ("never had enough real GSI data"), not merely unused — confirmed dead, do not resurrect per original brief's own instruction. |
| Gameplay | Yes — full drag/resize, `overlay-editor/index.tsx` | Virtual 1920×N, anchors | Same `OverlayLayout`, `scenes.gameplay` | Widget positions/camera-zone/minimap-cover all editable. |
| Between Matches | Form only, no drag/resize — `queue-widgets-panel.tsx` (channel goal, webcam fallback, favorite heroes, socials) | Raw CSS `vw/vh`, not the anchor system | No `OverlayLayout` entry at all — content-only | Editor page explicitly tells the user layout isn't configurable here; content lives on the dashboard. |
| PostStream | None — `StreamEndedScene` is a fixed composition, "pure function of `data`" | Raw CSS `vw/vh` | No config entity | Zero settings surface exists to migrate. Companion's "Итоги стрима" button (`HomePage.tsx:179`) is a **different, unrelated code path** — it only flips the OBS scene (`commands.rs:378-402`), doesn't touch `session_ended` or trigger the web content at all. |

Consolidating all four into one Companion-hosted editor means reconciling two coordinate systems
(virtual-1920 anchors vs. raw vw/vh) and building position-editability for two scenes that have
never had any (Between Matches, PostStream) — this is real, non-trivial editor work, not just a
relocation of existing forms.

## 1.4 Local overlay server — this candidate survives the correction, for a different reason

The original brief framed the local overlay server as an offline-resilience feature. That framing
is wrong per the correction — but the server is still the right target, for a **latency/hop**
reason that has nothing to do with offline support:

```
Today:    Dota → Companion (GSI) → apps/api (poll relay, 1.5s) → OBS Browser Source (same PC)
Target:   Dota → Companion (GSI) → localhost HTTP/WS → OBS Browser Source (same PC)
```

GSI state already lands in Companion first. OBS runs on the same machine as Companion. Routing the
render data through `prereborn.ru` and back is a same-machine round trip through the public
internet for no reason tied to any of backend's legitimate justifications (no secret involved, no
multi-device requirement, no admin operation) — it's a **pure latency/hop removal**, independent of
whether the internet happens to be up. This is still worth building; the audit doc's job is just to
make sure it's justified on the right grounds.

---

# 2. Auth

## 2.1 Current state

- Web: JWT access+refresh tokens in `localStorage` (`apps/web/src/entities/stream-user/lib/tokens.ts`),
  `POST /stream/auth/{register,login,refresh,logout}` (`apps/api/src/routes/stream/auth.ts`).
- Companion token (what Companion actually authenticates with): generated once on the web dashboard
  (`regenerateCompanionTokenController`, `apps/api/src/controllers/stream/account.ts:95-121`),
  revealed once, manually copy-pasted into Companion (`CompanionTokenForm.tsx`). Verified server-side
  by sha256 hash lookup, no expiry — a third, independent auth scheme from JWT.

## 2.2 Target, per the correction

Moving the login/register **UI** into Companion does not require moving the account database local.
`apps/web`'s auth is already a plain JSON API (`/stream/auth/*`) with no cookie/session-affinity
trick — a native Companion form can call it directly:

```
Companion (native email+password form)
  → POST https://prereborn.ru/api/stream/auth/login   (no browser needed — this is PreReborn's own form, not a third party's)
  → JWT stored in Companion's own local secure storage
```

`Why backend required?` — Yes, unconditionally: the account database is inherently shared/
server-owned (same account must work from web admin, future mobile remote, etc.) and password
verification is a trust-boundary operation. Nothing here argues for a local auth database; the only
actual gap today is that the *form* only exists on the website, not that the *data* is
server-owned (that part was already correctly designed).

System browser is needed only for the pieces that are inherently third-party OAuth (§3) — never for
PreReborn's own login form.

Companion has `tauri-plugin-opener` already wired (`open_twitch_settings`,
`commands.rs:146-151`, already used to open `{web}/stream` in the OS browser) — the mechanism for
"open browser for OAuth" already exists in the codebase, just not yet used for the OAuth callback
return leg. No `tauri-plugin-deep-link` and no custom-protocol registration exist yet; the only
local HTTP server is the GSI server (`tiny_http` on `127.0.0.1:3665`,
`apps/companion/src-tauri/src/server/mod.rs`) — structurally one more `match request.url()` branch
away from also hosting a temporary OAuth callback path, but that is new code, not a migration of
existing behavior. Deciding between a custom-protocol callback and a temporary localhost callback is
a follow-up ticket's job, not resolved here.

---

# 3. Integrations — Twitch (full analysis, per the correction's explicit requirement)

## 3.1 Current flow, exact

```
CURRENT:
1. User clicks "Подключить Twitch" on apps/web (/stream settings)
2. apps/api builds https://id.twitch.tv/oauth2/authorize?response_type=code&scope=user:read:chat+channel:read:subscriptions+moderator:read:followers&...
   (apps/api/src/controllers/stream/twitch.ts:28-38 — standard Authorization Code Grant, NO PKCE)
3. User authorizes on Twitch's own page (browser, web dashboard tab)
4. Twitch redirects to apps/api's callback
5. apps/api exchanges the code: POST https://id.twitch.tv/oauth2/token
   { client_id, client_secret, code, grant_type=authorization_code, redirect_uri }
   (twitch-integration-service.ts:103-116 — client_secret sent, backend-only, never left the server)
6. access_token + refresh_token stored in Postgres stream_twitch_links (access_token, refresh_token, token_expires_at)
7. apps/api opens the EventSub WebSocket (wss://eventsub.wss.twitch.tv) using the USER access token
   (twitch-eventsub-chat.ts:294-307, via getAccessToken() → getTwitchUserToken — NOT client_secret,
   NOT an app/client-credentials token — that separate getAppToken() path exists only for an
   unrelated GET /helix/streams live-status lookup)
8. Refreshing the user token (when expired) DOES use client_secret:
   POST https://id.twitch.tv/oauth2/token { client_id, client_secret, grant_type=refresh_token, refresh_token }
   (twitch-integration-service.ts:161-196)
9. apps/api buffers incoming chat/follow/sub/raid events server-side (chatMessages map, ≤40 entries)
10. Companion polls GET /stream/companion/twitch-chat every 1.5s (companion_token-authenticated,
    NOT a Twitch token) to read the buffered messages
11. Companion has never sent a chat message to Twitch — confirmed absent, no code path exists
```

Companion touches **zero** Twitch credentials today — not the access token, not the refresh token,
not the client secret. Its only Twitch-adjacent code is `open_twitch_settings`, which just opens the
browser to the web settings page; the actual OAuth consent happens entirely inside `apps/web`.

## 3.2 What official Twitch documentation says (confirmed via dev.twitch.tv, cited)

- Twitch's developer console lets an app be registered as **confidential** (has a secret) or
  **public** (no secret). Per `dev.twitch.tv/docs/authentication/register-app/`, **public client
  type is restricted to the Device Authorization Grant Flow** — it is not an option for the
  authorization-code grant PreReborn currently uses.
- Twitch does **not** document PKCE support for the authorization code grant (a public developer
  forum request for it has stood unanswered by Twitch staff as of the last check). So there is no
  "authorization code + PKCE, no secret" option Twitch actually supports — the only documented
  no-secret path for a distributed app is the Device Code flow, a materially different UX (user
  types a code into a Twitch verification page rather than a normal OAuth consent redirect).
- Per `dev.twitch.tv/docs/eventsub/handling-websocket-events/`: *"webhooks uses app access tokens
  and WebSockets uses user access tokens. If you use app access tokens with WebSockets, the
  subscriptions will fail."* — confirms the code's choice (user token) is the only one that works
  for EventSub WebSocket, and this holds for every subscription type PreReborn actually uses
  (`channel.chat.message`, `channel.follow`, `channel.subscribe`/`channel.subscription.gift`,
  `channel.raid`) — **none of them require `client_secret` at subscribe/connect time.**
- Per `dev.twitch.tv/docs/authentication/refresh-tokens/`, the `client_secret` refresh parameter is
  *"not required if your application's client type was set to public"* — but per the point above,
  "public" for this codebase's actual OAuth grant (authorization code) isn't a Twitch-supported
  configuration; the secret-free refresh applies specifically to tokens obtained via Device Code
  flow, not the flow PreReborn uses today.
- Sending a chat message via Helix (`Send Chat Message`) needs a **user** token with `chat:edit`
  scope — not currently implemented anywhere, not an app-token operation either.

## 3.3 Operation-by-operation table

| Operation | Current owner | Target owner | Credential | Backend required? | Exact reason |
|---|---|---|---|---|---|
| 1. Authorization (redirect to Twitch consent) | `apps/api` builds the URL, browser tab on `apps/web` | `apps/api` (unchanged) — Companion can trigger it by opening the browser to the existing web `/stream` connect flow | none yet | Yes, indirectly | The step downstream (code exchange) needs `client_secret` regardless, so there's no benefit to relocating just the redirect |
| 2. Token exchange (code → access+refresh) | `apps/api` | `apps/api` (unchanged) | `client_secret` + `code` | **Yes** | Twitch's authorization-code grant is confidential-client-only per current registration; no PKCE, no public-client option for this grant type (§3.2) |
| 3. Token refresh | `apps/api` | `apps/api` (unchanged) | `client_secret` + `refresh_token` | **Yes** | Same grant-type constraint — refresh requires the secret under the current (confidential) app registration |
| 4. Token storage | Postgres `stream_twitch_links` | Postgres (unchanged) | `refresh_token` (long-lived) | **Yes** | A long-lived refresh token is a standing credential; keeping it server-side avoids exposing it to a less-trusted desktop environment (no confirmed OS-keychain-backed storage in Companion today) |
| 5. EventSub WebSocket connect/subscribe | `apps/api` (`twitch-eventsub-chat.ts`) | **Candidate: Companion**, using a short-lived user access token handed to it (never the refresh token) | short-lived user access token | **No**, per §3.2 — connecting/subscribing needs no secret | Removes the realtime relay hop (`Twitch → apps/api → poll → Companion`) that exists only because the backend happens to hold the WS session, not because it must |
| 6. Chat read | `apps/api` buffers, Companion polls 1.5s | If #5 moves: direct, no relay | none extra | No, contingent on #5 | The polling hop disappears entirely once Companion owns the WS session |
| 7. Chat send | Not implemented | N/A | n/a | n/a | Confirmed absent from the codebase, not part of this audit's scope |
| 8. TTS trigger | Companion, local | Unchanged | n/a | No | Already fully local, unaffected either way (WK-110 §2.7) |
| 9. Reconnect/recovery | `apps/api` (`reconnecting`/`reauth_required` states) | If #5 moves: Companion, mirroring its own already-proven OBS/GSI reconnect patterns | short-lived access token | No | Companion already owns comparable local reconnect state machines |

## 3.4 What this means — explicitly not a decision to migrate yet

`client_secret` genuinely gates step 2 and 3 (token exchange and refresh) under Twitch's current
supported grant types — those stay backend-owned, full stop; there is no secure way to move them
into a distributed desktop binary today without switching to Device Code Grant, which is itself an
unreviewed decision with real UX and re-registration consequences and is **out of scope for this
document**.

Steps 5/6/9 (EventSub connect, chat read, reconnect) do **not** structurally require the backend —
Twitch's own docs confirm WebSocket auth uses a user token, not the secret. Moving them to Companion
is architecturally sound *if* the backend hands Companion a short-lived access token (refreshed
server-side, delivered over the existing `companion_token`-authenticated channel — the same trust
boundary Companion already uses for everything else) rather than the refresh token itself.

**This document does not implement that move.** Per the explicit correction: "не начинай Twitch
migration, пока эти вопросы не подтверждены" — the facts above are now confirmed against both code
and current Twitch docs, but the actual migration (issuing scoped short-lived tokens to Companion,
building the Rust EventSub client, handling reconnect/reauth locally) is real, security-relevant
work that belongs in its own reviewed ticket (§8, roadmap item G), not bundled into this audit.

## 3.5 Steam and DonationAlerts — brief treatment

Both are currently 100% `apps/api`/web-mediated, zero Companion code:

- **Steam**: OpenID 2.0 "dumb consumer" flow (`apps/api/src/services/steam-openid-service.ts`), not
  OAuth2 — no client secret involved, but does require a stable, pre-configured realm/return URL
  server-side (`env.steamOpenidRealm`/`env.steamOpenidReturnUrl`). Whether a desktop app can safely
  run its own OpenID return-URL handling (vs. keeping the backend as the fixed, stable realm) is an
  open question this document does not resolve — flagged as a roadmap follow-up, not decided here.
- **DonationAlerts**: structurally identical OAuth integration to Twitch
  (`apps/api/src/services/donation-alerts-integration-service.ts`) — the same "confidential client,
  secret gates exchange/refresh, but that says nothing about downstream data delivery" question
  applies, unaudited in this pass (lower priority — no Companion runtime dependency on it today).

---

# 4. Corrections

## 4.1 Current state

100% web-dashboard-only, confirmed no Companion call site
(`grep -rn "correctStreamMatch|applyAbsoluteRatingCorrection" apps/companion` → zero matches).
Two UI surfaces: `RecentMatchesPanel` and `QuickMatchPanel`
(`apps/web/src/components/pages/stream/settings/`), both calling
`PATCH /account/me/matches/:matchId` (JWT-gated).

## 4.2 Target, per the correction

The correction is explicit: corrections do **not** need a local SQLite/outbox pipeline just because
session/match state has one. A correction is an account/server-owned operation on server-of-record
data (`stream_matches` in Postgres) — a direct API write from Companion is fully appropriate:

```
Companion UI (new "Исправить" action on Recent Matches)
  → new companion-token-gated endpoint mirroring /account/me/matches/:matchId's PATCH,
    the same pattern already used for /companion/session/reset and /companion/session/end
    (both companion-token-authenticated parallels to JWT-gated /account/session* routes)
  → apps/api's existing correctStreamMatch/applyAbsoluteRatingCorrection service (unchanged)
```

`Why backend required?` — Yes: this mutates the server-of-record match/session rows that the
overlay, web dashboard, and any future mobile remote all read; it's exactly the "shared/server-owned
state" justification from the correction's own list. What's local-first about this slice is only
that the result already flows back into Companion's local mirror for free — `sync.rs`'s
`pull_corrections`/`apply_one_correction` (built in WK-113) already reconciles a server-side
correction into `LocalMatch` without touching `detected_rating_delta`. No new local durable state is
needed; only a new companion-token-gated route and a Companion-side UI action.

---

# 5. Sync visibility

`local_runtime::sync`'s outbox (`sync_outbox` table — `id, entity_type, event_type, attempts,
delivered_at, failed_at, last_error, next_attempt_at`, WK-113) is fully implemented and already
governs real production sync (drain every 2s, exponential backoff, dead-lettering on 4xx, 7-day
retention purge). It has **zero UI surface** today — no Tauri command exposes outbox row counts or
failure state to the frontend at all (`get_local_session_summary`'s own doc comment explicitly says
"never touches sync/outbox"). `describeBackendStatus()` shows only a static, count-free string when
the backend is unreachable.

This is not new local-first infrastructure — it's an observability gap in something that already
shipped, and it's exactly what the original brief's §17 asked for (nothing when healthy, a pending
count, an offline message, a dead-letter surface backed by Diagnostics detail). §7 below is this
document's implemented first slice.

---

# 6. Mobile-web boundary

From the `/stream` dashboard feature inventory, phone-glance/act candidates vs. desktop-only:

| Feature | Phone-friendly? | Why |
|---|---|---|
| Header status chips (Companion online, Steam connected) | Yes | Pure glance status |
| Broadcast bar (current OBS scene + auto-switch indicator) | Yes | Pure glance status |
| QuickMatchPanel (last match correct/discard) | Yes | One card, few buttons |
| RecentMatchesPanel (list + correction) | Borderline | List is glanceable; correction form could become a mobile action sheet |
| Overlay Editor (drag/resize canvas) | No | Full desktop editing surface |
| Queue Widgets Panel (webcam/socials forms) | No | Long-form desktop config |
| OBS Test Mode, Overlay URL/setup guide | No | Config tasks tied to the physical OBS install on that PC |
| Stream Onboarding | No | One-time desktop setup flow |

No standalone Twitch chat viewer or TTS controls exist on the web dashboard today — those already
live entirely in Companion (`TwitchChatPage.tsx`, `sounds/`), consistent with WK-110.

`Why backend required (for a future mobile remote)?` — genuinely yes, but for a reason distinct
from everything else in this document: a phone is a **different device** than the one running
Companion, so per the correction's own criterion ("multi-device/server-owned requirement"), reaching
Companion's local state from a phone requires *some* relay — `Phone ↔ apps/api ↔ Companion` — this
is not a local-first-vs-backend question, it's inherent to cross-device access. Scoping that
relay's shape (poll vs. push, what subset of state, auth model) is a separate future ticket, not
resolved here — the correction explicitly warned against conflating it with the current migration's
scope.

---

# 7. Implemented in this ticket: sync visibility indicator

Following the "audit, then ship one safe vertical slice" pattern WK-110→WK-111 established, and
because §5 above is fully scoped, low-risk, and additive (no new backend calls, no new local
durable state — pure UI over an already-shipped mechanism):

- New Tauri command `get_sync_outbox_status`, querying `sync_outbox` for pending count
  (`delivered_at IS NULL AND failed_at IS NULL`) and dead-lettered count (`failed_at IS NOT NULL`).
- `ProblemBar` (the existing "only show real problems" surface from WK-114) gains: a pending-count
  suffix on the existing backend-unavailable warning, and a new dead-letter warning pointing to
  Диагностика for detail — matching the original brief's exact healthy/pending/offline/dead-letter
  states without introducing a separate always-visible sync card.
- `BackendStatusPanel` (Диагностика detail view) gains the same counts plus the most recent
  dead-letter error, for the "ProblemBar + Diagnostics details" requirement.

See the accompanying commit for the implementation and tests.

---

# 8. Roadmap (dependency-ordered, revised from the original brief per this audit's findings)

Unlike the original brief's assumption, items A–C below (local durable runtime, OBS-driven
lifecycle, backend sync) are **already shipped** (WK-111–116) — not upcoming work. Remaining work,
ordered by dependency:

1. **(this ticket, WK-119)** — audit + sync visibility indicator. Done.
2. **BroadcastState de-duplication** — shared GSI→scene test fixture consumed by both the Rust and
   TypeScript resolvers (§1.2). Small, safe, no product-visible change.
3. **Corrections in Companion** — new companion-token-gated correction endpoint + Companion UI
   action (§4.2). No local schema change needed; reuses existing `pull_corrections`.
4. **Local overlay server** — Companion-hosted `127.0.0.1:<port>/overlay`, loopback-only, serving
   the already-shared `OverlayCanvas`/`AnchoredWidget` rendering logic extracted from `apps/web`
   into a form Companion's webview (or a lightweight local web server) can also serve (§1.4). This
   is the largest, highest-risk remaining item — needs its own design pass for the renderer
   extraction mechanics (React inside Tauri vs. a served static bundle) before a plan is written.
5. **Unified "Оформление" editor shell in Companion** — depends on #4 (preview must render via the
   same code path as the real local overlay) and needs new position-editability for Between
   Matches/PostStream, which have never had any (§1.3).
6. **Auth UI in Companion** — native login/register form calling `/stream/auth/*` directly (§2.2);
   independent of the items above, can ship any time.
7. **Twitch EventSub-in-Companion** — blocked on a dedicated security-reviewed ticket that designs
   the short-lived-token hand-off from `apps/api` to Companion (§3.4); the OAuth/token-exchange/
   refresh legs stay backend-owned permanently.
8. **Steam/DonationAlerts UI relocation to Companion** (browser-open pattern, same as Twitch's
   authorization step) — independent, lower priority, Steam's realm/return-URL question (§3.5)
   needs a short follow-up audit first.
9. **Mobile remote** — requirements/topology definition first (§6); explicitly not to be conflated
   with or used to justify scope in any of the above.

---

# Sources

- `docs/research/wk-110-local-first-audit.md` — the local-first runtime/session/MMR/OBS-lifecycle
  audit this document continues from; WK-111 through WK-118 implemented its findings.
- Code read directly for every citation above: `apps/web/src/components/pages/overlay/**`,
  `apps/web/src/components/pages/stream/**`, `apps/web/src/entities/stream-overlay-layout/**`,
  `apps/api/src/controllers/stream/**`, `apps/api/src/services/twitch-integration-service.ts`,
  `apps/api/src/services/twitch-eventsub-chat.ts`, `apps/api/src/services/steam-openid-service.ts`,
  `apps/companion/src/**`, `apps/companion/src-tauri/src/**`.
- Twitch developer documentation, fetched directly: `dev.twitch.tv/docs/authentication/register-app/`,
  `dev.twitch.tv/docs/authentication/refresh-tokens/`,
  `dev.twitch.tv/docs/eventsub/handling-websocket-events/`,
  `dev.twitch.tv/docs/eventsub/eventsub-subscription-types/`,
  `dev.twitch.tv/docs/api/reference/#send-chat-message`.
- Weeek: WK-119 (#119, this document's ticket), WK-110 (#110), WK-111–118 (#111–#118).
