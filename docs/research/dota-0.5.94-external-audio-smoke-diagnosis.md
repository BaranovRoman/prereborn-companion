# Companion 0.5.94: External cold bootstrap/audio diagnosis

## Question

Why did the first Windows smoke show no awaiting-session message and no configured sounds
in a bot game after visually successful preparation/activation? This is analysis only:
no application changes, migrations, package changes, effect execution or publication.

## Current state

Release `prereborn-v0.5.94` contains `48c3198`; current later commits are documentation only.
User confirms Prepare/activation looked successful, demo was silent (accepted limitation),
and bots were also silent. Actual native runtime/session-bound status and GSI snapshots for
that attempt have not been supplied. Real External acceptance remains unpassed.

## Findings

### 1. Awaiting-session UI is conditional and local to the Plugins card

`PluginsPage.tsx:168` renders the message only inside the installed `dota2` card, above the
catalog, when `runtime.mode === "external" && sessionBound === false`. It is not a banner
on Home, Sounds or the plugin's packaged replay iframe. The host polls every 700 ms.

Native `dota_runtime_safety_status` uses camelCase serialization and obtains `sessionBound`
from the durable ownership record, not from the running Dota process or raw GSI. Its ready
response includes a Boolean; unprepared/error storage responses use null. Read/storage
errors are separate visible fields, not a false Boolean.

Enable can select an existing active/open SQLite session even with Dota closed. In that
case the existing bound handoff runs and the waiting message must not appear. Closing the
game does not prove that the actual selected session was None. This has not been confirmed
or excluded on this Windows attempt.

The action-result string is historical: it retains the state read immediately after the
command, while polling updates the separate Runtime/Epoch line. A later successful automatic
fallback clears `runtime.error` and does not clear/rewrite that old result text. Therefore
the earlier success text alone does not prove that External is still processing.
If the banner was missing immediately after a true unbound activation, before any new GSI,
projection rejection cannot explain that initial absence. The actual native sessionBound/mode
response is required; do not force one hypothesis to explain both observations.

### 2. Exact cold bootstrap predicate

After successful projection, `external_lifecycle::cold_lifecycle` requires the same existing
`match_shadow::is_new_match_evidence` predicate as legacy:

- `map.game_state` present and one of HERO_SELECTION, STRATEGY_TIME, PRE_GAME or GAME_IN_PROGRESS
  (with the full `DOTA_GAMERULES_STATE_` prefix).
- `player.activity` exactly `playing`.
- `hero.id` is a positive integer and `player.team_name` is present as a string.
- `map.customgamename` absent/blank after trimming; nonblank means excluded custom/demo.
- Not POST_GAME. Missing/partial evidence returns session=None without an error.

No bot-mode exclusion, positive/nonzero matchid, OBS, streaming or Twitch requirement is
in this predicate. Missing matchid or matchid=0 does not prevent bootstrap. Whether the
actual bot-game snapshots met these conditions is unknown; do not infer it from the mode name.

### 3. Confirmed pre-bootstrap projection defect; Windows trigger unconfirmed

`core/dota_observer.rs:40-49` validates ALL item/ability/courier item maps through the same
`signals` helper, admitting only `slotN` or `abilityN` keys (N < 32). Therefore any snapshot
with `items.stash0`, `items.teleport0`, `items.neutral0` or `couriers.*.items.item0` is rejected
as `invalid_slot`, even if the offending slot is empty. Courier containers without an items
map are not the same case.

This conflicts with inventory families already handled by the shared events implementation:
its stash-relocation fixtures contain `stash0`, and courier item extraction reads nested
item names without requiring slotN. Existing observer fixtures use slot0 even for courier
items; prior parity coverage did not exercise these rejected families. No actual Windows
payload is available yet, so presence of these keys in this user's match is NOT asserted.

`LiveDota::enqueue_with_context` reacts to any projection error by incrementing lost, clearing
the queue, entering Fallback and storing `snapshot_gap_requires_fenced_fallback`. This is
before cold lifecycle/session binding, IPC and audio. The specific projection error is not
preserved in that status. Successful fallback clears the error; failed fencing keeps game
admission blocked. Thus GSI reception alone is not proof of forwarding.

### 4. Binding-to-worker route exists; subsequent failures are still possible

The first eligible fresh snapshot creates a real session, revision/lifecycle receipt/ledger
and durable owner binding in the same Immediate SQLite transaction. The controller sets its
grant's session from that committed outcome before running `process` for the same frame.
Only `session=None` explicitly skips the worker. No direct missing call between successful
binding and IPC was found. Reminder, match execution, authorization, timeout or effects can
still fail afterward and trigger fenced fallback.

Worker `live_effects` uses the shared Replay/events detector and sends typed sound intents.
The first accepted snapshot establishes the baseline; it does not replay an already-started
cooldown as a fresh cast. A subsequent supported transition in the same hero must be checked.

### 5. Existing sound settings are reused, but rejection is not well diagnosed

