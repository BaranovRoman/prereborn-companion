# WK-78: Companion backend-outage hang, Twitch Chat/TTS ownership, deploy concurrency

## Question

Three suspected reliability problems from real usage (2026-08-20), none confirmed:

1. Desktop Companion can "намертво зависнуть" (hard-hang) when the production backend is
   unreachable.
2. Twitch Chat/TTS might only work while the Chat tab is open.
3. Production crashed during a deploy; possible cause is two overlapping production builds.

This document records what was actually found for each, to fix the record independent of
the initial suspicion.

## Current state

- Companion (Tauri v2) never talks to `prereborn.ru` from the React frontend directly — only
  via Tauri IPC `invoke()` to the Rust side, which does the real HTTP calls
  (`apps/companion/src-tauri/src/backend/mod.rs`).
- Twitch chat delivery for the companion is polling-based: the backend (Node,
  `apps/api/src/services/twitch-eventsub-chat.ts`) owns a persistent per-user EventSub
  WebSocket and buffers up to 40 messages; the companion polls
  `/stream/companion/twitch-chat` every 1.5s.
- Production deploy: `.github/workflows/deploy-production.yml` (`workflow_run` on CI
  success on `main`) → SSH → `rsync` source → SSH runs `deploy.sh`, which does
  `pnpm install`/`next build`/API build directly on the production server, runs migrations,
  `pm2 startOrReload`.

## Findings

### 1. Backend-outage hang — confirmed root cause

Tauri v2 dispatches `#[tauri::command]` handlers one of two ways, verified by reading the
installed `tauri-macros-2.6.3`/`tauri-2.11.5` source (`tauri-macros-2.6.3/src/command/
wrapper.rs`, `tauri-2.11.5/src/ipc/command.rs`, `tauri-2.11.5/src/webview/mod.rs`):

- A plain (non-`async`) `fn` command runs via `body_blocking`, which calls the function
  **synchronously inline** (`ResponseTag::block`/`ResultTag::block` just call
  `resolver.respond(...)` directly — no thread spawn). This executes on whatever thread
  calls `WebviewWrapper::on_message`, i.e. the thread that dispatches WebView IPC messages
  (effectively the main UI thread on Windows/WebView2).
- An `async fn` command runs via `body_async`, which spawns the future onto Tauri's async
  runtime (tokio) worker pool via `resolver.respond_async_serialized(...)` — off the UI
  thread.

Before this fix, `get_twitch_chat` and `resend_current_state` (`commands.rs`) were plain
`fn` commands whose bodies did a blocking `reqwest` call with a 5s timeout
(`backend/mod.rs`). `get_twitch_chat` is invoked every 1.5s by `TwitchChatPage.tsx`'s poll
loop with no in-flight guard. When the backend was unreachable, each call could block the
main IPC/UI thread for up to 5s, and a new call could be dispatched before the previous one
returned — this is the concrete, code-verified mechanism for "Companion can hard-hang while
the backend is down," not a vague/unconfirmed symptom.

