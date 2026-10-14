# Dota Windows native acceptance

Do not run against a public catalog/app candidate until its exact assets are approved.
0.5.91 alone cannot activate External. The new Companion candidate is required. The candidate
must preserve the existing identifier/data paths and BuiltIn default. No automatic migration.

Before starting, end the current real stream. Record installed version and existing history;
close Companion and preserve a separate copy of its app data. Do not move/delete the live DB.
Have OBS WebSocket available and current scene mappings saved. Do not restore an older SQLite
copy once new records exist. Do not downgrade Companion while ownership is Draining/External.

| Step | Exact action | Expected result | Failure / safe stop |
| --- | --- | --- | --- |
| 1 | Install the approved Companion candidate; open Twitch/TTS, OBS and BuiltIn Dota first. | Existing login/settings/history preserved; BuiltIn remains default, one listener on 127.0.0.1:3665; no plugin process. | Stop testing if BuiltIn regresses; retain diagnostics. Do not prepare migration. |
| 2 | Plugins → Refresh catalog → Dota 2 for Windows → Install. | Real official HTTPS ZIP is verified against the shipped plugin key and hashes; installed disabled, no worker. | 404, signature/hash/API error is a blocker. Do not use local/developer installation or change keys. |
| 3 | Begin a normal BuiltIn session so current session identity exists. In Dota controls tick the explicit confirmation; click Prepare backup and migration. | A consistent `local-runtime.pre-external.sqlite3` is created beside existing `local-runtime.sqlite3`; additive safety tables validated; runtime returns built_in with epoch/quota. | Any timeout, OBS failure, invalid backup/schema or Draining: stop game testing, keep DB/backup unchanged; use explicit fence/recovery only after the displayed issue is fixed. |
| 4 | Keep a Twitch TTS utterance plus another queued message running. Trigger a game sound/reminder; click Enable External Dota. | Game-only audio is stopped/acknowledged; Twitch speech/queue continues. Runtime external with a newer epoch and one companion-dota-plugin.exe; one GSI listener. | Unconfirmed audio/OBS/process fence must block switching. Never force clear Unknown or enable registry flags. |
| 5 | Play real Dota: draft → gameplay → hero/item/ability events → post-game. | Existing sounds/reminder and mapped OBS scenes/overlay work; one match with stable UUID/key and correct inventory/history, no duplicate outbox. | If sounds/scenes/history duplicate or queue loss/fallback occurs, stop External using its button; capture errors/quotas and scenario. No raw/account GSI export. |
| 6 | Change OBS mapping, switch a scene manually, disconnect/reconnect OBS and stop/start stream. | Fresh authoritative OBS replies reconcile desired state; no blind scene retry, lifecycle/session identity stays correct. | Unknown or blocked transition stays blocked. Restore OBS connectivity/config; request explicit fences/recovery. Cached names are not proof. |
| 7 | While game audio and Twitch TTS are active, click Disable External → BuiltIn. | External worker exits, game audio cancels, Twitch TTS continues, newer BuiltIn epoch; next GSI has no replayed sound/history writes. Enable again once and repeat. | If Draining/Unknown, do not kill unrelated processes or restore backup; keep diagnostics. Retry disable after terminal audio ACK or use explicit recovery. |
| 8 | With no pending sound first, end only the worker; repeat by ending only Companion in Task Manager, then restart. Inspect leftover companion-dota-plugin.exe before recovery. | No automatic External restart. Uncertain journal blocks takeover. Confirm fences and return BuiltIn explicitly; generation job fences the actual worker/tree, no PID-based inference. | Orphan/unknown stop proof must remain blocked. Do not kill by guessed PID. Stop test if new owner runs before confirmed fencing. |
| 9 | Repeat crash with queued/playing game audio and with interrupted OBS response. | Durable Unknown is preserved; no automatic replay. Recovery may intentionally be denied until the exact result can be confirmed. | Record the displayed error and Unknown count; stop rather than clear ledger/restore backup. This case is not success merely because app restarts. |
| 10 | Finish a match, review history/ratings/outbox and quota, disable External, restart normally. | Correct single history write, no lost identity, quota visible; BuiltIn on restart and no worker auto-start. | Preserve diagnostics and DB; report any stale revision, exhaustion, missing session or duplicate write. |

Return: candidate version/commit, plugin version, screenshot of runtime/epoch/quota before and
after switch, results per step, and the exact error for each blocked transition. Share no tokens,
OBS passwords, account IDs or raw GSI. CI results alone do not complete this acceptance.
