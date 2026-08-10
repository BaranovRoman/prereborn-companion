---
name: "ticket"
description: >
  Take a Weeek ticket end-to-end: fetch it via MCP, move it to In Progress, branch off main,
  run a short GSD plan ($gsd-quick) to implement it, run relevant checks, commit, push, open a
  GitHub draft PR, and write the PR URL back to the ticket — then stop. Does NOT mark the PR
  ready for review or move the ticket to Review; that's the separate `review-pr` skill, run
  later after a manual look at the diff/PR. Use when the user says "/ticket <id>", "$ticket
  WK-123", "work ticket 123", or pastes a Weeek task URL.
metadata:
  short-description: "Weeek ticket -> GSD -> draft PR"
---

# ticket — Weeek ticket → GSD → draft PR

- This skill is invoked by mentioning `$ticket`. Treat all user text after `$ticket` as the ticket
  reference (bare number, `WK-123`, or a Weeek task URL).
- Any question this skill needs to ask the user (see step 3) should use Codex's `request_user_input`
  tool. If that tool is unavailable, fall back to a plain-text numbered list and wait for the
  user's reply — do not guess and continue (see gsd-help's adapter notes for the general pattern).

Pet-project flow: no workstreams, no wiki-sync, no per-phase review gates, no milestone path.
One ticket = one branch = one `$gsd-quick` run = one draft PR.

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

5. **Create the branch.** Resolve the default branch (`git symbolic-ref refs/remotes/origin/HEAD` or
   fall back to `main`), then:
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

11. **Stop.** Report: ticket summary, branch, PR URL, Weeek link-write result, and current board
    column. Do not mark the PR ready and do not move the ticket to Review — that's `review-pr`,
    run later once the diff/PR has been looked at.

## Guardrails

- Status moves only ever advance; never move a ticket backward.
- Never hardcode Weeek board/column IDs — always resolve via the "list board columns" tool at
  runtime.
- Never merge the PR and never mark it ready for review from this skill.
- If the weeek MCP server is unavailable, ask the user to paste the ticket body and continue with
  the git/PR steps only (skip the board moves).
