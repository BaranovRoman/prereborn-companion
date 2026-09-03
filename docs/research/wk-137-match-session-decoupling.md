# WK-137 — match history persists independently of OBS streaming state

## CURRENT MODEL (why a match disappears without OBS streaming)

`local_runtime::handle_gsi` (`mod.rs:140-182`) is the single production entry
point for every GSI tick. Before this fix, its very first act was:

```rust
let session = match store::find_open_session(conn) {
    Ok(Some(session)) => session,
    Ok(None) => return,   // silent, unconditional
    ...
};
```

`store::ensure_active_session` — "the ONLY place a new `LocalSession` is
created" (its own doc comment) — is called from exactly one place:
`lifecycle::apply`'s `StartNewSession` arm, which only fires when OBS's own
`GetStreamStatus`/`StreamStateChanged` truth (`obs.rs`) says `streaming ==
true` (WK-113 deliberately removed the older "any GSI tick lazily opens a
session" behavior). So: **no OBS "Start Streaming" ⇒ no open
`local_sessions` row ⇒ every GSI tick is discarded before match detection
(`detector::handle_snapshot`) ever runs.** Nothing is written to SQLite, so
there is nothing to lose *later* — the match is never created in the first
place. `local_matches.session_local_id` is `NOT NULL REFERENCES
local_sessions(local_id)` with `foreign_keys = ON`, so even a hypothetical
sessionless write is not representable in the schema as it stood.

A second, previously latent bug in the same family: once a session *is*
open and a match is mid-flight, OBS "Stop Streaming" + the existing 30s
grace period (`lifecycle::GRACE_PERIOD`) ends that session
(`local_sessions.ended_at`) with no awareness of whether a match is still
active. The next tick's `find_open_session` then returns `None` and the
still-in-progress match's remaining ticks are silently dropped too — the
same root cause, reachable without ever going "OBS off the whole time."

## TARGET INVARIANTS

1. A real GSI-observed Dota match is created/tracked/finalized/persisted
   regardless of OBS's streaming state.
2. A stream session's identity (`local_sessions` row) still exclusively
   represents OBS's own broadcast lifecycle where it genuinely is one — no
   fabricated start/end timestamps, no session claimed as "streamed" that
   wasn't.
3. Backend/web never learns about a broadcast that didn't happen (no
   `stream_sessions` row, no public overlay/session state) for gameplay that
   was never streamed.
4. MMR (`rating_start`/`rating_current`/`rating_adjustment`,
   `reanchor_session`/`cascade_reanchor`) stays a single continuous,
   device-wide chain regardless of which matches were streamed.
5. Existing streamed-session behavior (30s grace, staleness, corrections,
   sync, PostStream, Home session card) is unchanged when OBS is used
   exactly as before.

## CHOSEN MODEL — Option C from the ticket

> "Сохранить родителя LocalSession структурно, но явно разделить «observed
> gameplay session» и «broadcast stream session»."

`local_sessions` stops meaning *only* "an OBS broadcast" and becomes "a
tracked gameplay period" — an OBS-driven broadcast is one *kind* of that,
distinguished by a new `is_streamed` column:

- **Match existence** (creation/tracking/finalization) depends only on GSI
  evidence, never on OBS. Every `local_matches` row still has a `NOT NULL`
  `session_local_id` — no schema change to that constraint, no nullable FK,
  no cross-cutting query rewrite needed anywhere that already joins/filters
  on it.
- **Session creation** now has two triggers instead of one:
  - OBS `streaming == true` with no open session → `ensure_active_session`
    (unchanged): creates a session with `is_streamed = 1`, immediately
    enqueues `session_started` — exactly as today.
  - GSI evidence of a genuine new match (`detector::is_new_match_evidence`,
    the same hero-picked/team-known gate `detector::handle_snapshot`
    already used to decide "create a match") with **no open session and no
    match active anywhere on the device** → `store::ensure_gameplay_session`:
    creates a session with `is_streamed = 0`. No sync event is enqueued —
    nothing has actually gone live yet, so there is nothing true to tell the
    backend.
- **Session ownership of a GSI tick** (`local_runtime::mod::handle_gsi`) is
  now resolved in this order:
  1. If some match is *currently active* anywhere on the device (in
     `in_progress`/`post_game_pending`/`interrupted`), keep feeding it —
     **regardless of whether its own session has already `ended_at`**. This
     is what fixes the pre-existing "OBS stops mid-match" bug: a match's own
     lifecycle, not its session's, decides whether ticks still apply to it.
  2. Otherwise, the current open session (`ended_at IS NULL`), if any —
     covers a streamed session with no match in progress yet, and a
     just-opened gameplay session.
  3. Otherwise, only if this tick itself carries genuine new-match evidence,
     lazily open a gameplay session for it. An ordinary menu/idle GSI tick
     with no open session creates nothing, exactly as before.
