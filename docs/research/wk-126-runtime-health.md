# WK-126 — Diagnostics v2: RuntimeHealth projection

Adds one canonical, read-only health projection over Companion's existing
subsystem state (`src-tauri/src/runtime_health.rs`), used by the Diagnostics
UI (`RuntimeHealthPanel`) and by a new `runtime-report.json` file in the
diagnostics export ZIP. This is explicitly **not** a new state machine — it
only reads state other modules already own and normalizes it into one status
vocabulary.

## Component model

```
RuntimeHealth
  localRuntime { status, gsi, localSession, sqlite, overlayServer }
  integrations { status, obs, obsSceneAutomation, twitch, tts, gameSounds }
  cloud        { status, backend, sync, account }
```

Every leaf is a `HealthComponent { status, reason, lastSuccessAt, lastErrorAt }`.

## Status semantics

| Status | Meaning |
| --- | --- |
| `healthy` | Enabled/expected and working. |
| `degraded` | Working partially, or a transient/recoverable problem. |
| `unavailable` | Expected to be available right now, but is not. |
| `disabled` | Intentionally off by the user, or not configured — never a problem. |
| `unknown` | Not enough data to honestly say any of the above. |

`disabled != unavailable`, `unknown != unavailable`, `degraded != unavailable`
— enforced by construction (each component mapper picks exactly one) and by
the aggregation rule below, not by convention alone.

## Aggregation

A group's `status` is computed by `aggregate()` from `(component, critical)`
pairs, in strict precedence order:

1. any **critical** component `unavailable` → group `unavailable`
2. any **critical** component `degraded` → group `degraded`
3. any **optional** component `unavailable`/`degraded` → group `degraded`
   (an optional failure can never read as a full outage)
4. any **critical** component `unknown` (nothing worse present) → group `unknown`
5. otherwise → `healthy`

`disabled` never affects the group at any criticality. This is pure and unit
tested directly (`runtime_health.rs`'s `tests` module) independent of any
component's real-world mapping.

## Source-of-truth mapping

| Component | Critical when | Source |
| --- | --- | --- |
| `localRuntime.gsi` | always | `AppState::snapshot().gsi_state` (`ConnectionState`) |
| `localRuntime.localSession` | always | `local_runtime::lifecycle::status()` (`LifecycleSessionState`) |
| `localRuntime.sqlite` | always | `LocalRuntimeState`'s `Option<Connection>` being `Some` |
| `localRuntime.overlayServer` | always | a bounded (200ms) loopback TCP probe of `:3666` |
| `integrations.obs` | `obs_config.enabled` | `obs_connected` OR `obs_watcher_connected` (new field — see below) |
| `integrations.obsSceneAutomation` | never | `obs_config.enabled` (a preference, not connectivity) |
| `integrations.twitch` | never | best-effort read of the cached Twitch chat JSON's `configured`/`connected`/`state` |
| `integrations.tts` | never | `silero::status()` (`enabled`, `resourcesReady`, `state`) |
| `integrations.gameSounds` | never | `enabled` only — see gap below |
| `cloud.backend` | always | `AppState::snapshot().backend_state` (already treats 401/403/4xx as connectivity success — unchanged) |
| `cloud.sync` | always | `local_runtime::sync::status()` (`SyncOutboxStatus`) |
| `cloud.account` | never | `backend::account_status()`'s `AccountMethod` |

### New minimal observability added by this ticket

The audit found two real gaps where no existing state answered "is this
actually up" at all:

- **OBS watcher connectivity** (`InnerState.obs_watcher_connected` /
  `obs_watcher_last_error`, `state.rs`): the stream-state watcher
  (`obs.rs::start_stream_state_watcher`) is a *second*, independent OBS
  WebSocket connection that runs unconditionally (WK-116), unlike
  `obs_connected`, which is only ever probed while scene automation is
  enabled. Without this, "OBS connected, automation off" was
  indistinguishable from "never even checked" — these two fields expose the
  watcher's own connectivity truth, set on every observation / on the
  watcher loop's error branch. No new reconnect logic, no new timers.
- **Overlay server bind health**: rather than adding more mutable state to
  `overlay_server.rs` (already carrying its own security-sensitive test
  suite), `runtime_health.rs` does a direct, bounded (200ms) loopback TCP
  connect to `127.0.0.1:3666`. Cheap, same-host, and answers the question
  directly without touching that module at all.

SQLite health needed no new state — `LocalRuntimeState`'s `Option<Connection>`
being `Some`/`None` already *is* the health signal `local_runtime::init`
leaves behind; `runtime_health.rs` just reads it instead of duplicating it.

### Known gaps (left `unknown`, not guessed)

- **Game Sounds**: has no persisted runtime error signal at all today (only
  an `enabled` bool). `enabled=true` reads as `unknown`, never a false
  `healthy` — a follow-up could add a small last-playback-error side channel
  mirroring Silero's shape.
- **Twitch chat**: Companion has no typed local connection state machine —
  the real state lives on the backend, Companion only caches its last JSON
  response. `runtime_health.rs` best-effort-parses `configured`/`connected`/
  `state` from that cache; a never-fetched cache reads `unknown`.
- **Account validity granularity**: `backend::account_status()` only ever
  reports `None` (not configured) or `connected: true` (Session/LegacyToken)
  — a revoked session is *cleared*, not flagged, so there is no distinct
  "configured but invalid" state to project today.

## Cloud: connectivity vs. sync

`cloud.backend` and `cloud.sync` are computed independently, from different
sources, matching the connectivity fix's own invariant: a permanently
rejected/dead-lettered sync event degrades `sync` without ever touching
`backend`, and a backend outage degrades `backend` (and, once retries start
accumulating, `sync`) independently. Sync never escalates past `degraded` —
a subset of events failing/retrying is "working partially" by definition,
never a full sync outage.

## Report / export

`GET` via the `get_runtime_health` Tauri command returns `RuntimeHealth`
directly; the same value (JSON-redacted through the existing
`diagnostics::redact::redact` key-based pass, defense in depth) is written as
`runtime-report.json` into the diagnostics ZIP (`diagnostics::export`),
alongside the existing GSI capture files and `app.log`, without changing
their semantics. Schema is versioned (`schemaVersion: 1`).

RuntimeHealth never reads secure storage, tokens, or passwords — the safest
diagnostics secret is the one export never reads in the first place.

## Frontend

`useRuntimeHealth` (10s poll — this command also does a live loopback probe,
so it's deliberately slower than `useStatus`'s 3s) feeds `RuntimeHealthPanel`
on the Диагностика page, reusing the existing `check-item`/`status-checklist`
visual language (no new card design). Healthy/disabled components render
with no detail text; only degraded/unavailable/unknown show their reason.
