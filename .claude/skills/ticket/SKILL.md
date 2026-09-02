---
name: ticket
description: >
  Take a Weeek ticket end-to-end: fetch it via MCP, move it to In Progress, branch off main,
  implement it (via gsd-quick when this repo has GSD planning set up, otherwise directly), run
  relevant checks, commit, push, open a GitHub draft PR, and write the PR URL back to the ticket
  — then stop by default. Does NOT mark the PR ready for review or move the ticket to Review;
  that's the separate `review-pr` skill, run later after a manual look at the diff/PR — UNLESS
  the task prompt itself explicitly requires full delivery without approval (see "Delivery
  policy" below), in which case it continues through merge and release. Use when the user says
  "/ticket <id>", "/ticket WK-123", "work ticket 123", or pastes a Weeek task URL.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - Skill
  - mcp__weeek__weeek_get_task
  - mcp__weeek__weeek_list_board_columns
  - mcp__weeek__weeek_move_task
  - mcp__weeek__weeek_set_task_mr_link
---

# /ticket — Weeek ticket → GSD → draft PR

Pet-project flow: no workstreams, no wiki-sync, no per-phase review gates, no milestone path.
One ticket = one branch = one implementation pass (`gsd-quick` where this repo has GSD planning
set up, direct implementation otherwise) = one draft PR.

## Procedure

1. **Resolve the ticket id.** Accept a bare number (`123`), `WK-123`, or a Weeek task URL — extract
   the digits. `ID=<digits>`, `BRANCH=feat/<digits>`.

2. **Fetch the ticket.** `mcp__weeek__weeek_get_task(task_id=ID)` → title, description, acceptance
   criteria, `boardId`, `boardColumnId`. Summarize in 2–3 lines for the user. If the MCP call fails
   (no token configured yet, server down), tell the user and stop — don't guess ticket content.

3. **Resolve columns dynamically — never hardcode IDs.** `mcp__weeek__weeek_list_board_columns(board_id=<boardId from step 2>)`.
   Match columns by name (case-insensitive): a "To Do"-like column (`to do`, `backlog`, `к выполнению`)
   and an "In Progress"-like column (`in progress`, `doing`, `в работе`). If names don't clearly
   match, list the columns and ask the user once via `AskUserQuestion` which is which, then proceed
   — do not invent an ID.

4. **Move to In Progress (guarded).** Only if the ticket's current `boardColumnId` is the resolved
   To-Do column: `mcp__weeek__weeek_move_task(task_id=ID, board_column_id=<in-progress id>)`. If it's
   already past To Do, leave it — never move a ticket backward.

5. **Create the branch.** Resolve the default branch (`git symbolic-ref refs/remotes/origin/HEAD` or
   fall back to `main`), then:
   ```bash
   git fetch origin "$BASE"
   git switch "$BRANCH" 2>/dev/null || git switch -c "$BRANCH" --no-track "origin/$BASE"
   ```

6. **Plan + implement.** If this repo has GSD planning set up (`.planning/ROADMAP.md` exists),
   invoke the `gsd-quick` skill with a concise task description built from the ticket
   title/description/acceptance criteria — plain `gsd-quick "<task>"` by default, `gsd-quick --full
   "<task>"` only if the ticket is clearly multi-step or risky (judge from the description — don't
   ask unless genuinely ambiguous), no workstream flags needed. **If `.planning/ROADMAP.md` does not
   exist**, `gsd-quick` will hard-error requiring it — don't create `.planning/` scaffolding just to
   satisfy that path; implement the ticket directly instead (read the relevant code, make the
   scoped change, self-review) and continue with step 7.

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
   (gsd-quick may already have committed as part of its own flow — don't double-commit; just push.)

9. **Open a draft PR (idempotent).**
   ```bash
   gh pr view "$BRANCH" --json url >/dev/null 2>&1 \
     && gh pr edit "$BRANCH" --title "[WK-$ID] <short title>" \
     || gh pr create --draft --base "$BASE" --head "$BRANCH" \
          --title "[WK-$ID] <short title>" --body "<problem / solution / UAT steps derived from the ticket's acceptance criteria>"
   ```
   Capture the PR URL (`gh pr view "$BRANCH" --json url -q .url`).

10. **Write the PR URL back to Weeek.** `mcp__weeek__weeek_set_task_mr_link(task_id=ID, mr_url=<pr url>)`.
    If it errors (e.g. no "МР"/MR custom field configured on this Weeek project), report that plainly
    and continue — it's not fatal.

11. **Stop by default, unless the task's own delivery policy says otherwise (see below).** Report:
    ticket summary, branch, PR URL, Weeek link-write result, and current board column. Do not mark
    the PR ready and do not move the ticket to Review — that's `/review-pr`, run later once the
    diff/PR has been looked at.

## Delivery policy

Using this skill is, by itself, never a reason to stop at the draft PR — the reason is the
default in step 11. **An explicit delivery instruction in the task prompt takes precedence over
that default.**

If the task prompt itself explicitly requires taking the change through merge and release without
waiting for approval (e.g. "if implementation is done, checks are green, and there's no blocker,
merge and ship to production" / "don't stop at Draft PR"), and all of the following hold:

- implementation is complete;
- required local checks are green;
- CI is green;
- no blocker;
- the task does not require visual/product approval;

then skip step 11's default stop and continue instead: `gh pr ready` → verify CI → merge → cut the
next release per this project's release process → verify the release → move the ticket to Done.

Stop at the draft PR (step 11's default) instead whenever any of these hold, even if the task
otherwise asked for full delivery:

1. the user explicitly asked to stop at PR/review;
2. the task requires visual/product approval;
3. there's a blocker or an unresolved product/design decision;
4. the change is risky and the task itself sets a manual gate;
5. required checks or CI are not green;
6. scope expanded beyond what's safe to resolve inside this task.

## Guardrails

- Status moves only ever advance; never move a ticket backward.
- Never hardcode Weeek board/column IDs — always resolve via `weeek_list_board_columns` at runtime.
- Never merge the PR and never mark it ready for review from this skill — unless the "Delivery
  policy" section above applies; that explicit-instruction exception is the only one.
- If Weeek MCP is unavailable, ask the user to paste the ticket body and continue with the git/PR
  steps only (skip the board moves).