Secondary, lower-severity issue: `set_tts_enabled` (`commands.rs`) is (correctly) `async`,
but internally called a plain blocking `reqwest::blocking::get` with **no timeout at all**
for the first-run Piper voice/engine download (`tts.rs`) — this doesn't freeze the UI thread
(it's on the async pool), but could hang an async worker thread indefinitely if GitHub is
unreachable during that download.

No deadlock path was found: the app's single state `Mutex` is never held across network I/O
(payload/token are cloned out before any `reqwest` call). No WebSocket/SSE connection exists
to the backend (all backend traffic is HTTP polling); the only persistent WS is to local OBS,
which already has bounded (`2^attempt`, capped 30s) reconnect backoff.

### 2. Twitch Chat/TTS ownership — partially confirmed

The EventSub WebSocket connection itself is **not** page-bound: it's a backend (Node)
process-lifetime singleton (`chatConnections` map in
`apps/api/src/services/twitch-integration-service.ts`), independent of whether any companion
window/tab is open. The suspicion was unfounded for the connection specifically.

TTS playback, live message delivery, dedup, and the unread counter **were** page-bound: all
of it lived inside `TwitchChatPage.tsx`'s own `setInterval` poll loop and component-local
refs (`known`, `queue`, `traces`, etc.). Closing the Chat tab cleared the interval, which
stopped polling, which stopped both TTS and any live delivery to the UI — confirmed real bug,
scoped exactly to delivery/TTS, not the underlying connection.

### 3. Deploy concurrency — not proven, but a real gap found

The GitHub Actions `concurrency: group: prereborn-production` (added before this
investigation) does prevent two *separate, normally-completing* workflow runs from
overlapping. Across the 20 most recent `deploy-production` runs and 30 most recent `CI` runs
(`gh run list`), no two distinct run IDs had overlapping start/end timestamps.

However, run `32269912490` (2026-08-19, deploying commit `cee9578`) shows:

| Attempt | Window (UTC) | Result | Detail |
|---|---|---|---|
| 1 | 15:24:58–15:35:21 | cancelled by @BaranovRoman | `next build` logged nothing for 10+ min before cancel |
| 2 | 15:36:36–15:41:07 | failure | Even `mkdir -p` hung 4m21s, then `kex_exchange_identification: read: Connection reset by peer` |
| 3 | 17:02:59–17:05:44 | success | Normal (~2m15s build) after an ~82 min gap |

Cancelling attempt 1 in GitHub Actions only kills the **runner's local** `ssh` client
(confirmed in the run log: `Terminate orphan process: pid (...) (ssh)`); nothing in the
workflow or `deploy.sh` guaranteed the **remote** build process tree was killed. If that
remote build was still running when attempt 2 started a fresh `pnpm build` ~1 minute later,
two concurrent production builds is a plausible (not directly observable from GitHub Actions
logs alone — no server shell access in this investigation) explanation for sshd becoming
unresponsive between 15:35–15:41. This is the one inferential step in an otherwise
timestamp-backed chain. No second, independently-triggered workflow run was involved.

## Options considered

For the deploy gap: (a) do nothing beyond the existing GH Actions concurrency group — leaves
the cancel-and-retry race open; (b) add a server-side `flock` around `deploy.sh`'s critical
section — cheap, standard, self-releasing on process exit, closes the gap regardless of *why*
a previous invocation is still running; (c) migrate to building off-server (CI build artifact
→ deploy artifact) — removes the resource-contention risk entirely but is a real architecture
change, out of scope for this ticket per its stated constraints.

## Recommendation

(b) — implemented in this ticket: `deploy.sh` now takes a non-blocking `flock` on
`/tmp/prereborn-production-deploy.lock` (deliberately outside the rsync'd `DEPLOY_PATH`, so a
second run's `rsync --delete` step can never unlink the lock file out from under an active
lock) around the entire script body. A second invocation fails fast with a clear message
instead of racing a live build. The lock is released automatically by the OS when the holding
process's file descriptor closes (normal exit, `set -e` failure, or the process being
killed) — no trap/cleanup logic needed, and no lock can survive past the process holding it.

## Follow-up

- **Build-outside-production migration** (`CI build artifact → production deploy artifact →
  migrate/reload/switch`) is a legitimate longer-term follow-up: it would remove the
  resource-contention failure mode at its root (no build ever competes with the running
  server for CPU/RAM) and enable near-zero-downtime deploys. Not implemented here — it's a
  real architecture change (build reproducibility across environments, artifact storage/
  versioning, a switch-over mechanism) that deserves its own ticket and design, not a
  bolt-on to a reliability-hardening ticket.
- The `flock` fix could not be exercised against the real production server (no SSH access
  from this environment) — `flock` behavior was verified by reading `deploy.sh`'s logic and
  is standard `util-linux` behavior on the Ubuntu server this targets, but the first real
  deploy after this change is the first live verification.

## Sources

- `tauri-macros-2.6.3/src/command/wrapper.rs`, `tauri-2.11.5/src/ipc/command.rs`,
  `tauri-2.11.5/src/webview/mod.rs` (installed crate sources, read locally) — Tauri v2
  command dispatch (blocking vs. async execution context).
- `gh run list --workflow=deploy-production.yml` / `gh run view <id> --log` (GitHub Actions
  history for this repository).
