# Twitch viewer-experience discovery (WK-54)

## Current integration (baseline)

- **OAuth scopes already granted** by every connected streamer: `user:read:chat`,
  `channel:read:subscriptions`, `moderator:read:followers` (`apps/api/src/controllers/stream/twitch.ts`).
- **Chat**: read-only, via EventSub WebSocket (`channel.chat.message` v1), one
  session per linked streamer (`apps/api/src/services/twitch-eventsub-chat.ts`).
  No send capability anywhere.
- **Helix polling**: `helix/users`, `helix/subscriptions`, `helix/channels/followers`,
  `helix/streams` — cached in-memory, process-local (`twitch-integration-service.ts`).
- **Already public**: chat, live title/viewer count, subscriber and follower
  counts are already rendered on the public overlay
  (`apps/web/src/components/pages/stream/queue/queue-scene-ui.tsx`) — this is
  not a companion/dashboard-only feature today.
- **Tokens**: plaintext columns in `stream_twitch_links` (access/refresh/expiry);
  refresh is proactive (60s-before-expiry) via `getTwitchUserToken`.
- No dedicated integration doc existed before this one.

## Candidate scenarios researched against official docs

| Scenario | EventSub type | Scope needed | New scope? |
|---|---|---|---|
| Follow alerts | `channel.follow` v2 | `moderator:read:followers` | **No — already granted** |
| New/gifted subscriber alerts | `channel.subscribe` v1 / `channel.subscription.gift` v1 | `channel:read:subscriptions` | **No — already granted** |
| Raid alerts | `channel.raid` v1 | none (public event) | **No — no auth at all** |
| Channel Points redemption alerts | `channel.channel_points_custom_reward_redemption.add` v1 | `channel:read:redemptions` | Yes, new |
| Polls | `channel.poll.begin/progress/end` v1 | `channel:read:polls` | Yes, new |
| Predictions | `channel.prediction.*` v1 | `channel:read:predictions` | Yes, new |
| Hype Train | `channel.hype_train.begin/progress/end` v2 | (not specified in current docs snapshot — verify at implementation time) | Likely yes |
| Cheer/bits alerts | `channel.cheer` v1 | `bits:read` | Yes, new (financial-adjacent) |

All entries confirmed against `dev.twitch.tv/docs/eventsub/eventsub-subscription-types`
and `dev.twitch.tv/docs/authentication/scopes` (fetched 2026-08-17; see Sources).

## Recommended 1–3 scenarios for this beta round

1. **Follow alerts** (`channel.follow` v2)
2. **Subscribe / gifted-sub alerts** (`channel.subscribe` v1, `channel.subscription.gift` v1)
3. **Raid alerts** (`channel.raid` v1)

Why these three: **zero new OAuth scopes** for #1–2, **zero auth at all** for
#3 — meaning no re-consent screen for any already-connected streamer, no new
line item in the privacy/permissions story, and all three plug into the
*same* EventSub WebSocket session already open for chat (see limits below),
so the engineering cost is "add subscription types," not "build new
infrastructure." They also most directly serve "viewer experience" as
framed by the ticket — a viewer's own follow/sub/raid gets visible, real-time
recognition on stream.

**Deliberately not recommended for this round** (real scenarios, just not
now): Channel Points, Polls, Predictions, Hype Train, Cheer. Each needs a
**new** scope grant — meaning every already-connected streamer must
re-authorize — and several depend on Affiliate/Partner-only Twitch features
that aren't guaranteed to be available to every beta streamer. Bigger
scope-and-trust cost for uncertain reach in a small beta population.

## Rate limits / connection limits (confirmed via docs)

- Helix: token-bucket, ~800 points/min is the commonly cited default (the
  official guide describes the mechanism and response headers —
  `Ratelimit-Limit`/`Ratelimit-Remaining`/`Ratelimit-Reset` — without
  printing one universal number in the page itself; 800 is corroborated
  across Twitch's own developer forum threads). Implementation should read
  the header rather than hardcode a constant.
- EventSub WebSocket: max **3 connections** per `(client_id, user_id)` pair,
  max **300 subscriptions per connection**, max **total cost 10** per
  connection. The existing one-connection-per-streamer chat session has
  trivial headroom to add follow/subscribe/gift/raid subscriptions without
  opening a second connection.
- A new connection must get its first subscription within **10 seconds** or
  Twitch closes it — already satisfied by the existing chat-connect flow;
  worth re-verifying once more subscription types are added to the same
  handshake.

## Token lifecycle (confirmed via docs)

- This is a confidential client (server holds `client_secret`), so refresh
  tokens do **not** carry the 30-day expiry that public clients get.
- Twitch's own guidance is to react to HTTP 401 rather than predict expiry;
  the current proactive 60s-early refresh is a reasonable belt-and-suspenders
  addition on top of that, not a deviation from it.
- Refresh tokens **rotate on every use** — the response to a refresh call
  contains a new refresh token that must be persisted. Current code
  reportedly updates the DB row on successful refresh; implementer should
  confirm the new `refresh_token` specifically (not just the access token)
  is what gets persisted before building on top of this.

## Risks and fallback

- A failed subscribe for one new event type must not tear down the shared
  chat WebSocket session — verify per-type subscription errors are isolated,
  not fatal to the connection, when implementing.
- Non-Affiliate/Partner channels simply never fire subscribe/gift events
  (no subscribers possible) — a safe no-op, not an error state to special-case.
- No new category of viewer data is collected: follow/sub/raid events surface
  the same class of information (a known viewer's public action) already
  shown via existing chat/subscriber/follower displays — consistent with the
  ticket's "no excess viewer data" boundary.

## Decomposition (future tickets — not built here)

1. Extend `TwitchEventSubChatClient` (or a sibling) to also subscribe to
   `channel.follow` / `channel.subscribe` / `channel.subscription.gift` /
   `channel.raid` on the existing per-streamer WebSocket session — no new
   scope, no re-consent flow.
2. Add a generic "recent events" feed alongside the existing chat-message
   cache (same in-memory, capped pattern).
3. Add an overlay alert widget, reusing the existing widget patterns in
   `queue-scene-ui.tsx`.
4. Defer Channel Points / Polls / Predictions / Hype Train / Cheer to a
   later ticket, gated on (a) confirming the beta streamer population's
   Affiliate/Partner status and (b) an explicit product decision to prompt
   existing users to re-consent for a new scope.

## Out of scope (per ticket)

Implementing any of the above (discovery only), unofficial/reverse-engineered
Twitch APIs (deprecated IRC/PubSub paths, undocumented endpoints), and
collecting any viewer data beyond what's already shown publicly today.

## Sources

- [OAuth Scopes](https://dev.twitch.tv/docs/authentication/scopes/)
- [Refreshing Access Tokens](https://dev.twitch.tv/docs/authentication/refresh-tokens/)
- [EventSub Subscription Types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Twitch API Guide (rate limits)](https://dev.twitch.tv/docs/api/guide/)
- [Handling WebSocket Events (EventSub connection/subscription limits)](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [Twitch Developer Forum — Helix API rate limits](https://discuss.dev.twitch.com/t/helix-api-rate-limits/24854)
- [Twitch Developer Forum — Channel Points redemption EventSub scope](https://discuss.dev.twitch.com/t/receiving-data-from-channel-point-redeems-via-eventsub/63558)