- **Graduation.** If OBS starts streaming while a gameplay session
  (`is_streamed = 0`) is still open, `lifecycle::decide` resolves to
  `ContinueSession` (its `open_session = Some(..)`, `pending_end_at =
  None` branch — unchanged decision table), and `apply`'s handler now calls
  `store::mark_session_streamed`: flips `is_streamed = 1`, stamps
  `stream_started_at = now` (the moment OBS actually went live, kept
  separate from `started_at`, which stays "when this session/match began
  being observed"), and — only now — enqueues `session_started` with
  `startedAt = stream_started_at`. The match already tracked in that
  session is not moved, not duplicated, not re-created; it simply keeps
  finalizing into the same session, which is now a real stream session. A
  session that graduates never has more than one match attached to it
  before the graduation moment (see "one gameplay session per match"
  below), so `rating_start` at graduation time is exactly what
  `ensure_gameplay_session` set it to — nothing to reconcile.
- **One gameplay session per match.** A gameplay session auto-closes
  (`store::finalize_session_end`, reused as-is) the moment the match that
  opened it leaves the active state set for a *terminal* reason (finalized
  or needs_review — not `interrupted`, which can still resume within the
  existing 5-minute reconnect window). This keeps gameplay sessions from
  silently accumulating unrelated matches across hours/days while nothing
  is streaming, and reproduces the "one continuous period ends when the
  thing that was happening ends" semantics a stream session already has via
  OBS's own stop signal. If OBS starts mid-match, the session has already
  graduated (`is_streamed = 1`) by the time the match resolves, so this
  auto-close no longer applies to it — it now only ever ends via the normal
  OBS-stop + 30s grace path, unchanged.
- **The OBS-absence branch of `lifecycle::decide` only ever applies to an
  already-streamed session.** A gameplay session sitting open with OBS
  "not streaming" is not evidence of anything ending — that's the normal,
  expected state for it — so `decide_with` gained a third input
  (`session.is_streamed`) and returns `NoOp` for `(streaming=false,
  is_streamed=false)` instead of starting the 30s countdown. Without this,
  every non-streamed session would auto-"end" ~30s after creation purely
  because OBS wasn't live, breaking graduation (scenario 4) and adding
  pointless churn.
- **Staleness** (`is_stale`, the 12h manual-recovery flag) and
  `lifecycle::status()` (the AppShell's OBS/session indicator) are scoped to
  `is_streamed` sessions only, via a new `store::find_open_streamed_session`
  read query — a gameplay session is invisible bookkeeping, not something
  the user manages through the stream-recovery UI.

### Mixed-lifecycle scenarios, worked through

- **Match before stream (A):** gameplay session S1 opens for match A,
  closes (terminal) when A finalizes, `is_streamed` stays 0 forever, no
  `session_started`/`session_ended` ever synced for S1. OBS then starts →
  `find_open_streamed`/`find_open_session` both see `None` (S1 already
  ended) → fresh S2 (`is_streamed = 1`) via the existing path, exactly as
  today. A never becomes part of S2. ✅ matches the ticket's explicit "must
  not retroactively become part of the OBS stream session."
- **Stream starts mid-match (B):** gameplay session S1 opens for the match,
  OBS starts before it resolves → S1 graduates in place (`ContinueSession`
  + `mark_session_streamed`) → the match finalizes into S1, now a real
  stream session, with correct MMR (S1's `rating_start` was already
  correctly carried over at creation) and a truthful `stream_started_at`.
  No duplication, no split.
- **Stream stops mid-match (C):** S1 (`is_streamed = 1`) has a match
  in-flight, OBS stops, 30s grace elapses, `finalize_session_end` sets
  `S1.ended_at` (unchanged existing behavior — this is not gated on match
  activity, deliberately: see "why not block the end" below). The match's
  remaining ticks are resolved via the new device-wide "active match
  anywhere" lookup (step 1 above), which does not care that
  `S1.ended_at` is set, and finalizes normally into S1. If OBS restarts
  streaming again before that match resolves, `find_open_session` now
  returns `None` (S1 already ended) so a *new* S2 opens — the still-active
  match in S1 is **not** migrated to S2 (a match's session-of-record is
  fixed at the point tracking began, never reassigned later); S2 simply has
  no match yet until the next one starts. This is a deliberate, documented,
  rare-edge-case tradeoff (see "Alternatives rejected").

### Why not block the session end while a match is active?

An earlier idea was: don't let `FinalizeEnd` fire while
`find_active_match_anywhere` is non-empty. Rejected — it would mean OBS
genuinely stopping streaming (the user closed OBS, or crashed) could leave a
`local_sessions` row open indefinitely as long as Dota happens to think a
match is still active (e.g. an abandoned match nobody ever left), which
re-introduces a *different* stale-session problem the existing 12h
mechanism was built to catch. Decoupling "which session a tick's match
belongs to" from "is that session still open" (this ticket's actual ask)
is a smaller, more local fix than teaching the OBS lifecycle state machine
about match activity.

## ALTERNATIVES REJECTED

- **A — `local_matches.session_local_id` becomes nullable.** Requires a
  backend contract change too (`matchFinalizedPayloadSchema.localSessionId`
  is `z.string().uuid()`, not nullable — apps/api's
  `stream-sync-service.ts`), plus every existing local query/index built on
  a non-null FK needs re-auditing. Strictly more invasive than Option C for
  no behavioral gain — Option C already gets a match "existing independent
  of a *stream*" without ever making it independent of *a* session row.
- **B — a dedicated non-stream grouping concept/table (e.g.
  "observation batches").** A second storage concept duplicating almost
  everything `local_sessions` already provides (MMR anchor, rowid ordering,
  outbox correlation) for no benefit over reusing the existing table with
  one new boolean. Directly the kind of unnecessary local-first abstraction
  the ticket's own scope guardrails (§4) warn against.
- **Auto-create a session on every GSI tick / Companion or Dota launch
  ("just always have a session open").** Reintroduces exactly what WK-113
  deliberately removed (a session for every idle menu tick, most never
  containing a match) and reopens the staleness/manual-recovery surface for
  something the user never asked to manage. Gating gameplay-session
  creation on genuine match evidence (the same gate `detector.rs` already
  uses to create a match) avoids this.

## MIGRATION

One additive SQLite migration (v6 → v7, `schema.rs`), appended to
`MIGRATIONS` per the existing pattern — no rewrite of any prior entry:

```sql
ALTER TABLE local_sessions ADD COLUMN is_streamed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE local_sessions ADD COLUMN stream_started_at TEXT;
UPDATE local_sessions SET stream_started_at = started_at WHERE is_streamed = 1;
```

`DEFAULT 1` is a truthful backfill, not a guess: every pre-existing row was
created exclusively by `ensure_active_session`, i.e. was *always* an actual
OBS-driven session — see the audit above. Backfilling `stream_started_at =
started_at` for those rows is re-deriving already-true information (their
only possible origin was OBS going live), not fabricating anything. No
Postgres/backend migration is required at all (see SYNC SEMANTICS below).

## SYNC SEMANTICS

No backend schema or API contract change. `stream-sync-service.ts`'s
`applyMatchFinalized` already tolerates a `match_finalized` event whose
`localSessionId` was never synced as a `session_started` (`sessionId ===
null` branch, `stream-sync-service.ts:203-224`): it inserts the
`stream_matches` row with `stream_session_id = NULL` and simply skips the
session W/L/rating update. `GET /me/matches` (`stream-match-service.ts`'s
`getRecentMatches`) has no join to `stream_sessions` at all and already
returns rows with a null `stream_session_id` (this has been true since
before `stream_session_id` existed on old rows) — so a match finalized from
a gameplay session shows up in account match history with zero backend
changes.

Concretely: `match_finalized` is always enqueued on finalize exactly as
today, carrying whatever `session_local_id` the match was tracked under —
streamed or not. `session_started`/`session_ended` are enqueued **only**
for sessions that are (or become) `is_streamed = 1` — a gameplay session
that never graduates never sends either event, so the backend never
materializes a `stream_sessions` row for it. This matters beyond tidiness:
`getOrCreateActiveSession`/`getLatestSessionForUser` (the only two backend
read paths over `stream_sessions` — self-service dashboard, the public OBS
overlay, the admin user panel) treat *any* row as "the" active/latest
session with no way to distinguish a real broadcast from anything else.
Syncing a gameplay session would make it show up as a live/most-recent
stream on the public overlay — exactly the "не фабриковать stream-сессию"
the ticket forbids. Not syncing it is what keeps that boundary honest.

## MMR SEMANTICS

`reanchor_session`/`cascade_reanchor` (`store.rs`) already walk
`local_sessions` device-wide in `rowid` order with no concept of
`is_streamed` — a gameplay session is just another row in that same chain,
so MMR continuity (`rating_start` carried from the previous session's
`rating_current`, forward cascade after a correction) needs zero changes.
`ensure_gameplay_session` carries `rating_current`/`sync_meta.current_rating`
over exactly like `ensure_active_session` (shared internal helper, only the
`is_streamed` flag and whether `session_started` is enqueued differ). A
ranked match played without OBS contributes to
`rating_before`/`detected_rating_delta`/`rating_after` and the device-wide
current-rating snapshot exactly as a streamed one would; an unranked one
does not touch rating, exactly as today. WK-105/WK-123 correction semantics
(`rating_delta_correction`, `set_current_rating`, cascade) are untouched —
they already operate on "whatever session a match belongs to," which now
just includes gameplay sessions for free.

## SESSION UI SEMANTICS (scope-bounded)

`summary::get` (Home's session card / `LocalSessionSummary`) keeps showing
`current_match` for a live gameplay-session match (so "I'm mid-match right
now" is not silently hidden from Home just because OBS is off — the
opposite would be a regression against what users already see today when
they simply haven't started Dota yet). `has_session` stays `true` whenever
*any* session is open, streamed or not — HomePage renders `currentMatch`
independently of `hasSession` (`HomePage.tsx:256-261`), so serving
`has_session: false` alongside a non-null `current_match` would produce a
contradictory double-render ("Сессия ещё не началась" next to a match row)
without any HomePage.tsx change, which is explicitly out of scope for this
ticket (§18: "Do NOT redesign Home"). `wins`/`losses`/`rating_start`/
`session_delta`, however, fall back to their zero/`None` defaults for a
non-streamed session rather than reflecting `session_match_tally` — the
ticket's "не фабриковать stream W/L" language is explicit enough that
showing even a *local-only* tally on the one piece of UI literally labeled
Победы/Поражения was worth avoiding, even though nothing here reaches the
backend or public overlay either way (see SYNC SEMANTICS above). `rating_current`
still reflects the account's live MMR (session or device-wide snapshot) so
the MMR readout itself never blanks out. `lifecycle::status()`
(the AppShell's OBS indicator) and 12h staleness/manual-recovery are scoped
to `is_streamed` sessions only (`find_open_streamed_session`), so a
gameplay session never triggers "stream" UI it isn't.

## MANUAL VERIFICATION RECIPE

Diagnostics already expose enough to prove which match belongs to which
session without adding any new logging: `local-runtime.sqlite3` itself
(`SELECT local_id, is_streamed, started_at, stream_started_at, ended_at FROM
local_sessions`, `SELECT local_id, session_local_id, state, result FROM
local_matches`), the existing rolling log lines ("Local session started:
session=...", "Local session ended: session=...", "Local match created:
session=... match=..."), and the Diagnostics panel's sync-outbox view (a
gameplay session that never graduates should show a `match_finalized` event
and no `session_started`/`session_ended` events for its `local_id`).

**Scenario 1 — OBS connected, not streaming:** launch Companion, connect
OBS but do not press Start Streaming, play and finish one match. Expect:
`local_sessions` gains one row with `is_streamed = 0`; `local_matches`
gains one `finalized` row referencing it; the match appears in Home's
recent matches and in the website's account match history; the sync outbox
shows a delivered `match_finalized` event and nothing else for that session.

**Scenario 2 — non-streamed match, then a real stream:** play/finish a
match with OBS not streaming (as above), confirm it persists, THEN start
OBS streaming and play a second match. Expect: two `local_sessions` rows
(the first ended, `is_streamed = 0`, never synced as `session_started`; the
second `is_streamed = 1`, synced normally); both matches appear in match
history; only the second session's W/L/rating shows on Home's session card
and reaches the backend as a `stream_sessions` row.

**Scenario 3 — OBS completely unavailable:** disable/quit OBS entirely
(or block its WebSocket port), launch Companion, play and finish a match.
Expect the same result as Scenario 1 — `local_runtime::handle_gsi` never
touches OBS state at all, so its unavailability is irrelevant to match
persistence.

## ACCEPTANCE-CRITERIA RECONCILIATION

The ticket's criteria (Russian body, §"Критерии приёмки") map 1:1 onto the
model above; none are stale relative to current `main`. One clarification
worth recording: criterion 3 ("фиктивная broadcast-сессия не создаётся")
is satisfied by construction — a gameplay session is created with
`is_streamed = 0` and never synced unless OBS genuinely starts streaming
during its lifetime, so there is never a moment where a fake broadcast is
represented locally or on the backend.
