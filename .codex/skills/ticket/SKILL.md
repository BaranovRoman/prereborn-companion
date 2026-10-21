---
name: "ticket"
description: >
  Take a Weeek ticket end-to-end through a production release: fetch it via MCP, move it to In
  Progress, branch off the release branch, implement it ($gsd-quick), run checks, commit, push,
  open a PR, then deploy the API and/or release Companion/plugins per AGENTS.MD "Ticket →
  Release", verify the release and report. It stops at the PR only for the reasons in step 12
  (e.g. the user said not to release, or checks/CI fail). Use when the user says "/ticket <id>",
  "$ticket WK-123", "work ticket 123", or pastes a Weeek task URL.
metadata:
  short-description: "Weeek ticket -> implementation -> production release"
---

# ticket — Weeek ticket → implementation → production release

- This skill is invoked by mentioning `$ticket`. Treat all user text after `$ticket` as the ticket
  reference (bare number, `WK-123`, or a Weeek task URL).
- Any question this skill needs to ask the user (see step 3) should use Codex's `request_user_input`
  tool. If that tool is unavailable, fall back to a plain-text numbered list and wait for the
  user's reply — do not guess and continue (see gsd-help's adapter notes for the general pattern).

Pet-project flow: no workstreams, no wiki-sync, no per-phase review gates, no milestone path.
One ticket = one branch = one `$gsd-quick` run = one PR = one production release.

## Procedure

1. **Resolve the ticket id.** Accept a bare number (`123`), `WK-123`, or a Weeek task URL — extract
   the digits. `ID=<digits>`, `BRANCH=feat/<digits>`.

2. **Fetch the ticket.** Call the weeek MCP server's "get task" tool with `task_id=ID` → title,
   description, acceptance criteria, `boardId`, `boardColumnId`. Summarize in 2–3 lines for the
   user. If the MCP call fails (no token configured yet, server down), tell the user and stop —
   don't guess ticket content.

3. **Resolve columns dynamically — never hardcode IDs.** Call the weeek MCP "list board columns"
   tool with `board_id=<boardId from step 2>`. Match columns by name (case-insensitive): a
   "To Do"-like column (`to do`, `backlog`, `к выполнению`) and an "In Progress"-like column
   (`in progress`, `doing`, `в работе`). If names don't clearly match, list the columns and ask
   the user once via `request_user_input` which is which, then proceed — do not invent an ID.

4. **Move to In Progress (guarded).** Only if the ticket's current `boardColumnId` is the resolved
   To-Do column: call the weeek MCP "move task" tool with `task_id=ID`,
   `board_column_id=<in-progress id>`. If it's already past To Do, leave it — never move a ticket
   backward.

5. **Create the branch.** `BASE` is the release branch named in AGENTS.MD ("How releases actually
   ship here"), currently `codex/plugin-runtime-prototype`, not the stale `main`. Fall back to
   `git symbolic-ref refs/remotes/origin/HEAD` only if AGENTS.MD names none. Then:
   ```bash
   git fetch origin "$BASE"
   git switch "$BRANCH" 2>/dev/null || git switch -c "$BRANCH" --no-track "origin/$BASE"
   ```

6. **Plan + implement with GSD.** Invoke `$gsd-quick` with a concise task description built from the
   ticket title/description/acceptance criteria. Use plain `$gsd-quick "<task>"` by default; use
   `$gsd-quick --full "<task>"` only if the ticket is clearly multi-step or risky (judge from the
   description — don't ask unless genuinely ambiguous). No workstream flags needed.

7. **Run relevant checks only.** Based on which `apps/*` the diff touched
   (`git diff --name-only "origin/$BASE"...HEAD`), run just that package's lint/typecheck/test via
   `pnpm --filter <pkg> ...` (see root `package.json` scripts). Don't run the full monorepo suite for
   a small ticket.

8. **Commit and push.**
   ```bash
   git add -A
   git commit -m "<short summary> (WK-$ID)"
   git push -u origin "$BRANCH"
   ```
   (`$gsd-quick` may already have committed as part of its own flow — don't double-commit; just push.)

9. **Open a draft PR (idempotent).**
   ```bash
   gh pr view "$BRANCH" --json url >/dev/null 2>&1 \
     && gh pr edit "$BRANCH" --title "[WK-$ID] <short title>" \
     || gh pr create --draft --base "$BASE" --head "$BRANCH" \
          --title "[WK-$ID] <short title>" --body "<problem / solution / UAT steps derived from the ticket's acceptance criteria>"
   ```
   Capture the PR URL (`gh pr view "$BRANCH" --json url -q .url`).

10. **Write the PR URL back to Weeek.** Call the weeek MCP "set task MR link" tool with `task_id=ID`,
    `mr_url=<pr url>`. If it errors (e.g. no "МР"/MR custom field configured on this Weeek project),
    report that plainly and continue — it's not fatal.

11. **Release to production (default).** Follow AGENTS.MD → "Ticket → Release" and "How releases
    actually ship here". With checks and CI green:
    - **API/web changed** → put only those changes on a branch from `origin/main`, PR to `main`,
      merge after CI, wait for `deploy-production.yml`, then confirm `/api/health` `releaseSha` is
      the new commit. Always do this before any Companion release that depends on it.
    - **Changelog first (any Companion or plugin release).** Before merging, the ticket PR must add
      the Russian user-facing entry for the new version to `changelog/companion.md` or
      `changelog/plugins/<id>.md` (format: `changelog/README.md`; check with
      `node scripts/changelog.mjs check --companion X.Y.Z` / `--plugin <id> X.Y.Z`). No commit
      messages or ticket numbers in it. A release without its entry is not finished, and the
      workflows reject it.
    - **Companion changed** → `gh pr ready`, merge the PR into the release branch, push the next
      stable `prereborn-vX.Y.Z` tag on it. SemVer: minor for features, patch for fixes. Read the
      current version from `latest.json` and the existing tags first. Then watch
      `windows-release.yml` and verify the GitHub Release and the `latest.json` version.
    - **Plugins changed** → publish the plugin package and catalog through their pipeline; create
      the plugin's GitHub Release with
      `--notes-file <(node scripts/changelog.mjs notes plugin <id> X.Y.Z)`.
    After the release, confirm the entry appears on https://prereborn.ru/changelog (within 10 min).
    - **API-only ticket** → no Companion release.
    Then move the ticket to the user-acceptance column (Review-like, e.g. `ревью`), not Done, and
    report: versions, PR/CI/release links, verification results, and what the user should check
    on production. Do not claim real Twitch/OBS/Dota behavior is verified without real testing.
    The environment's permission prompts still apply. Ask through them; never work around them.

12. **Stop at the PR instead of releasing** only when:
    1. the user explicitly said not to release this ticket, or to stop at PR/review;
    2. required checks or CI are failing;
    3. a migration is unconfirmed;
    4. there's a known critical regression;
    5. there's a blocker or an unresolved product/design decision;
    6. scope grew beyond what's safe to resolve inside this ticket.
    In that case, report why and what is left.

## Guardrails

- Status moves only ever advance; never move a ticket backward.
- Never hardcode Weeek board/column IDs — always resolve via the "list board columns" tool at
  runtime.
- Merge/ready/tag only as part of step 11's release, and never with failing checks or CI.
- If the weeek MCP server is unavailable, ask the user to paste the ticket body and continue with
  the git/PR steps only (skip the board moves).
