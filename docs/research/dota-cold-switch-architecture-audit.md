# Dota cold switch and hot handoff audit

## Question

Can the user install/enable External Dota while Dota and OBS are closed, then launch Dota,
without an artificial session, another runtime/protocol/service or weaker hot-handoff safety?
Analysis only: no production code, migrations, user database or releases changed.

## Current state

The implementation is session-bound handoff. Prepare first obtains an existing BuiltIn
session and a match-execution package grant. Enable repeats the session requirement.
Ownership switching, runtime handshake and database preparation are already separate
mechanisms internally, but the activation path combines them with session authorization.

## Findings

### 1. Why Prepare requires a session today

manual_action("prepare") calls preparation_session and match_execution_grant before
draining/backup. That grant verifies the installed signed executable/version, live manifest
and explicit capabilities, and bundles them with a nonempty session and candidate owner lease.
This prevents preparing toward an executable that could not receive the existing live grant.
It also catches missing hot-handoff context early. It is not a backup/migration invariant.

The lookup is not a full hot-handoff fence: it can select a match's session or an open session,
does not alone prove session freshness, absence of Unknown, current revisions or process stop,
and is not durable owner/session binding until authorization executes. Retain the downstream
checks and in-transaction revalidation rather than treating the initial lookup as sufficient.

### 2. Actual dependency on session_id

| Existing operation | Needs a real game session? |
| --- | --- |
| Verify signed package, executable hash/version/capabilities | No; current grant API additionally requires it |
| Consistent VACUUM backup, legacy integrity/schema, baseline identity | No; whole SQLite connection/history |
| Additive reserved safety tables, indexed ledger/receipts/revisions | No; existing rows are preserved, no new game session |
| Validate backup, migration version, coordinator exclusivity, quota | No |
| Ownership Active/Draining/Vacant and monotonic owner epoch | No in the pure state machine |
| Process generation journal, Windows job supervision, handshake | No; package/process generation is the identity |
| Game-only audio cancellation and in-flight drain | No; must include session-less BuiltIn playbacks too |
| Match tickets/preconditions/SQL and ordinary typed game effects | Yes in existing contracts |
| Hot handoff of a current match/session | Yes, preserve actual UUID/revisions |

transaction_schema::migrate/activation_preflight take connection and backup path, not session.
Adapter attachment/restart fencing also does not require an existing game session. Whole-DB
backup includes old sessions, but that is data preservation, not a requirement for an open row.

### 3. Where External is session-bound

MatchExecutionGrant.session is String; PluginManager::match_execution_grant rejects empty.
transaction_authorization::begin requires session &str and stores Some(session). authorize_scope
requires exact owner lease/package/session equality; request authorization also binds the ticket
context to that session. prepare_internal reads its row/revisions; effects enforce that scope.
ExecutionScope/ExecutionRequest bounds require a nonempty string. Do not use empty string,
"cold" or another UUID to pretend these operations are authorized.

Nevertheless the persisted ownership Record already stores session: Option<String>. Process
start journal validates Draining/lease/package/generation, not a session row. Runtime's verified
start uses executable/id/version and IPC Hello/Ready contains no game session. Ownership may
therefore be External with no game session after a controlled extension of existing host grants.

The existing external_lifecycle adapter already resolves a session from active match → open
session → genuine GSI match evidence/OBS streaming. It uses real Facade/store SQL and writes
lifecycle ledger/receipt and rebinds durable session in one transaction. Its current authorization,
revision collection and fallback to the old session assume an already-bound String. These are
the specific bootstrap points to adapt; a new session service is unnecessary.

### 4. Two scenarios, one runtime and coordinator

Cold: after admission is frozen, no active/unresolved match selected by the existing store,
no open session to preserve, and no uncertain/pending game effects. Transfer owner/process
identity, leave persisted session=None, worker supervised/ready and idle. Do not execute
session-bound frames/effects while unbound. Display External: awaiting game/session.

Hot/bound: active match or legitimate open session exists, even if the Dota executable is
currently closed. Use the existing handoff, same session/match UUIDs/revisions and all fences.
Old unfinished/interrupted state is not permission to call it cold or close it automatically.
Closed Dota does not prove empty data/effects; missing Dota PID is not fencing evidence.

Cold eligibility must be rechecked inside the coordinator transaction after draining. A new
GSI/session arriving during the switch must be fenced/reclassified, not lost through a stale
UI observation. The listener stays at 127.0.0.1:3665; only execution ownership changes.

### 5. Necessary cold gates

- Verified installed live package, executable/version/capabilities bound to actual handshake
  and process generation; no replay/Hello grant upgrade.
- Explicit preparation/activation; validated consistent backup/additive schema and single
  coordinator. No automatic migration or backup overwrite/restoration.
- Stop new game writes/effects; drain all admissions. Persist Draining; fence prior worker/job
  generation and game-only pending/active audio. A timeout/PID/closed Dota is not stop proof.
- Keep ledger/receipts/revisions and reject Unknown/exhausted quota. Session absence does not
  waive these global protections or permit old keys to execute again.
