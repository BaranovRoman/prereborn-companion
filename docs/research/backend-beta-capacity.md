# Backend public-beta capacity research (WK-55)

## Architecture and load

Production is nginx to one Express/Node PM2 fork (500 MB restart) plus one Next.js process. PostgreSQL is local; pg pool max is 20, connect timeout 2 s, idle timeout 30 s. Redis is absent. OBS mailboxes, Dota cooldowns, Twitch EventSub clients/messages and caches are process-local.

Overlay HTTP polling runs immediately then 1.5 s after completion; dashboards reuse it. Companion sends changed GSI at most ~1/s and polls commands 1/s. GSI upserts one JSONB row/user. Twitch chat is one EventSub client/linked active user, messages capped at 40.

Per streamer with one overlay: overlay ~0.67 req/s, commands 1 req/s, changed GSI up to 1 req/s, modeled dashboard 0.2 req/s. Extra overlays add ~0.67 req/s.

## Reproducible mixed load

The local-only `apps/api/scripts/beta-load.mjs` models multiple streamers, overlays, Companion command/GSI and dashboard traffic. It rejects non-local BASE_URL.

```bash
BASE_URL=http://127.0.0.1:5102 PHASE_SECONDS=30 SCALES=1,2,4 node apps/api/scripts/beta-load.mjs /tmp/prereborn-beta-fixture.json
```

Fixture: `{"streamers":[{"publicToken":"uuid","companionToken":"secret","accessToken":"jwt"}]}`. Output: throughput, p50/p95/max and errors/path. Use disposable accounts and collect PM2 CPU/RSS plus PostgreSQL activity/pool wait on target-like staging.

## Audit findings

- Overlay uses bounded indexed reads for user/session, companion, layout, queue, integrations and recent matches (limit <=20). Token, active-session/match and history predicates have suitable indexes.
- Pre-fix every 1.5 s poll called Twitch live status and DonationAlerts. Twitch issued Helix streams; DonationAlerts could page history and aggregate donors.
- GSI is capped 256 KiB, sanitized/stringified, upserts state, throttles actual presence changes to five seconds, then processes matches asynchronously.
- Companion commands do DB token/presence work each second; mailbox is one entry/user.
- Twitch messages are capped. Per-user maps clear on disconnect but otherwise live for process lifetime: acceptable only for small beta.
- Donation history grows with real donations, not polls. Sequential backfill is future work only if measured poorly with large histories.
- No obvious collection N+1 or unbounded query was found.
- No overlay IP limiter was added due OBS/NAT false-positive risk; confirmed amplification was fixed instead.

## Measurements

Windows workstation, Node 24.18.0, pnpm 10.28.0. PostgreSQL was reachable but configured credentials were unavailable, so DB-backed load and production VDS CPU/RAM were not measured or inferred.

Focused synthetic burst used real overlay integration orchestration with mocked Twitch/DonationAlerts delayed 20 ms.

| Measurement | Before | After |
| --- | ---: | ---: |
| concurrent callers | 20 | 20 |
| Twitch executions | 20 | 1 |
| DonationAlerts executions | 20 | 1 |
| completed/errors | 20/0 | 20/0 |
| post-fix wall time | not retained | 23 ms |

Pre-fix assertions observed 20/20. Post-fix passes and verifies reuse. 23 ms is synthetic, not VDS latency.

## Bottleneck and fix

External work scaled per overlay/tab rather than streamer. A 15 s per-streamer snapshot plus single-flight shares concurrent misses. Cache is capped at 500 streamers with oldest eviction; expiry is on access and failures clear in finally. Public JSON is unchanged.

Continuous viewing now causes at most ~4 integration refreshes/minute instead of ~40 (10x fewer); simultaneous overlays reuse it.

## Safe beta capacity and assumptions

No exact capacity is claimed without target PostgreSQL/VDS measurement. Conservative starting envelope: **5-10 concurrent active streamers**, assuming one Companion, 1-2 overlay/dashboard consumers, changed GSI <=1/s, current single API/local PostgreSQL pool 20, small histories, normal integrations and no deliberate abuse.

Ten streamers with one overlay model roughly 29 client req/s before occasional actions. This is assumption-based, not saturation. PostgreSQL latency/pool wait is the likely next bottleneck because overlay still assembles several indexed queries/poll.

Before expansion, run the harness on target-like staging and stop increasing when p95 SLO fails, errors appear, pool wait grows, or CPU/RSS fails to recover.

## Remaining limitations and recommendations

Measure exact SQL latency/count and pool saturation with real PostgreSQL. Do not combine queries without timing evidence. Watch GSI serialization/match queries with large changing payloads. Process-local EventSub/mailboxes/caches/rate limits need redesign only before multiple API instances. Large DonationAlerts first backfills may be slow. Redis remains speculative until horizontal-scaling evidence.

## Validation and self-review

Completed: focused 20-way burst/cache-reuse test; API typecheck; static audit of polling, overlay, Companion/GSI, writes, Twitch/EventSub, DonationAlerts, bounds/indexes, pool, Redis, memory, serialization and rate limiting.

DB-backed API tests could not authenticate locally and are environment-deferred, not product failures. Manual UAT/production load are deferred.

Self-review: contract unchanged; failures are not cached; persistent cache capped 500; 15 s staleness affects integrations only; rate limits/session/GSI unchanged; no speculative architecture.
