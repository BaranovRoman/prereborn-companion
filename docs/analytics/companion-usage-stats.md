# Companion usage stats (WK-186)

How Prereborn counts real usage of the desktop Companion, and what the public landing shows.

## Source of activity

The **only** activity source is the authenticated Companion heartbeat. The website, the web
cabinet and plugins do not send heartbeats and the site has no web analytics (no Google
Analytics, Yandex Metrica or visit counters).

- Companion: `apps/companion/src-tauri/src/backend/heartbeat.rs`. One background thread,
  started once in `backend::init` and stopped on app exit. While an account credential
  (session or legacy token) is present, it sends `POST /api/stream/companion/heartbeat` right
  away and then every 15 minutes. A failed send is dropped (no queue, no retry); the next
  attempt is the next scheduled one. Re-login sends promptly, at most once per minute.
- The request has no body. The server records only the account id from the token: no chat,
  game data, IP addresses, hardware ids or app details are stored.
- Plugins cannot declare the heartbeat path as a backend resource
  (`plugins/protocol/src/backend.rs` denies the `heartbeat` segment).
- Companion versions before WK-186 never send heartbeats, so they are never counted as active.
  Nothing is backfilled from other data.

## Storage

Table `companion_activity_days`: one row per account per UTC day
(`stream_user_id`, `activity_date`, `last_seen_at`). Heartbeats upsert that row, so storage is
bounded by accounts × days however often clients ping. Rows older than 90 days are pruned
(at most hourly, from the heartbeat path). Deleting an account deletes its rows.

## Definitions (all UTC)

Activity is counted per unique account, never per request or device.

| Metric | Definition |
| --- | --- |
| Registered users | `COUNT(*)` of `stream_users`. |
| DAU | Distinct accounts with a heartbeat in `(now − 24h, now]`. |
| WAU | Distinct accounts with a heartbeat in `(now − 7 days, now]`. |
| MAU | Distinct accounts with a heartbeat in `(now − 30 days, now]`. |
| Average DAU (30d) | Sum over the last 30 **full** UTC calendar days (`today − 30` … `today − 1`, today excluded) of the distinct accounts active that day, divided by 30, rounded to 0.1. |

DAU/WAU/MAU are exact rolling windows. Average DAU uses calendar days. Both are deliberate and
kept separate.

## Endpoints

- `POST /api/stream/companion/heartbeat`: Companion auth (session JWT or legacy companion
  token). `204` on success, `401` without valid auth or for a deleted account. Rate limited per IP.
- `GET /api/public/usage-stats`: public and read-only. Returns
  `{ registeredUsers, activeUsers7d, activeUsers30d, ready, generatedAt }` and nothing else.
  Cached for 5 minutes in the API (`Cache-Control: public, max-age=300`). If a refresh fails it
  serves the last good value. If none exists it returns `503`, never zeros. Rate limited per IP.
- `GET /api/admin/usage-stats`: admins only. Returns all metrics above plus `trackingSince`,
  `trackedFullDays` and the average-DAU date range.

## Public block on prereborn.ru

The landing (`apps/web/src/components/pages/landing/UsageStats.tsx`) shows registered users,
active in 7 days and active in 30 days, and only when `ready` is true. `ready` becomes true
once heartbeats have been collected for at least 30 full UTC days, so the 30-day number is
never an undercount of a window tracking didn't cover. While loading, on any error, or before
`ready`, the block isn't rendered at all.
