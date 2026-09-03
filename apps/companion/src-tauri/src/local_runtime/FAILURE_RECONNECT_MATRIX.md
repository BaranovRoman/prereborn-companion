# Companion failure/reconnect scenario matrix (WK-130)

Replaces WK-57 (cancelled, original text preserved there). Documents Companion's
**actual current behavior** — verified against the code, not aspirational — for
the 10 scenarios that matter most once a stream is live: OBS talks to
Companion over two independent WebSockets, GSI/backend/overlay-server are each
their own listener/loop, and local session/match state lives in SQLite
independent of all of them. The goal is a single reference for what happens
when one piece drops, not a redesign.

Every "automatic" row below is backed by a real test — see the file:line
citations. Two genuine gaps were found (not asserted by any test); both are
called out at the bottom with the follow-up tickets filed against them, per
this ticket's own scope ("не переписывать все подсистемы сразу").

| # | Scenario | Continues working | Degrades | Auto-recovers via | Timeout/grace | User action | Data-loss guarantee |
|---|---|---|---|---|---|---|---|
| 1 | OBS disconnect/reconnect | GSI, backend sync, local SQLite, overlay server (all independent) | Scene automation, `obs_streaming` truth | Two separate reconnect loops: scene-switch probe (10s interval, `obs.rs:233-234`) and streaming-truth watcher (always-on since WK-116, `obs.rs:1002-1015`) — both capped exponential backoff, 30s cap (`obs.rs:189-191`) | Watcher read timeout 20s (`obs.rs:988`) — was unbounded before the WK-122 P0 fix | None | LocalSession creation never depends on this connection being alive (`obs.rs:997-999`) |
| 2 | OBS stopped/started | Same as #1 | Both OBS sockets drop | `lifecycle::decide`'s pending-end countdown (`lifecycle.rs:99-147`) — a brief restart isn't mistaken for stream end | `GRACE_PERIOD=30s` (`lifecycle.rs:36`), swept every 2s (`lifecycle.rs:45`) | None | SQLite transition commits before any OBS-side effect (`lifecycle.rs:149-153`) |
| 3 | GSI silence/recovery | Everything else (OBS, backend, overlay all independent loops) | `gsi_state` → Recovering after 10s (`state.rs:302`); UI treats a bound-but-silent listener as healthy (`runtime_health.rs:183-193`) | Resumes the instant Dota posts again — the listener never stops | GSI bind-retry 30s cap (`server/mod.rs:60-62`) | None for transport | **Gap** — see below |
| 4 | Backend unavailable/recovery | GSI, OBS, local SQLite (backend-independent by design) | GSI-forwarding heartbeat, durable sync outbox, overlay-layout/queue polls | Two independent backoff loops (`backend/mod.rs:39-46`, `sync.rs:51-53}`); `record_connectivity` fed by every backend call site, not just the heartbeat (`backend/mod.rs:59-69`) | 5s request timeout; heartbeat cap 30s/5 attempts; outbox cap 60s/6 attempts | None (transient); re-login only if the session itself was revoked | Outbox `enqueue` commits in the *same* SQLite transaction as the entity mutation (`sync.rs:10-16`) — atomic by construction |
| 5 | Twitch disconnect/reconnect | Everything — Companion only polls a backend cache, never holds its own Twitch connection | `twitch_component` surfaces `reconnecting`/`unavailable` from the cached status (`runtime_health.rs:293-309`) | N/A on Companion's side — reconnect logic lives in apps/api | 1.5s poll interval, 5s HTTP timeout (`useTwitchChatSession.ts:383`) | `reauth_required` needs a re-link via the web dashboard | Local chat cache capped at 50 messages (`backend/mod.rs:1148-1178`), not a durable log |
| 6 | Local overlay HTTP failure (:3666) | GSI, OBS, backend sync (separate port/thread) | OBS Browser Source renders stale/nothing | Bind-retry loop identical in shape to GSI's (`overlay_server.rs:144-146`) | 30s backoff cap; live TCP probe each health check (`runtime_health.rs:225-231`) | Only if the port is permanently held by something else | N/A — pure read-through projection, nothing durable buffered |
| 7 | Sleep/wake (Windows) | — | — | **No dedicated mechanism exists** | — | — | — |
| 8 | Network disconnect/reconnect | Local-only subsystems (GSI, OBS loopback, overlay loopback, SQLite) | Identical to #4 — indistinguishable from a backend outage at the code level | Same backoff paths as #4 | Same as #4 | None | Same as #4 |
| 9 | Companion crash/restart | N/A (process itself is down) | Everything, briefly | SQLite WAL mode (`schema.rs:198-219`) + atomic outbox commit survive the crash; single-instance guard registered first (`lib.rs:135-160`) prevents a crash-relaunch race from double-opening SQLite or double-binding ports; reconciliation resumes from disk + a fresh `GetStreamStatus`, never an assumed timer | 12h stale threshold and 30s grace apply exactly as they would mid-run | None unless the crash left a session open past 12h (→ #10) | Anything already committed survives; only in-memory-only state (e.g. legacy heartbeat's `dirty` flag) is lost and resumes fresh |
| 10 | Stale LocalSession recovery | Everything else | The affected session only | **Detection** is automatic (`is_stale`, `lifecycle.rs:73-82`, 12h threshold, independent of OBS reachability), **resolution** is deliberately manual — "too ambiguous to auto-continue or auto-end" (`lifecycle.rs:73-75`) | 12h threshold; 3s status poll (`useLocalLifecycle.ts:39`) | Yes — the one scenario where auto-recovery is intentionally not attempted; two explicit commands (`stale_recovery_continue`/`stale_recovery_end`, `lifecycle.rs:374-408`) | Neither action deletes a row; `stale_recovery_end` finalizes through the same path #2 uses |

## Key constants

| Constant | Value | Location |
|---|---|---|
| OBS scene-switch/probe backoff cap / probe interval | 2ⁿs cap 30s / every 10s | `obs.rs:189-191`, `obs.rs:234` |
| OBS watcher read timeout | 20s | `obs.rs:988` |
| Session-lifecycle grace period / sweep interval | 30s / 2s | `local_runtime/lifecycle.rs:36,45` |
| Stale-session threshold | 12h | `local_runtime/lifecycle.rs:40` |
| GSI Connected→Recovering threshold | 10s | `state.rs:302` |
| GSI / overlay-server bind-retry backoff cap | 2ⁿs cap 30s, attempt cap 4 | `server/mod.rs:60-62`, `overlay_server.rs:144-146` |
| Backend send-loop backoff cap / request timeout | 2ⁿs+jitter cap 30s (5 attempts) / 5s | `backend/mod.rs:39-46,31,10` |
| Sync outbox retry backoff cap / drain interval | 2ⁿs cap 60s (6 attempts) / 2s | `local_runtime/sync.rs:51-53,33` |
| Match reconnect window (GSI leave/rejoin) | 5 min | `local_runtime/detector.rs:8-10` |
| Twitch chat poll interval | 1.5s | `useTwitchChatSession.ts:383` |

## Gaps found (not covered by any test — filed, not fixed here)

Per this ticket's own scope ("задача в первую очередь research/tests/documentation
- не переписывать все подсистемы сразу... заводить отдельные конкретные
bug-задачи только для реально найденных gaps"), both gaps below are filed as
separate backlog items rather than fixed in this pass — each needs a real
product decision (auto-abandon vs. flag-for-manual-recovery timeout; whether a
Windows-specific power-event API is worth the added surface), not a
mechanical fix.

1. **Scenario 3 - no match-level watchdog for total GSI silence.** `local_runtime::detector::decide_leave` (`detector.rs:53`) only runs when a *new* GSI payload signals the player left the match (called from `handle_snapshot`, `detector.rs:111`). If Dota/GSI goes silent forever mid-match — crash, network cut, no further packet ever arrives — nothing independently times out the `InProgress` local match; it stays open in SQLite until the containing *session* eventually goes stale (12h, scenario 10), which finalizes the session but not the match record itself. Filed as WK-146.
2. **Scenario 7 - no sleep/wake-aware handling.** Confirmed via `grep -rniE "power[_ ]?event|WM_POWERBROADCAST|suspend|resume\(\)|hibernat"` across the whole Rust and TS tree: zero matches. What actually absorbs a sleep/wake cycle today is incidental — the OBS watcher's 20s read timeout (`obs.rs:988`, added by the WK-122 P0 fix, whose own doc comment lists "machine sleep/wake" as one of the triggering causes) and every other subsystem's generic bounded request/poll timeouts. This already gives reasonable resilience in practice (real test: `obs.rs::tests::watcher::a_connection_that_stops_responding_entirely_surfaces_as_an_error_within_one_read_timeout_not_never`), so this is lower urgency than #1. Filed as WK-147 for awareness; not recommended to build a dedicated Windows power-event listener without a concrete production incident motivating it.
