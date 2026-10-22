# PUBG widget latency (WK-183 follow-up, 2026-10-22)

## Question
On a real stream (plugin 0.1.2) two matches reached the OBS widget long after they ended:

| Match | Finished (stream minute) | In the widget | Delay |
|---|---|---|---|
| 1 (Erangel) | 6 | 32 | 26 min |
| 2 | 22 | 38 | 16 min |

Where is this time spent, can it be reconstructed for these two matches, and what can
realistically make detection faster without breaking PUBG API rules?

## Current state
The chain, with what each step can add (from code, `codex/plugin-runtime-prototype` @ `307aeba`):

1. **PUBG** lists the match in `GET /shards/{platform}/players?filter[playerNames]=` →
   `relationships.matches`. Our backend calls it on demand, cached per player for 60 s
   (`PLAYER_TTL_MS`), at most 8 calls/min for the whole server (`PLAYER_CALLS_PER_MINUTE`, key
   limit is 10 RPM). Match details (`/matches/{id}`, not rate limited) are fetched once, then
   cached forever.
2. **Backend** answers within a 600 ms budget with whatever is cached and keeps refreshing in the
   background (`complete: false` when details are still missing). A refresh that takes longer
   than the budget is only visible to the *next* request. Single API process (`ecosystem.config.cjs`,
   `instances: 1`), so the cache is shared. No rate limiter on `/stream/integrations/pubg/matches`.
3. **Companion host** calls the worker's `host.poll` every ~50 ms; the HTTP call runs off the IPC
   thread with a 1 s timeout (500 ms connect), no caching (`PendingRequest` reuses a result only
   for the same `operation_key`, and the plugin numbers every request).
4. **Plugin** plans the next request: 60 s after a complete answer, 5 s while `complete: false`,
   90 s after `rate_limited`, 5 min after `not_configured`/`player_not_found`, and an exponential
   backoff 15 s → 30 → 60 → 120 → 240 → 300 s after transport/HTTP failures (reset by the next
   success).
5. **Widget**: the worker republishes on every change; the OBS page polls `/pubg/widget/state`
   every 2 s.

The plugin does not fetch telemetry at all: telemetry is only reachable through the match
object, after the match is listed, so it cannot be earlier than step 1.

## Findings
**Confirmed (code):**
- Steps 2–5 in normal operation add, by design, about 1–3 min after PUBG lists a match:
  ≤ 60 s plugin interval + ≤ 60 s player TTL, and when the PUBG player call takes longer than the
  600 ms budget the list refreshes only every second request (~120 s). Estimated from code,
  **not measured**.
- Larger delays on our side are only possible in abnormal states: repeated transport/HTTP failures
  (backoff up to 5 min per attempt, e.g. a slow link making the 1 s host timeout fail), the server
  rate limit (`rate_limited` → 90 s), or the plugin/Companion not running. In 0.1.2 none of this is
  recorded anywhere; the UI only shows the current `apiStatus`.
- The two measured delays differ by 10 min (26 vs 16), and the widget showed the matches 6 min
  apart although they finished 16 min apart. A constant pipeline delay would not do that; a
  variable component exists somewhere. Which one is **not known**.

**Not recoverable from existing data:**
- When PUBG first listed these two matches: PUBG exposes no "listed at" time, and neither the
  plugin nor the backend stored when they first saw a match. Plugin history keeps only
  `createdAt` + `durationSec` (the exact finish time is known; first sighting is not).
- Backend debug request logs are off in production; responses were never logged.
- **Partly recoverable**, if the server still has the access log of that day: nginx logs every
  `GET /api/stream/integrations/pubg/matches?...&player=<nick>` with time, status and response size.
  The first request whose size grows shows when *our backend* first returned the match; PUBG
  listed it at most ~1–2 min before that. Gaps over ~70 s between requests show backoff or
  Companion being off. Command (on the server):

  ```bash
  zgrep -h 'integrations/pubg/matches' /var/www/httpd-logs/prereborn.ru.access.log* \
    | grep -i 'player=<NICK>' | awk '{print $4, $9, $10}' | sort
  ```

- So it is **not confirmed that the PUBG API is the cause**. Public sources show no documented
  listing delay, only a past outage in which PUBG stopped reporting new matches.

