# Draft GSI contract (WK-36)

This contract is deliberately limited to data produced by the installed Dota 2 GSI config. It does not use OpenDota, replay parsing, or inferred hidden picks/bans.

## Reproducible signals

Companion requests the `map`, `player`, and `draft` GSI sections with a 100 ms buffer/throttle and a 30 second heartbeat. The application currently has reproducible automated coverage for these public phase signals:

| `player.activity` | `map.game_state` | State | Safe action |
| --- | --- | --- | --- |
| `playing` | `DOTA_GAMERULES_STATE_HERO_SELECTION` | draft | Apply the selected draft presentation before rendering widgets. |
| `playing` | `DOTA_GAMERULES_STATE_STRATEGY_TIME` | draft | Keep the selected draft presentation. |
| `playing` | `DOTA_GAMERULES_STATE_TEAM_SHOWCASE` | draft | Keep the selected draft presentation. |
| `playing` | `DOTA_GAMERULES_STATE_PRE_GAME` | gameplay | Draft presentation may be removed atomically. |
| `playing` | `DOTA_GAMERULES_STATE_GAME_IN_PROGRESS` | gameplay | Use gameplay layout. |
| any other combination | missing/unknown | uncertain | Never expose the game capture through a protected overlay; render an opaque waiting/cover frame. |

The same mapping is used by Companion for OBS scene switching and by the browser overlay. Tests are the executable record of the known transitions.

## Actual limitations and unknowns

- The repository has synthetic, anonymized GSI fixtures but no captured real draft payload sequence. Exact delivery latency and whether every Dota mode emits every intermediate state remain field-validation items.
- GSI does not provide a stable, documented contract for hidden enemy picks/bans that is safe to republish. Draft protection therefore consumes phase only; it must not render the `draft`, `hero`, or other real selection fields.
- Payloads can be missing, malformed, delayed, or stale. A protected mode treats those cases as uncertain and fails closed.
- `cover` is the only protected presentation. It is static/public configuration and has no data dependency on the real draft payload.

## State model

`uncertain -> draft -> gameplay -> between matches` is the expected happy path. Any state may transition to `uncertain` when data disappears. `cover` renders an opaque frame in both `draft` and `uncertain`; `off` is the explicit user opt-out and draws nothing. A known gameplay state is required before protected draft content is removed.

This is a GSI-only architecture: GSI decides only the coarse phase, while public presentation data is stored in overlay settings and never derived from hidden selections.

## Addendum (WK-69): Cinematic Draft and Fake Draft removed

Following a visual review, both GSI-consuming draft presentations described in the WK-77
addendum below were removed:

- **Cinematic Draft** (the old `off` renderer, `cinematic-draft-layer.tsx`) never had enough
  real GSI data for a full 5x5 draft grid - only the player's own hero was ever known, and the
  other 9 slots stayed permanently empty.
- **Fake Draft** (`substitute`, `fake-draft-picker/`) didn't hold up on visual review and added
  real media/performance cost for a mode nobody wanted.

`off` is now a literal no-op renderer (`draft-protection-layer.tsx`) - it draws nothing over the
real Dota UI and does not read GSI at all. `substitute` is no longer a selectable mode;
`normalizeOverlayLayout` still recognizes the legacy string on read and fails closed to `cover`
so an old persisted layout never silently loses its protection. `get-draft-signals.ts` (the
own-team/own-hero reader described below) was deleted along with its only two consumers -
draft protection reads no GSI fields at all today.

A future `photorealism` mode remains reserved (see `RESERVED_FUTURE_DRAFT_PROTECTION_MODE` in
`stream-overlay-layout/model/types.ts`) but is not implemented or selectable. If implemented, it
must draw its fake content only from an explicit user-configured safe fake-hero pool and prepared
templates, with an independent state machine - never correlated with the real pick/ban/GSI, for
the same reason Fake Draft's exclusion rule below existed.

## Addendum (WK-77, historical): own-team/own-hero consumption

This section describes behavior that no longer exists after the WK-69 removal above - kept for
history only.

The `off`/`substitute` draft scenes (`apps/web/src/components/pages/overlay/cinematic-draft/`,
`.../fake-draft-picker/`) additionally read exactly two already-flowing, already-precedented
fields via `apps/web/src/components/pages/overlay/lib/get-draft-signals.ts`:
`player.team_name` and `hero.id`/`hero.name` (the same fields already used server-side in
`stream-match-service.ts` and documented in the companion diagnostics catalog). These describe
only the local player's own team and own selected hero - never another player's pick or ban.

- **Real/cinematic draft (`off`)** rendered the player's own hero once GSI reported it; the other
  9 slots (teammates + enemies) had no reliable data source and stayed empty by design - Valve
  does not expose a stable, documented `draft.*` pick/ban contract (see "Actual limitations and
  unknowns" above), and this addendum did not change that decision.
- **Fake picker (`substitute`)** read the same two fields for exactly one purpose: to exclude
  the player's real hero id from the fake hero pool, so the fake picker could never coincidentally
  "reveal" it. It never rendered team_name/hero.id.
- `draft.*` fields (picks/bans/activeteam) were still never parsed or rendered anywhere.