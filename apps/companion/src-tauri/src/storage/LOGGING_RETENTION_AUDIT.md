# Companion logging/retention re-audit (WK-129)

Re-audit after Twitch chat, TTS, OBS automation, backend sync, local-runtime
(SQLite) and game_sounds were added on top of the WK-79 fix (an always-on
per-GSI-tick raw payload file, ~117k files from ~80 matches, since removed).

Question re-asked for every new subsystem: does anything write one file per
GSI tick/event outside a diagnostics-only gate, or retry-log to disk without
a cap during a sustained failure? Answer: no. One real gap was found and
fixed (rotation robustness, below); everything else already has a documented,
tested bound.

## Source inventory

| Source | Where | Trigger | Bound |
|---|---|---|---|
| App rolling log (`app.log`) | `storage/mod.rs::append_rolling_log` | ~20 call sites incl. every GSI tick (`server/mod.rs`) | 5MB cap, rotates to `app.log.1`; hardened this pass so a failed rotation truncates in place instead of growing unbounded (see below) |
| Legacy GSI payload cleanup | `storage/mod.rs::cleanup_legacy_payloads` | Once at `clear_logs` / startup safety net | O(1) directory staging + background delete; not a writer |
| Diagnostics snapshots/diffs | `diagnostics/session.rs::commit_snapshot` | Per meaningful GSI change, only while a diagnostics session is explicitly running | 150MB cap (`SIZE_LIMIT_BYTES`), stops snapshot/diff files once reached |
| Diagnostics `errors.jsonl`/`timeline.jsonl`/`tts-trace.jsonl` | `diagnostics/session.rs` | Per parse error / meaningful change / TTS event, opt-in session only | Deliberately not gated by the 150MB cap (documented at `session.rs:176-182`) — each entry is tiny and stays useful after snapshots stop; still counted into the session's own byte total. Session itself is idle-watchdog-terminated after 90s of GSI silence. |
| Diagnostics export ZIP | `diagnostics/export.rs::export_zip` | User-triggered only | Single user-chosen path, one-shot |
| Backend GSI heartbeat | `backend/mod.rs::record_connectivity` | Per send attempt, but logs only on state transitions | Capped exponential backoff (max 30s), explicitly engineered against log-crowding (see its own doc comment) |
| Local-runtime sync outbox | `local_runtime/sync.rs::drain_outbox` | Every `DRAIN_INTERVAL` (2s) tick, one row per call, backoff-gated | Backoff capped at 60s/row; 7-day retention, hourly purge (`purge_delivered`); a `Retryable` outcome returns after logging one line, so disk writes are naturally capped at ~1 per drain tick even with a large backlog |
| local_runtime SQLite (`local_sessions`/`local_matches`) | `local_runtime/store.rs::update_match_telemetry` | Per GSI tick during a match | In-place `UPDATE` on a fixed row — no row/file growth from tick rate |
| game_sounds detection/confirmation | `game_sounds/mod.rs`, `game_sounds/events.rs` | Only on an actual detected event or pending-confirmation transition, never per raw tick | `PendingConfirmations` is in-memory, self-evicting via `.retain()`; disk footprint rides on `app.log`'s own cap |
| TTS scratch files (Silero) | `silero.rs::synthesize` | Per spoken message | Written then immediately deleted after read-back; stale leftovers swept on every sidecar respawn |
| Chat bounded queues (frontend) | `chat/chat-model.ts`, `chat/useTwitchChatSession.ts` | Per incoming chat message | Fixed in-memory caps (queue limit 3, seen-set 160, trace map 200); no disk footprint beyond a single `localStorage` settings key |
| Frontend event-history ring buffer | `src/storage/eventHistory.ts` | Per GSI event surfaced to UI | `MAX_ENTRIES=50`, single `localStorage` key |
| Settings/config files | `storage/mod.rs`, `hotkeys.rs`, `gsi/config.rs`, `game_sounds/config.rs` | User changes or periodic refresh | Single fixed path, full overwrite each time — no accumulation |
| Custom game sound assets | `game_sounds/assets.rs` | User upload/delete | User-managed lifecycle; not touched by any cleanup logic |

## Fixed this pass

**`storage::rotate_if_needed` didn't handle a failed rotation.** If
`fs::rename(app.log, app.log.1)` ever failed (e.g. the rotated file locked by
an AV/OneDrive scan — the same class of interference already called out in
the WK-109 doc comment above this function), the error was swallowed and
`app.log` kept growing past its 5MB cap indefinitely, since every later
`append_rolling_log` call only re-checked the size and re-attempted the same
rename. Now a failed rotation truncates the file in place instead, so it
stays bounded even when normal rotation can't proceed. Covered by
`rotate_if_needed_truncates_in_place_when_rotation_fails` (forces the failure
portably by making the rotation target an existing directory) and
`append_rolling_log_never_exceeds_the_cap_across_many_rotations`.

## Confirmed sound, no change made

- `storage::parse_payload` still has no `AppHandle`/path parameter — the
  WK-79 pattern (a file per GSI request) is structurally impossible, not
  just avoided by convention. Regression-tested.
- The per-tick `app.log` line in `server/mod.rs` was considered for removal
  (it's the highest-volume single write into a shared, size-capped log) but
  kept as-is: it was the exact evidence used to diagnose the WK-109 throttle
  bug (a uniform ~1.14-1.17s gap between consecutive GSI request lines), so
  removing it would trade away real forensic value for a log source that is
  already bounded in total bytes.
- `local_runtime::sync` logs on every retryable failure rather than only on
  transitions (unlike `backend::record_connectivity`). Left as-is: the
  `return` after each `Retryable` outcome already caps it at one write per
  drain tick regardless of backlog size, so it cannot grow unbounded — it's
  a noise/consistency question, not a retention bug.
- Custom game sound assets are never touched by any cleanup/retention logic
  (verified in `game_sounds/assets.rs`).
