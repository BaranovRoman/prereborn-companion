# Hero demo, BuiltIn session and safety status in 0.5.93

## Question

The Windows user confirms ability sound playback in the current Dota/Companion 0.5.93 run,
no active match on Home, Prepare session_lookup/failed/builtin_session_required,
BuiltIn/epoch absent and safety storage_unavailable. Subsequently confirmed the mode was
**Try Hero / hero demo**, with OBS not running. Explain session creation and storage status
without inventing a session, migrating or publishing.

## Current state

No production changes in this audit. Read current source, ran three existing real-GSI-entry
tests against in-memory SQLite, and inspected the separate native session and quota readers.
Actual Windows GSI fields, session-write errors and SQLite namespace contents were not provided.

## Findings

The real path is server::process_gsi_body → dota::handle_gsi under BuiltIn admission → OBS,
game_sounds, local_runtime::handle_gsi_shadow, draft reminder, observer. Thus current sound
playback establishes that BuiltIn received/processed sound-relevant GSI, not that the later
match/session branch admitted the same snapshot or wrote SQLite.

game_sounds::handle_gsi derives events from current/previous payload and resolves configured
assets. Its builtin_token obtains optional audio_session; AudioFence::admit allows session=None
and optional owner lease. There is no requirement to insert/find a LocalSession before sound.

There are two legitimate session creation paths:

- OBS lifecycle: reconcile() + shared session_lifecycle::decide opens a stream session when
  authoritative streaming=true and there is no open session. Merely running Dota, having a
  sound event, or having OBS disconnected does not constitute an OBS stream. OBS was off here.
- GSI gameplay: if no active match anywhere and no open session, handle_gsi_shadow requires
  detector::is_new_match_evidence before ensure_gameplay_session. This path does NOT require
  OBS or broadcasting. It creates a nonstreamed session only from genuine match evidence.

The actual match-evidence requirements are parsed map.game_state, player.activity="playing",
a state in HERO_SELECTION/STRATEGY_TIME/PRE_GAME/GAME_IN_PROGRESS, no nonblank map.customgamename,
hero.id as an integer >0 and player.team_name present. POST_GAME cannot open a new match.
Missing map.game_state exits before DB handling; a missing/failed evidence predicate exits
without creating session or match. Existing write failures log Local runtime errors.

Hero demo can provide hero/ability cooldown evidence for sounds while failing this match gate.
Do not claim which individual field rejected this Windows frame without its five allowed
values. Nor assume every possible demo payload is categorically rejected by a special
"demo" flag: the code uses the above concrete predicate, not the UI name of the game mode.
If all predicates were satisfied, investigate logged ensure_gameplay_session failure rather
than weakening evidence or blaming OBS absence. A nonstreamed session may also legitimately
close after a terminal match; the observation must correspond to the Prepare-time frame.

In 0.5.93, builtin_session_required is emitted only after preparation_session() acquired the
mutex, found an existing connection, read active-match lookup successfully as None, and read
open-session lookup successfully as None. Busy/poisoned mutex, missing connection and SQL
read failures have different codes. It therefore confirms absence of these eligible rows at
lookup time, not an unavailable legacy connection. These two reads do not prove all database
contents or every earlier write healthy. Home's no-active-match observation is consistent.

storage_unavailable has a separate origin: safety status unconditionally calls live_effects::quota.
quota → transaction_schema::version executes SELECT version FROM pc_tx_meta. Healthy legacy
SQLite without explicit safety migration has no pc_tx_meta. The helper sql() maps that
"no such table" error to storage_unavailable and status returns it as storageError.
Quota does not query session presence, so this is not a consequence of an empty local_sessions
table. Here Prepare stopped before backup/migration, and epoch is absent: the expected
unprepared safety namespace is a concrete explanation compatible with every observation.
It is misleading to interpret this status as proof that user history SQLite is broken.
Exact namespace absence can be confirmed read-only if needed; partial/corrupt reserved tables
must remain a real fail-closed error, never be relabelled universally as "not prepared".

Existing targeted tests passed (3): real_gsi_entrypoint_opens_a_nonstreamed_gameplay_session_for_a_real_match_with_no_obs_session_open,
real_gsi_entrypoint_still_ignores_ordinary_ticks_with_no_match_evidence_and_no_session_open,
real_gsi_entrypoint_creates_tracks_and_finalizes_a_match_end_to_end. These use the real legacy
entrypoint/algorithms and in-memory schema; not the user's database or Windows native UI.

## Options

Starting an artificial session or relaxing demo/custom-game evidence to make Prepare pass is
not a fix and was rejected. Requiring OBS for all gameplay would contradict existing WK-137
behavior and the passing real-GSI test. Automatic migration to hide quota failure is rejected.

## Recommendation

Minimal prospective fix: classify read-only safety namespace before quota. No reserved tables
→ explicit not_prepared with no legacy-storage fault; complete valid namespace → current quota;
partial/invalid namespace or SQL failure → distinct error and activation blocked. Do not write
tables, auto-migrate, attach a writer or change backup behavior in this status reader.

Clarify builtin_session_required in the UI: no active local match/open session; sounds can work
without one and demo does not establish genuine match evidence. Keep all Prepare gates.
If exact GSI rejection remains unclear, expose only the existing gate's read-only skip reason
and five permitted field values, not raw GSI or a new runtime/executor. Keep decision/SQL intact.

## Follow-up

No further Prepare clicks needed in demo. For exact evidence-gate diagnosis request only:
map.game_state, player.activity, whether map.customgamename is empty (or its game-mode value),
hero.id and player.team_name from a contemporaneous sanitized snapshot. Existing Diagnostics
capture/export is optional and passive: inspect a snapshot locally and share only those fields,
not the full archive/raw GSI. Also share click-time Local runtime: ... failed / Local lifecycle:
... failed lines if present. No auth/provider/account/Steam IDs, session UUIDs or user DB required.

For actual external-runtime readiness, observe a genuine normal match (not a synthetic session)
without requiring OBS streaming: the existing gameplay path should create a local session/match.
If it does not, use the predicate fields and existing SQL-write errors to identify the missing
condition or actual store failure first. No release, migration or user-data modification here.

## Sources

User Windows evidence and mode/OBS clarification. Repository: server/mod.rs, dota/mod.rs,
game_sounds/mod.rs, game_sounds/audio_fence.rs, local_runtime/mod.rs and lifecycle.rs,
store.rs, host_execution/live_effects.rs, transaction_schema.rs and host_execution.rs;
plugins/dota-domain/src/gsi.rs, match_shadow.rs and session_lifecycle.rs.