**PUBG API (official docs):** 10 requests/min per key by default; `/matches` and telemetry are not
rate limited; players can be requested in batches of up to 10 per call; a higher limit can be
requested in "My Apps" with a working app and a description of its caching. No push/webhook
mechanism; `samples` are ≥ 24 h old. There is no official way to learn about a match before it
appears in the player's match list.

## Diagnostics added (this change, not deployed or released)
- **Backend** (`pubg-match-service.ts`, needs a production deploy from `main`):
  - `pubg.player` log line per PUBG player call: duration, `X-RateLimit-Remaining`, new match ids,
    previous fetch time.
  - `pubg.match` line per match details call: duration, finish time, seconds since finish.
  - The response gains `timing` = `{playerFetchedAt, matches: [{id, listedAfter, listedAt,
    detailsAt}]}`: PUBG listed the match in `(listedAfter, listedAt]`. Plugins up to 0.1.2 ignore
    the field.
- **Plugin** (needs a release): `%APPDATA%\com.romanbaranov.dota-companion\plugins\data\pubg\diagnostics.log`,
  JSON lines, 256 KB + one rotated file. Events: `request` (seq), `response` (latency, HTTP
  status/error, apiStatus, complete, new ids, backend `playerFetchedAt`), `match_added` (finish
  time, `sinceFinishSec` by the PC clock, in session, backend `listedAfter/listedAt/detailsAt`),
  `widget_published` (new ids in the projection) and `widget_served` (first read of that state by
  an open widget page).

With both deployed, one match splits into: finish → PUBG listing (bounded by
`listedAfter..listedAt`) → backend details → plugin receives it → widget publishes → OBS reads it.

## Options
1. **Tighten our pipeline (small, low risk):** while a session is active, plugin interval 60 → 15 s;
   backend player TTL 60 → 15–20 s; answer from the refreshed list when it arrives within the
   budget. Our part drops from ~1–3 min to ~15–40 s. Limit: the server shares 8 player calls/min,
   so this alone serves ≈ 2–4 concurrent streamers.
2. **Batched server-side poller:** one loop per platform asks `/players?filter[playerIds]=` for up to
   10 active players (requested in the last ~2 min) per call, every ~10 s. Keeps ≤ 6 RPM for ≤ 10
   players, about a 20 s cycle for 20. Moderate work (account ids, active set, fairness), and it
   scales with users.
3. **Higher PUBG rate limit:** free, but needs an application to PUBG and their approval. Combines
   with 1 or 2.
4. **Anything faster than PUBG's own listing:** not available through official means (no push,
   telemetry and details hang off the listed match). Reading the game client, its files or memory
   is excluded by WK-183.

## Recommendation
1. Measure first: deploy the backend diagnostics, release the plugin diagnostics, play 2–3 matches
   on stream, then read `diagnostics.log` + the `pubg.player`/`pubg.match` server lines. In parallel,
   check the nginx access log for the stream already played (command above).
2. Implement option 1 regardless: it removes up to ~2–3 min of our own delay at low risk.
3. Take option 2 (and apply for 3) only if users grow beyond a few concurrent streamers.
4. If the measurements show PUBG itself lists matches 10+ minutes after they end, no official
   mechanism can beat that; the widget should then say so ("результат появляется через N минут
   после матча") instead of looking broken.

Expected outcome if PUBG lists matches quickly: a match in the widget within ~1 min of its finish.
If PUBG lags, the delay becomes PUBG's lag plus ≤ 40 s.

## Follow-up
- Deploy the API diagnostics (PR to `main`) and release the plugin diagnostics (next plugin version).
- After a measured stream: decide on option 1 vs 1 + 2, and the editor (second part of the task)
  continues independently.

## Sources
- [PUBG API — Rate Limits](https://documentation.pubg.com/en/rate-limits.html)
- [PUBG API — Getting Started (batches of up to 10 players)](https://documentation.pubg.com/en/getting-started.html)
- [PUBG API — Making Requests (14-day match retention)](https://documentation.pubg.com/en/making-requests.html)
- [PUBG API changelog](https://github.com/pubg/api-documentation-content/blob/master/rst/changelog/changelog.rst)
- [PUBG Lookup: delayed reporting from the PUBG API (Oct 2023 outage)](https://pubglookup.com/news/status-delayed-reporting-pubg-api)
