# Read-only core API and durable ownership — iteration 6

## Question

How can external Dota read bounded host state and persist future exclusive ownership/effect identity without switching the working live runtime or changing the user match database?

## Current state

Normal startup still bootstraps built-in Dota and owns GSI, OBS, audio, SQLite/outbox and backend sync. Installed external `dota2` enable/start/restore remains blocked. The debug replay lab bypasses live bootstrap; it now opens only a separate infrastructure store and explicitly grants read-only capabilities to its verified Dota worker. No game algorithm, existing settings/path/identifier/updater or user history schema changed.

## Findings

### Read-only surface

Typed `core_read::ReadRequest/ReadResponse` define six queries:

| Query | Response | Bounds and omissions |
|---|---|---|
| `obs` | Last observed connection boolean | No password, host, port or raw error |
| `scenes` | Configured semantic broadcast-state identifiers | At most four; no scene names or switching; not proof that OBS currently contains those scenes |
| `stream` | Observed OBS streaming, session-ended and cached Twitch connection | Unknown stays null; no Twitch messages/tokens/account identifiers |
| `sounds` | Enabled, volume, known catalog event IDs | Volume 0–100, at most 40 IDs plus truncation flag; no asset names/IDs, paths or file access |
| `history` | Recent finalized match hero, win/loss and K/D/A | Limit 1–20; fixed numeric projection; no raw inventory, account/session/backend IDs or user SQL |
| `backend` | Unknown/connected/recovering/unavailable | Existing cached retry state, no network call, URL, token or raw error |

The provider checks per-query `ReadCapability` before touching state/storage and rejects invalid limits. Every serialized response is capped at 8 KiB; unavailable history/storage is an explicit typed error, not a fabricated empty history. Debug lab has no live services/history initialization, so default/unknown/unavailable responses there are expected. The provider is tested with populated synthetic state and a temporary in-memory history fixture.

`dota.core_read` runs through the existing Plugin Runtime. The worker validates its query and sends one correlated reverse `CoreRead` IPC v1 frame; the host supplies a typed `CoreReadReply`, and the worker returns the existing Reply. Reverse requests are allowed only for verified identity `dota2`, during that command, matching its correlation ID, once per command. Unsolicited/multiple/wrong-owner requests fail closed. Default runtime calls have no read grants. The lab installs the reader callback explicitly; Hello gains no command, grants or provider access. Existing frame bound/timeout/reaping behavior remains. This is an additive paired prototype protocol feature; older hosts do not support these reverse frames and fail closed. No catalog/update/public compatibility claim is made.

The parent debug page has a whitelisted Read selector; the iframe still has no Tauri API. Existing replay bridge permissions are unchanged, and the read response crosses the actual external process. No live effect command is dispatched.

### Storage and ownership

Host-only `core/plugin_durable.rs` uses the already installed rusqlite/sha2 dependencies. The separate namespace is **existing app-data root / `plugins/infrastructure/dota-control.sqlite3`**. Only explicit Dota diagnostic setup opens it; normal live bootstrap and user match database are untouched. Ownership/ledger APIs are host Rust methods, not plugin/UI IPC capabilities.

Schema 1 stores a singleton typed ownership phase, canonical effect identities/statuses, and acknowledgements in one bounded JSON record, protected by SHA-256 checksum and SQLite transactions. Opening checks SQLite `quick_check`, schema version, checksum, strict deserialization, epochs, entry bounds and ledger/ack consistency. Corrupt/unsupported files are refused and never deleted/recreated. This detects accidental record damage, not authenticated rollback of a whole valid DB snapshot. Physical loss/administrative deletion must not be used as a live recovery procedure.

SQLite DELETE journal, FULL synchronous mode, IMMEDIATE transactions and a retained EXCLUSIVE connection lock prevent two infrastructure coordinators from opening the file simultaneously. This deliberately favors one local coordinator over concurrent readers. A busy/error store refuses access; it does not affect the normal built-in runtime.

New storage starts with a conceptual BuiltIn lease at epoch 1, still unconnected to GSI. On reopen, any previous Active becomes Draining with the same old lease and recovery target; previous Draining or Vacant remains unchanged. No request is admitted in Draining/Vacant. Reopening is never proof of fencing. Only trusted host confirmation of paused ingestion, drained work and fenced/reaped previous owner advances epoch; increments are checked for overflow. Confirmed crash stays Vacant until explicit recovery. Rollback uses the same state machine with a fresh epoch. There is no automatic new-owner activation or integration with the live consumer.

