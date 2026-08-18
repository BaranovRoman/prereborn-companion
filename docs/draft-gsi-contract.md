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
- `cover` and `substitute` are presentation choices. The substitute model is static/public configuration and has no data dependency on the real draft payload.

## State model

`uncertain -> draft -> gameplay -> between matches` is the expected happy path. Any state may transition to `uncertain` when data disappears. Protected modes render an opaque frame in both `draft` and `uncertain`; `off` is the explicit user opt-out. A known gameplay state is required before protected draft content is removed.

This is a GSI-only architecture: GSI decides only the coarse phase, while public presentation data is stored in overlay settings and never derived from hidden selections.

## Addendum (WK-77): own-team/own-hero consumption

The `off`/`substitute` draft scenes (`apps/web/src/components/pages/overlay/cinematic-draft/`,
`.../fake-draft-picker/`) additionally read exactly two already-flowing, already-precedented
fields via `apps/web/src/components/pages/overlay/lib/get-draft-signals.ts`:
`player.team_name` and `hero.id`/`hero.name` (the same fields already used server-side in
`stream-match-service.ts` and documented in the companion diagnostics catalog). These describe
only the local player's own team and own selected hero - never another player's pick or ban.

- **Real/cinematic draft (`off`)** renders the player's own hero once GSI reports it; the other
  9 slots (teammates + enemies) have no reliable data source and stay empty by design - Valve
  does not expose a stable, documented `draft.*` pick/ban contract (see "Actual limitations and
  unknowns" above), and this addendum does not change that decision.
- **Fake picker (`substitute`)** reads the same two fields for exactly one purpose: to exclude
  the player's real hero id from the fake hero pool, so the fake picker can never coincidentally
  "reveal" it. It never renders team_name/hero.id.
- `draft.*` fields (picks/bans/activeteam) are still never parsed or rendered anywhere.