- Spawn and handshake under Draining with the existing supervised worker, confirm old fencing,
  issue the next durable owner epoch, then admit only the new owner. Failed transition remains
  Draining; no parallel BuiltIn gameplay fallback.
- Preserve Manager → process → history order; no history mutex during IPC/audio/OBS waits.
- Reset cached replay/effect state. Current consumer seeds last_snapshot from last_gsi_payload
  and can reconcile OBS in idle ticks: cold-unbound must not use this old cache to create a
  session, effects or bootstrap decisions. Use only fresh admitted GSI under the new epoch.

OBS is a separate concrete blocker: fence_external_handover currently requires a fresh
authoritative response whenever config.enabled, even if there is no game/session. Disabled
OBS already passes. For cold startup without running OBS, distinguish proven idle transport
from outstanding/ambiguous scene execution; defer new scene intents until authoritative
reconnect/readiness. Do not use cached scene name, absent pending flag alone or no game session
as proof. If old execution cannot be fenced/reconciled, keep the gate blocked. Keep the existing
hot fence unchanged. This is an admission/preflight adjustment in the current OBS integration,
not a new transport; no promise of exactly-once or clearing Unknown.

### 6. Disable before any session exists

Conceptually valid: close admission → Draining → stop/reap exact worker generation → game
audio/OBS fences → retain ledger/receipts → next BuiltIn epoch, session=None. Next legitimate
GSI/stream transition can create a real session through legacy lifecycle. No history restoration
or artificial session closure/outbox event is needed. Current fallback passes grant.session
into begin(), so its session-free branch must be added; recover_builtin_after_fence already
clears session/package and supports the desired final state after proven fencing.

## Options

Recommended minimum: session-less **host ownership/grant bootstrap**, with ordinary session-bound
IPC unchanged. The existing worker can handshake and wait without live_frame/live_effects.
Core resolves the first real session through existing facade/lifecycle under its exclusive
owner/package/generation guard; one transaction records resolved identity/revisions/receipt
and binds the owner. Only then send ordinary IPC with the actual session UUID/post-state.

This meets closed-Dota activation and later genuine-match startup without a protocol fork.
It does not yet preserve session-less External demo/pre-match sound playback: existing effect
IPC requires a session. Explicitly block such effects rather than silently keeping BuiltIn
sounds alongside External or using dummy identity. If sound/overlay/scene effects in demo
without any session are a product requirement, separately define owner/process-scoped effects
within IPC v1 and compatibility-check an updated signed worker; that is a contract extension,
not something to conceal as the minimal cold switch. Do not weaken match authorization.

## Recommendation

Minimal implementation plan using current modules:

1. Decouple package-only preparation verification from game-session grant. Leave backup,
   migration SQL and fence/coordinator behavior unchanged; classify not_prepared separately
   from SQLite errors. Keep Prepare and activation explicit.
2. Represent an unbound session as None in the existing host grant/ownership, only for a
   transaction-verified cold switch. Add an owner/package/process authorization check for
   the core-only session resolver. Ordinary match/effect authorization still requires Some.
   Do not change ExecutionScope's mandatory string or send unbound execution messages.
3. Reuse LiveDota::switch, LiveProcess::start and the Windows journal/supervisor. Quiesce,
   persist Draining, fence, handshake, advance epoch and show awaiting-session. Adjust only
   the cold OBS readiness case when absence of conflicting execution is proven.
4. Extend existing external_lifecycle's resolution path for None: genuine GSI or authoritative
   stream start creates/resumes real identity via Facade, not activation itself. Persist
   session binding plus lifecycle write-set/ledger/receipt in the same transaction. Use a
   stable bootstrap operation key scoped to epoch/generation, not a key per idle frame.
   Return the saved receipt on duplicate/crash-after-commit; no new UUID on retry. Update the
   actual grant/context from it before worker commands. Observe fresh GSI only.
5. Add session-free fallback to the existing path, including crash-before-first-GSI. Preserve
   the old bound/hot path and defaults; restart must never silently re-enable External.
6. Targeted tests: zero-session backup/preflight; cold round-trip with zero game rows; session
   arrival racing drain; first-GSI/bootstrap write-set and duplicate/crash receipts; no session
   from demo/idle; rejected unbound effect/reverse request; stale epochs/generation; quota/
   Unknown; audio with session=None/Twitch isolation; OBS off/reconnect/ambiguous execution;
   fallback before/after first session; unchanged hot identity/post-game/MMR/outbox parity.
   Finish with Windows native smoke; no extra architecture iteration/harness is required.

## Follow-up

Approve the cold-ready semantics and the explicit session-less-effects limitation before
implementation. No code or database changes, test/build runs, releases or main merge in this
audit. Only this durable report is saved. Running Dota is a restriction of today's session-bound
activation path, not a fundamental requirement of the installed plugin/process/ownership.

## Sources

Repository: core/dota_live.rs and ipc.rs; core/plugin_manager.rs and plugin_runtime.rs;
local_runtime/transaction_schema.rs, transaction_authorization.rs,
host_execution.rs and host_execution/external_lifecycle.rs; game_sounds/audio_fence.rs;
obs.rs; plugins/dota/src/main.rs, dota-domain/src/ownership.rs and match_execution.rs.