### Effect identity and transactions

The durable wrapper reuses the iteration-5 Ledger admission/ack rules, not a second effect algorithm. Stable operation keys remain valid across owner epochs. Same key/payload returns `duplicate: true` and the saved status; changed payload conflicts. Persisted records include canonical payload identity and correlated acknowledgement. Accepted becomes Unknown after reopening, in both ledger and acknowledgement; Completed/Rejected stay terminal. Unknown is queried/reconciled and never treated as new permission to execute. Stale leases cannot admit/acknowledge. No real OBS/sound/backend/overlay executor exists.

Ledger bounds are 256 retained operations and a 1 MiB record; capacity errors fail closed. Records are not evicted automatically. Retention/schema growth must be designed before live use. `admit_with` offers a **trusted core-only** SQLite transaction hook, invoked only for new admission. Its local DB writes, ledger and acknowledgement commit/rollback together. No plugin SQL is accepted. Tests prove rollback and duplicate-hook suppression. Future match/outbox tables must use this same transaction/database (or another explicitly designed durable transaction boundary). This does **not** provide atomicity with today's separate `local-runtime.sqlite3` connection; deciding that migration is a prerequisite for live match writes, and was deliberately not implemented here.

### Targeted verification

- Durable store: 6 passing tests, including reopen, exclusive-lock rejection, persisted Draining, stale epoch, explicit Vacant recovery, duplicate/conflicting payload, Unknown/terminal ack persistence, atomic rollback and corrupt-file refusal.
- One of those tests starts a child test process, commits admission/Draining, writes uncommitted corruption and exits with code 73 without destructors. Reopen recovers committed Draining/Unknown and refuses automatic activation. The child fixture is ignored as a standalone test and explicitly invoked by its parent.
- Read provider: 3 passing tests for all capability denials, bounds, credential/URL/path omission and limited history without mutations, and non-panicking poisoned-store handling.
- Actual host runtime read round-trip: 1 passing test, including deny-by-default and unchanged Hello access.
- External IPC/replay/parity: 4 passing process tests; protocol frame validation: 1 passing test.
- Shared effect and ownership models: 4 + 2 passing selected tests. Lab production/command/asset guards: 3 passing tests.
- Selected frontend boundary tests: 2 passing tests. TypeScript passed. Host Rust check passed; unused durable-method warnings reflect the intentionally absent live dispatcher.

No full suite, production build, Tauri installer/app bundle, UI/old overlay/Silero rebuild, native WebView/Windows/game smoke, cache deletion or dependency install. Power loss/OS filesystem durability, Windows SQLite locking, real observed connectivity during streaming and native read controls remain unverified.

## Options

1. Add ledger tables to existing match DB now: changes user schema and live startup, contrary to this iteration's constraints.
2. Isolate infrastructure in a new namespace, prove durable recovery and a transaction hook; expose only bounded reads. Chosen.
3. JSON file replacements or automatic recreation after corruption: weaker transactions/recovery and possible operation replay. Rejected.

## Recommendation

Keep all durable APIs disconnected from real ingestion/effects. Continue explicit read-only grants for Dota diagnostics; do not give Hello or installed packages generic core access. Treat the separate DB as infrastructure for the next migration decision, not an already active live ownership authority.

## Follow-up

Next design durable state restoration and effect reconciliation with no execution: full match/history/outbox transaction payloads, retention beyond 256 keys, epoch/fence proof integration and safe rollback. Decide the single transaction location before any match writes. Expand replay fixtures and read-provider projections as needed. After an explicitly approved stage, run native sandbox/read UI and Windows recovery/locking smoke. Only then consider a fenced opt-in live handover. Current GSI ingestion, match detector/store/watchdog, OBS scheduler/reconnect, audio/deduplication, backend serialization/auth and live overlay/UI remain dependencies.

## Sources

Repository: `core/{plugin_runtime,plugin_read,plugin_durable}.rs`, `plugin_lab.rs`, `plugins/{protocol,dota-domain,dota}`, existing `state.rs`, Dota/core state, sound settings/catalog and `local_runtime` fixed history schema. Actual sources/callers and focused tests were read; no external sources were needed.