Both paths use `AppState.game_sounds_settings`, loaded from the existing
`game-sounds-config.json`, the same `resolve_playback`, exact event-id/kind binding, managed
sound assets and master volume. Enable/Prepare do not replace these settings. The external
path adds managed-file confinement and durable audio admission, not a separate config.

`dispatch_plugin_sound` returns Rejected for disabled settings, missing binding/asset, closed
audio admission, invalid/unreadable managed file or revoked token. These early returns do not
log a specific reason. Rejected is not Unknown and need not produce a runtime error.

After durable playback binding, core emits `game-sound-play` to main. The AppShell-mounted
frontend engine checks enabled/fence/queue, applies the existing overall/output volume,
calls Audio.play and reports queued/playing/terminal ACKs. Emit is not completion.

Existing log stages `frontend-received`, `audio-play-requested`, `audio-playing` prove only
their respective milestones. The external dispatcher does not write the BuiltIn
`gsi-received/detected/play-request-emitted` lines. Their absence is not proof that no sound
intent was computed. GSI server log entries prove reception, not projection/binding/IPC.

## Options

1. Assume the bot mode is unsupported or reset/migrate again: unsupported by the code and
   unsafe as a diagnosis; reject this option.
2. Obtain current native status and a minimal allowlisted GSI sample, then identify the
   first failed boundary. This distinguishes rejection before binding, legitimate waiting,
   bound-worker failures and local audio rejection without changing safety gates.

## Recommendation

Do not retry Prepare/activation or clear data to investigate. First record the current
Runtime/Epoch/Unknown/error from the installed Dota card. Also record bot launch mode,
hero/ability, sound master toggle/volume and whether that sound's existing preview plays.

For native payload, only if main-window DevTools are already accessible, this existing
read-only command can reveal the fields not currently displayed by the card:

```js
const s = await window.__TAURI_INTERNALS__.invoke("dota_runtime_safety_status");
console.log({runtime:s.runtime, sessionBound:s.sessionBound,
  storageState:s.storageState, storageError:s.storageError, unknown:s.quota?.unknown});
```

Do not enable/debug-launch/reconfigure the app just to obtain DevTools. A normal screenshot
or text of the card is the first, simpler observation; do not infer the missing Boolean.

For GSI, use the existing Diagnostics UI: Start diagnostics in the already running bot game,
capture 10–20 seconds around the configured ability use, Stop, Export ZIP. This observer runs
before game runtime admission and can collect evidence even when External is blocked. It
does not invoke Prepare/migration or authorize effects. Do not toggle runtimes for capture.

Open `snapshots/*.json` locally. Share only:

- `map.game_state`, `map.customgamename`, `player.activity`, `player.team_name`, `hero.id`;
  explicitly say when a field is absent. For matchid just say absent/zero/nonzero.
- Item key names (slotN/stashN/teleportN/neutralN), ability slot names, and courier item
  key names (itemN/slotN), WITHOUT courier/player dictionary identifiers.
- For the configured ability: only its name/cooldown/charges before and after the cast.
- Relevant app.log lines from that short interval: `GSI request`, `Dota Prepare` and
  `[game-sounds]`, accessed via Diagnostics → Open logs folder. No whole log/ZIP is needed.

Full diagnostic ZIP/snapshots must not be sent: secret-key redaction does not remove all
account identifiers/provider/player names. A few manually copied allowlisted fields suffice.

## Follow-up

Windows root cause remains conditional until these observations are provided. If rejected
inventory keys are present, the minimal fix is the existing core projection's bounded
section-specific slot policy plus genuine-shape regression/parity coverage, keeping relocation
evidence and fail-closed behavior. Do not discard stash/courier evidence to hide failures.
Separately preserve a visible last-failure/stage and distinguish waiting from successful
sound processing if the native data confirms the observability gap. No implementation,
new runtime/protocol, release or package update is performed in this audit.

## Sources

- `apps/companion/src/pages/PluginsPage.tsx`: DotaControls/conditional waiting/action result.
- `apps/companion/src-tauri/src/core/dota_live.rs`: safety status, queue, failure/fallback.
- `apps/companion/src-tauri/src/core/dota_live/ipc.rs`: lifecycle → match IPC → typed effects.
- `apps/companion/src-tauri/src/core/dota_observer.rs`: actual GSI projection, shared by live.
- `plugins/dota-domain/src/{gsi,match_shadow,events,replay}.rs`; `plugins/dota/src/live_effects.rs`.
- `apps/companion/src-tauri/src/local_runtime/host_execution/external_lifecycle.rs`.
- `apps/companion/src-tauri/src/game_sounds/{mod,config,assets,audio_fence}.rs`.
- `apps/companion/src/sounds/useGameSoundEngine.ts`; `components/AppShell.tsx`.
- `apps/companion/src-tauri/src/{server/mod,diagnostics/session,diagnostics/redact}.rs`.
